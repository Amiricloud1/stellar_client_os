# Objective 2: Selective Pause Without Fund Redirection

## Overview

Objective 2 extends the payment-stream contract with **selective, fine-grained pause control** without allowing any party to redirect funds. The binary emergency pause is migrated to four independent operation-specific flags, enabling precise incident response while maintaining unbreakable fund integrity guarantees.

### Key Principles

1. **Granular Control**: Pause deposits, payouts, claims, or admin operations independently.
2. **No Fund Redirection**: All pause combinations prevent fund movement to unintended recipients.
3. **Backward Compatibility**: Old emergency pause automatically migrates to new selective flags.
4. **Atomic Guarantees**: Paused streams maintain perfect balance integrity; all funds remain in escrow.

---

## Architecture: State Machine

### Pause Flag Definitions

Four independent boolean flags control protocol operations:

| Flag | Scope | Blocked Operations | Unblocked Operations |
|------|-------|------------------|---------------------|
| `PausedDeposits` | Inbound funds | `create_stream`, `create_batch_streams`, `deposit`, `deposit_with_swap` | Withdrawals, cancellations, admin ops |
| `PausedPayouts` | Outbound/sender operations | `cancel_stream`, `pause_stream` (sender-level payout logic) | Deposits, withdrawals, admin ops |
| `PausedClaims` | Recipient withdrawals | `withdraw`, `withdraw_max` | Deposits, cancellations, admin ops |
| `PausedAdmin` | Administrative control | `set_operation_pause`, `set_fee_tiers`, `set_dex_router`, etc. | User-level operations |

### Pause State Transitions

```
                         Initial State
                         (all unpaused)
                              |
                    +-----------+-----------+
                    |           |           |
              Pause    Pause         Pause
            Deposits  Payouts       Claims
              |           |           |
              v           v           v
        [D]----          ----[P]      ----[C]
           |  \          /  |  \    /  |
           |   \        /   |   \  /   |
           +----+-------+---+    \/    |
           |              |      /\    |
      [DP] +-----[DP]+----+    /  \   |
           |              |   /    \ [PC]
           |              |  /      \ |
           +----+-------+--+        +--+
                |       |
           [DAP]+--[DP]+[C]
                
      Legend:
      D = PausedDeposits only
      P = PausedPayouts only
      C = PausedClaims only
      A = PausedAdmin only
      DP = PausedDeposits + PausedPayouts
      ... (combinations)
```

### Fund Redirection Veto Matrix

This matrix proves that no pause combination allows fund redirection:

| Scenario | Operation | Blocked By | Result |
|----------|-----------|-----------|--------|
| Recipient redirects to self | `withdraw` | `PausedClaims` | ✅ Blocked |
| Sender cancels to redirect | `cancel_stream` | `PausedPayouts` | ✅ Blocked |
| Sender deposits to new stream | `deposit` | `PausedDeposits` | ✅ Blocked |
| Admin transfers funds | Direct transfer | Not applicable (no such op) | ✅ N/A |
| All ops paused | Any operation | `[Deposits, Payouts, Claims]` | ✅ All blocked |

**Proof**: To redirect funds, one of these must occur:
1. Recipient claims funds → blocked by `PausedClaims`
2. Sender cancels to reclaim → blocked by `PausedPayouts`
3. Sender deposits to new stream → blocked by `PausedDeposits`
4. Admin action → blocked by `PausedAdmin`

**Conclusion**: No combination of pause flags permits fund redirection. QED.

---

## Storage Schema

### Instance Storage Keys (Ledger)

```rust
#[contracttype]
pub enum DataKey {
    // ... existing keys ...
    
    // Binary flag (legacy, auto-migrated to selective flags)
    Paused,
    
    // New selective pause flags (instance storage, TTL-extended)
    PausedDeposits,      // Pause deposit operations
    PausedPayouts,       // Pause payout/cancel operations
    PausedClaims,        // Pause claim/withdraw operations
    PausedAdmin,         // Pause admin operations
    
    // ... remaining keys ...
}
```

### Migration Semantics

When any operation is invoked on a paused contract (old binary flag set):

```
if (Paused == true) {
    // First invocation: migrate to selective flags
    PausedDeposits = true
    PausedPayouts = true
    PausedClaims = true
    PausedAdmin = false  // Admin must work to unpause
    
    // Check the relevant guard for this operation
}
```

This ensures:
- Old contracts continue to work (full pause → all flags set)
- New selective system takes over
- Admin can surgically unpause operations

---

## Guard Functions

### `assert_deposits_allowed(env: &Env)`

**Purpose**: Blocks `create_stream`, `create_batch_streams`, `deposit`, `deposit_with_swap`

```rust
fn assert_deposits_allowed(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::PausedDeposits)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::ContractPaused);
    }
}
```

**Placed in**: `create_stream_internal`, `deposit`, `deposit_with_swap`

### `assert_payouts_allowed(env: &Env)`

**Purpose**: Blocks `cancel_stream` and sender-initiated state changes

```rust
fn assert_payouts_allowed(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::PausedPayouts)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::ContractPaused);
    }
}
```

**Placed in**: `cancel_stream`

### `assert_claims_allowed(env: &Env)`

**Purpose**: Blocks `withdraw` and `withdraw_max`

```rust
fn assert_claims_allowed(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::PausedClaims)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::ContractPaused);
    }
}
```

**Placed in**: `withdraw`, `withdraw_max`

### `assert_admin_allowed(env: &Env)`

**Purpose**: Blocks admin-only operations (future use)

```rust
fn assert_admin_allowed(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::PausedAdmin)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::ContractPaused);
    }
}
```

**Placed in**: `set_operation_pause`, `set_fee_tiers`, `set_dex_router` (protected by this guard)

---

## API: Control Functions

### `set_operation_pause(env, operation: Symbol, paused: bool) → void`

**Authorization**: Admin only

**Parameters**:
- `operation`: One of `"deposits"`, `"payouts"`, `"claims"`, `"admin"`
- `paused`: `true` to pause, `false` to unpause

**Behavior**:
1. Require admin authorization
2. Map operation symbol to `DataKey` variant
3. Set flag to `paused` value
4. Extend TTL
5. Emit `OperationPauseChanged` event

**Example**:
```rust
// Pause deposits during a market shock
client.set_operation_pause(&Symbol::new(&env, "deposits"), &true);

// Later, unpause after incident investigation
client.set_operation_pause(&Symbol::new(&env, "deposits"), &false);
```

### `is_operation_paused(env, operation: Symbol) → bool`

**Authorization**: Public (read-only)

**Returns**: Current pause state of the operation

**Example**:
```rust
let deposits_paused = client.is_operation_paused(&Symbol::new(&env, "deposits"));
```

### Migration: `migrate_pause_flags(env: &Env) → void`

**Purpose**: Automatically handle old emergency pause flag

**Called**: At the start of each state-mutating operation

**Logic**:
```rust
fn migrate_pause_flags(env: &Env) {
    let old_paused: bool = env.storage().instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);

    if old_paused {
        env.storage().instance().set(&DataKey::PausedDeposits, &true);
        env.storage().instance().set(&DataKey::PausedPayouts, &true);
        env.storage().instance().set(&DataKey::PausedClaims, &true);
        // Note: PausedAdmin stays false so admin can unpause
    }
}
```

### Backward Compatibility: Emergency Pause/Unpause

**`emergency_pause()`**: Sets all three user-facing flags (deposits, payouts, claims)
```rust
pub fn emergency_pause(env: Env) {
    let admin = get_admin(&env);
    admin.require_auth();
    
    env.storage().instance().set(&DataKey::Paused, &true);
    // Migration will activate selective flags on first operation
}
```

**`emergency_unpause()`**: Clears the binary `Paused` flag
```rust
pub fn emergency_unpause(env: Env) {
    let admin = get_admin(&env);
    admin.require_auth();
    
    env.storage().instance().set(&DataKey::Paused, &false);
}
```

---

## Events

### `OperationPauseChanged`

Emitted each time `set_operation_pause` is called.

```rust
#[contractevent(topics = ["OperationPauseChanged"])]
#[derive(Clone)]
pub struct OperationPauseChangedEvent {
    pub operation: Symbol,      // "deposits" | "payouts" | "claims" | "admin"
    pub paused: bool,           // true = paused, false = unpaused
    pub admin: Address,         // Address of admin who made the change
    pub timestamp: u64,         // Ledger timestamp
}
```

**Example Event Log**:
```
[Ledger 12345] OperationPauseChanged {
  operation: "deposits",
  paused: true,
  admin: GXXXXXX...,
  timestamp: 1700000000
}

[Ledger 12347] OperationPauseChanged {
  operation: "deposits",
  paused: false,
  admin: GXXXXXX...,
  timestamp: 1700000100
}
```

Clients can subscribe to this event to:
- **Respond to incidents** (e.g., pause withdrawals, suspend new deposits)
- **Audit trail** (who paused what, when)
- **Automatic alerts** (trigger when claims pause is activated)

---

## Client Migration Guide

### Phase 1: Understand Old Emergency Pause

Old contracts use a single binary flag:
```rust
// Old: contract.emergency_pause()
// Blocks ALL operations uniformly
```

### Phase 2: Transition to Selective Pause

New contracts support granular control:
```rust
// New: Pause only deposits during a market shock
client.set_operation_pause(&Symbol::new(&env, "deposits"), &true);

// Pause only withdrawals during compliance review
client.set_operation_pause(&Symbol::new(&env, "claims"), &true);

// Pause cancellations to preserve streams
client.set_operation_pause(&Symbol::new(&env, "payouts"), &true);
```

### Phase 3: Incident Response Scenarios

**Scenario A**: Token contract vulnerability (malicious token)
```
1. Pause deposits     (prevent new exposure)
2. Allow claims      (let recipients exit)
3. Allow cancellations (let senders reclaim)
Result: Zero new tokens enter; old tokens can exit.
```

**Scenario B**: Consensus lag (network issues)
```
1. Pause all operations
2. Let network stabilize
3. Unpause operations one-by-one (deposits first, then claims)
Result: Orderly resume with safety gates.
```

**Scenario C**: Regulatory freeze (compliance event)
```
1. Pause claims      (freeze recipient access)
2. Pause cancellations (freeze sender refunds)
3. Allow deposits    (senders can add compliance-compliant funds)
Result: Funds are locked in limbo pending investigation.
```

### Phase 4: Read Pause Status

```rust
// Check if specific operation is paused
if client.is_operation_paused(&Symbol::new(&env, "deposits")) {
    println!("New deposits blocked");
}

// Or subscribe to events and react
// (See OperationPauseChanged event examples above)
```

---

## Testing Strategy

### Coverage: 16+ Tests

1. **Independent flags** (4 tests)
   - `test_pause_deposits_independently`
   - `test_pause_payouts_independently`
   - `test_pause_claims_independently`
   - `test_pause_admin_independently` (future: admin guards)

2. **Combinations** (2 tests)
   - `test_pause_multiple_operations`
   - `test_toggle_pause_flag`

3. **Backward compatibility** (2 tests)
   - `test_emergency_pause_migration`
   - `test_old_paused_flag_migration`

4. **Fund redirection veto** (5 tests)
   - `test_fund_redirection_veto_all_paused`
   - `test_fund_redirection_veto_recipient_claim`
   - `test_fund_redirection_veto_sender_cancel`
   - `test_fund_redirection_veto_sender_deposit`
   - `test_paused_stream_balance_integrity`

5. **Integration** (2 tests)
   - `test_selective_pause_with_stream_lifecycle`
   - `test_OperationPauseChanged_event` (event verification)

### Test Patterns

Each test follows this structure:
```rust
#[test]
fn test_scenario() {
    let env = Env::default();
    env.mock_all_auths();
    
    // Setup contract
    let client = setup_contract(&env);
    let stream_id = client.create_stream(...);
    
    // Apply pause(s)
    client.set_operation_pause(&Symbol::new(&env, "deposits"), &true);
    
    // Verify guards work
    assert!(client.try_operation(...).is_err());
    assert!(client.try_other_operation(...).is_ok());
    
    // Verify funds unchanged
    let stream = client.get_stream(&stream_id);
    assert_eq!(stream.balance, expected_balance);
}
```

---

## Security Properties

### Invariant 1: Balance Integrity Under Pause

**Statement**: If all operations are paused, stream balance is frozen in ledger.

**Proof**:
- Deposits blocked by `PausedDeposits` → balance cannot increase
- Claims blocked by `PausedClaims` → balance cannot decrease (recipient can't withdraw)
- Payouts blocked by `PausedPayouts` → balance cannot change (sender can't cancel)
- No admin operation can transfer funds directly

**Corollary**: Unpaused streams maintain accounting: `balance + withdrawn_amount == total_amount`

### Invariant 2: No Unintended Recipient

**Statement**: No pause combination allows funds to flow to an unintended recipient.

**Proof by exhaustion**:
1. Recipient wants their funds → `withdraw` requires `¬PausedClaims`
2. Sender wants refund → `cancel_stream` requires `¬PausedPayouts`
3. Both receive funds only if respective operations are unpaused
4. If funds are paused from reaching the original recipient, sender cannot redirect them via cancel (blocked by `PausedPayouts`)
5. If funds are paused from reaching the sender (via cancel), recipient cannot claim them (blocked by `PausedClaims`)

**Corollary**: Fund redirection is impossible. Funds either:
- Stay in escrow (when paused), or
- Go to original recipient or sender (when unpaused)

### Invariant 3: Admin Control During Crisis

**Statement**: If `PausedAdmin` is not set, admin can always unpause any operation.

**Guarantee**: At least one operator (admin with `PausedAdmin == false`) can always restore functionality.

---

## Error Codes

| Code | Scenario | Recovery |
|------|----------|----------|
| `ContractPaused` | Operation blocked by selective pause flag | Wait for admin to unpause specific operation |
| `Unauthorized` | Non-admin called `set_operation_pause` | Use admin key to call function |
| `InvalidAmount` | Invalid operation symbol in `set_operation_pause` | Use valid symbol: "deposits", "payouts", "claims", "admin" |

---

## Deployment Checklist

- [ ] Deploy new contract code with selective flags
- [ ] Initialize contract (creates all four pause flags as `false`)
- [ ] Monitor `OperationPauseChanged` events
- [ ] Document incident response procedures
- [ ] Train ops team on selective pause commands
- [ ] Set up automated alerts for pause events
- [ ] Add RPC method to query `is_operation_paused`
- [ ] Update client SDKs to support new pause API

---

## References

- **Pause State Machine**: See diagram above
- **Fund Redirection Veto**: See matrix above
- **Test Suite**: `/contracts/payment-stream/src/test.rs` (16+ tests)
- **Implementation**: `/contracts/payment-stream/src/lib.rs` (guard functions, events)

