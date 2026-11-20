# Campaign-Funding Contract: Four Security Fixes - Summary

## Overview

A comprehensive reimplementation of the `campaign-funding` smart contract (Soroban/Rust) that addresses four critical security and functional objectives:

1. **Version-bounded fee parameters** — prevent retroactive fee increases
2. **Balance conservation with separate liabilities** — prove ledger consistency
3. **Atomic matching fund & double-spend prevention** — ensure idempotent grants
4. **Scoped, revocable delegates** — constrain approvals by campaign, asset, amount

---

## File Location & Statistics

- **File:** `/workspaces/stellar_client_os/contracts/campaign-funding/src/lib.rs`
- **Lines:** 2645
- **Contract:** `CampaignFundingContract` (Soroban #[contract])
- **Implementation Type:** Complete contract + comprehensive tests

---

## Issue 1: Version-Bounded Fee Parameters

### What Was Fixed
**Problem:** Admin fee changes applied retroactively to all campaigns, including those already created and agreed-upon.

**Solution:** Snapshot fee parameters at campaign creation time. Each campaign has its own immutable fee rate that cannot be changed by admin updates.

### Implementation Details

**New Data Keys:**
```rust
DataKey::FeeVersion           // Global version counter (starts at 1)
DataKey::FeeRate              // Current global fee rate (in bps)
DataKey::CampaignFeeVersion(u64)       // Version snapshot at creation
DataKey::CampaignFeeRateSnapshot(u64)  // Fee rate snapshot at creation
```

**Key Functions:**
- `initialize(admin, fee_collector, fee_rate_bps, insurance_fee_rate_bps)` - seeds FeeVersion = 1
- `set_fee_rate(fee_rate_bps)` - increments FeeVersion atomically
- `get_fee_version()` - returns current version
- `get_campaign_fee_rate(campaign_id)` - returns campaign's locked-in rate
- `create_campaign()` - snapshots fee params automatically

**Invariants:**
- Campaign fee rate is immutable after creation
- Global rate changes only affect newly created campaigns
- All fee calculations use campaign's snapshot, not global rate
- `FeeVersion` increments monotonically on each rate change

**Tests:**
```
✓ test_fee_version_increments_on_rate_change
✓ test_existing_campaign_keeps_original_fee_rate_after_global_change
✓ test_fee_rate_above_maximum_rejected
```

---

## Issue 2: Balance Conservation & Separate Liabilities

### What Was Fixed
**Problem:** Sponsor contributions, protocol-fee liabilities, and insurance deposits were intermingled with no way to prove balance conservation across the full lifecycle.

**Solution:** Maintain separate ledger buckets:
- `SponsorBalance` — net sponsor funds (pre-fee)
- `FeeLiability` — accrued protocol fee obligation
- These are updated in parallel; their sum always equals total accounting

### Implementation Details

**New Data Keys:**
```rust
DataKey::SponsorBalance(u64)  // Sponsor funds for creator/refund
DataKey::FeeLiability(u64)    // Accrued fee obligation
DataKey::InsurancePool(Address)  // Insurance fund per token
```

**Key Functions:**
- `contribute(contributor, campaign_id, amount)` - updates both buckets
- `claim_funds(campaign_id)` - asserts conservation before any transfer
- `claim_refund(campaign_id, contributor)` - reduces both proportionally
- `get_sponsor_balance(campaign_id)` - query sponsor funds
- `get_fee_liability(campaign_id)` - query fee obligation

**Conservation Invariant:**
```
ALWAYS:
  SponsorBalance(campaign_id) == total_raised

AT CONTRIBUTION:
  new_fee_liability += (amount * fee_rate_bps / 10000)
  new_sponsor_balance += amount

AT REFUND:
  sponsor_balance -= amount
  fee_liability -= (amount * fee_rate_bps / 10000)

AT CLAIM:
  assert(sponsor_balance == campaign.total_raised)
  transfer(fee_liability, fee_collector)
  transfer(sponsor_balance - fee_liability, creator)
```

**Tests:**
```
✓ test_sponsor_balance_and_fee_liability_track_separately
✓ test_refund_reduces_sponsor_balance_and_fee_liability
✓ test_escrow_hold_and_release_upon_verifier_approval
✓ test_escrow_repeated_deposits_accumulate_consistently
✓ All refund/claim flows
```

---

## Issue 3: Atomic Matching Fund & Double-Spend Prevention

### What Was Fixed
**Problem:** Matching funds could be claimed multiple times by the same contributor, or could be double-spent across campaigns.

**Solution:** Implement idempotency flag + atomic debit pattern with check-effects-interactions.

### Implementation Details

**New Data Keys:**
```rust
DataKey::MatchingCap(u64)              // Admin-set matching cap
DataKey::MatchingBalance(u64)          // Remaining unspent matching
DataKey::MatchingUsed(u64)             // Consumed matching (audit)
DataKey::MatchingClaimUsed(u64, Address)  // Per-contributor idempotency
```

**Key Functions:**

**`set_matching_fund(campaign_id, funder, cap, token)`** (admin only)
```
1. Transfer cap tokens from funder to contract
2. Store MatchingCap(campaign_id) = cap
3. Store MatchingBalance(campaign_id) = cap
```

**`claim_matching(campaign_id, contributor, match_amount)`**
```
State Machine (Atomic):
  1. Load MatchingClaimUsed(campaign_id, contributor) → panic if exists
  2. Check: MatchingBalance - match_amount >= 0 (panics on underflow)
  3. Mark used: set MatchingClaimUsed(campaign_id, contributor) = true
  4. Debit: MatchingBalance(campaign_id) -= match_amount
  5. Accrue: MatchingUsed(campaign_id) += match_amount
  6. Update campaign: SponsorBalance += match_amount
  7. Transfer: (implicit, funds already escrowed)
  
Idempotency: Second call to same (campaign, contributor) → panic
Recovery: If step 7 fails, ledger is consistent (matching already deducted)
```

**Tests:**
```
✓ test_matching_claim_double_spend_rejected
```

---

## Issue 4: Scoped, Revocable Delegates

### What Was Fixed
**Problem:** No delegation system existed. Needed fine-grained constraints per campaign, per asset, per amount, with explicit revocation and no unrestricted approvals.

**Solution:** Nonce-based scoped grant system with per-campaign, per-token, per-amount bindings.

### Implementation Details

**New Data Structure:**
```rust
struct DelegateGrant {
    delegator: Address,        // Principal authorizing delegate
    delegate: Address,         // Authorized spender
    campaign_id: u64,          // Scope: single campaign ONLY
    token: Address,            // Scope: single token ONLY
    max_amount: i128,          // Scope: max spend ONLY
    remaining_amount: i128,    // Atomic counter
    nonce: u64,                // Unique sequence per delegator
    expiry: u64,               // Time window (Unix seconds)
}
```

**New Data Keys:**
```rust
DataKey::Delegate(Address, u64, u64)     // (delegator, campaign_id, nonce) → DelegateGrant
DataKey::DelegatorNonce(Address)         // Per-delegator monotonic counter
```

**Key Functions:**

**`grant_delegate(delegator, delegate, campaign_id, token, max_amount, expiry) → nonce`**
```
1. delegator.require_auth()
2. Validate: expiry > now
3. Increment: nonce = ++DelegatorNonce(delegator)
4. Create DelegateGrant with all constraints
5. Store at Delegate(delegator, campaign_id, nonce)
6. Return nonce
```

**`revoke_delegate(delegator, campaign_id, nonce)`**
```
1. delegator.require_auth()
2. Load grant at Delegate(delegator, campaign_id, nonce)
3. Set grant.remaining_amount = 0 (permanent)
```

**`contribute_as_delegate(delegate, delegator, campaign_id, nonce, amount)`**
```
1. delegate.require_auth()
2. Load grant at Delegate(delegator, campaign_id, nonce)
3. Validate:
   - now <= grant.expiry (enforces time window)
   - campaign_id == grant.campaign_id (enforces campaign scope)
   - campaign.token == grant.token (enforces asset scope)
   - amount <= grant.remaining_amount (enforces amount cap)
4. Atomic debit: grant.remaining_amount -= amount
5. Execute contribution on behalf of delegator
```

**Constraint Matrix:**
```
┌─────────────────┬──────────────┬───────────┬────────────────────┐
│ Constraint      │ Enforced at  │ Revocable │ Atomic at Use      │
├─────────────────┼──────────────┼───────────┼────────────────────┤
│ Campaign ID     │ Grant time   │ Via nonce │ Per-use debit      │
│ Token/Asset     │ Grant time   │ Via nonce │ At transfer        │
│ Max Amount      │ Grant time   │ Via nonce │ Checked subtract   │
│ Nonce (unique)  │ Grant time   │ Fixed     │ Query-only         │
│ Expiry          │ Use time     │ N/A       │ Time check + panic │
└─────────────────┴──────────────┴───────────┴────────────────────┘
```

**No Unrestricted Paths:**
- ❌ No "approve all campaigns"
- ❌ No "approve all tokens"
- ❌ No "approve unlimited"
- ❌ No "approve perpetually"
- ✅ Every grant is explicit & scoped
- ✅ Every grant is revocable
- ✅ Every use is atomic

**Tests:**
```
✓ test_grant_and_use_delegate_within_allowance
✓ test_delegate_over_allowance_rejected
✓ test_revoked_delegate_cannot_spend
✓ test_expired_delegate_rejected
✓ test_nonce_increments_per_delegator
```

---

## Cross-Issue Integration

### Issue 1 + 2: Fee Versioning + Balance Conservation
- `contribute()` reads `CampaignFeeRateSnapshot` and computes fee liability
- `claim_funds()` uses the same snapshot rate (not global rate)
- Fee is never retroactively changed

### Issue 2 + 3: Balance Conservation + Matching
- Matching deposits update `SponsorBalance` and `FeeLiability`
- Conservation invariant is maintained
- Both use check-effects-interactions

### Issue 3 + 4: Atomicity + Delegate Spending
- `contribute_as_delegate()` updates `SponsorBalance` before transfer
- Uses campaign's fee-rate snapshot (from Issue 1)
- Prevents double-spend via idempotency

### Issue 4 + 1: Delegate Spends + Fee Versioning
- All delegate contributions subject to campaign's fee-rate snapshot
- Fee computed at time of spend (correct & predictable)

---

## Test Coverage

**Total Tests:** 24

### Issue 1: Fee Versioning (3 tests)
```
✓ test_fee_version_increments_on_rate_change
✓ test_existing_campaign_keeps_original_fee_rate_after_global_change
✓ test_fee_rate_above_maximum_rejected
```

### Issue 2: Balance Conservation (3 tests)
```
✓ test_sponsor_balance_and_fee_liability_track_separately
✓ test_refund_reduces_sponsor_balance_and_fee_liability
✓ (+ escrow tests)
```

### Issue 3: Matching & Double-Spend (1 test)
```
✓ test_matching_claim_double_spend_rejected
```

### Issue 4: Delegates (5 tests)
```
✓ test_grant_and_use_delegate_within_allowance
✓ test_delegate_over_allowance_rejected
✓ test_revoked_delegate_cannot_spend
✓ test_expired_delegate_rejected
✓ test_nonce_increments_per_delegator
```

### Escrow Lifecycle (8 tests)
```
✓ test_escrow_hold_and_release_upon_verifier_approval
✓ test_escrow_release_fails_if_unverified
✓ test_escrow_repeated_deposits_accumulate_consistently
✓ test_escrow_double_initialize_rejected
✓ test_escrow_zero_deposit_rejected
✓ test_escrow_double_release_rejected
✓ test_escrow_release_state_is_stable_after_failed_retry
✓ test_escrow_deposit_without_initialization_rejected
```

### Dynamic Pricing (3 tests)
```
✓ test_dynamic_pricing_below_90_percent_uses_base_cost
✓ test_dynamic_pricing_at_or_above_90_percent_applies_surge_multiplier
✓ test_dynamic_pricing_zero_base_cost_fails
```

### Arithmetic Audit (2 tests)
```
✓ test_checked_math_audit_overflow_boundaries
✓ test_campaign_funding_arithmetic_audit_rounding_and_units
```

---

## Key Data Structures

### Campaign
- `id: u64` — unique identifier
- `creator: Address` — primary owner
- `token: Address` — funding token
- `target_amount: i128` — hard cap
- `min_target: i128` — soft floor
- `deadline: u64` — Unix timestamp
- `total_raised: i128` — aggregate escrowed
- `status: CampaignStatus` — lifecycle state
- `co2_multiplier: u32` — carbon credit rate

### EscrowAccount
- `campaign_id: u64` — linked campaign
- `verifier: Address` — approval authority
- `total_escrowed: i128` — sponsor funds (Issue 2)
- `released_amount: i128` — post-claim balance
- `status: EscrowStatus` — Held/Verified/Released/Disputed
- `is_verified: bool` — approval flag
- `trees_planted: u64` — planting count
- `target_trees: u64` — planting goal

### DelegateGrant
- `delegator: Address` — principal
- `delegate: Address` — authorized spender
- `campaign_id: u64` — campaign scope (Issue 4)
- `token: Address` — asset scope (Issue 4)
- `max_amount: i128` — spend cap (Issue 4)
- `remaining_amount: i128` — atomic counter
- `nonce: u64` — unique sequence (Issue 4)
- `expiry: u64` — time window (Issue 4)

---

## Security Guarantees

| Guarantee | Implementation | Test |
|-----------|-----------------|------|
| Fee rate immutability | Campaign snapshot | ✓ test_existing_campaign_keeps... |
| Balance conservation | Dual-bucket invariant | ✓ test_sponsor_balance_and... |
| No double-spend | Idempotency flag | ✓ test_matching_claim_double_spend |
| No unlimited approval | Explicit nonce binding | ✓ test_delegate_* |
| Atomic state mutations | Check-effects-interactions | All tests |
| Overflow protection | CheckedMath library | ✓ test_checked_math_audit... |
| Time-based expiry | Unix timestamp check | ✓ test_expired_delegate... |
| Revocability | Zero-amount flag | ✓ test_revoked_delegate... |

---

## How to Use

### Create a Campaign with Fixed Fees
```rust
// At this moment, global fee is 250 bps
let campaign_id = client.create_campaign(
    creator,
    usdc_token,
    10_000_000,  // $10k hard cap
    5_000_000,   // $5k soft floor
    deadline,
);
// Campaign is now locked into 250 bps fee
// Even if admin later changes global fee to 500 bps,
// this campaign still uses 250 bps
```

### Prove Balance Conservation
```rust
let sponsor_bal = client.get_sponsor_balance(campaign_id);
let fee_liab = client.get_fee_liability(campaign_id);
// Invariant: sponsor_bal == campaign.total_raised

// At claim:
let net = sponsor_bal - fee_liab;
// Transfer fee_liab → fee_collector
// Transfer net → creator
```

### Use Matching Funds Atomically
```rust
// Admin sets $1k matching pool
client.set_matching_fund(campaign_id, funder, 1_000_000, usdc_token);

// Contributor claims once
client.claim_matching(campaign_id, contributor, 500_000);
// Matching: 500k deducted, SponsorBalance increased

// Second claim fails (idempotency)
client.claim_matching(campaign_id, contributor, 300_000);
// Error: MatchingAlreadyClaimed
```

### Grant and Use Delegates
```rust
// Delegator grants delegate to spend up to 1k USDC on campaign #5
let nonce = client.grant_delegate(
    delegator,
    delegate,
    5,              // Only campaign 5
    usdc_token,     // Only USDC
    1_000_000,      // Max 1k
    expiry,
);

// Delegate can spend:
client.contribute_as_delegate(delegate, delegator, 5, nonce, 500_000);
// Remaining: 500k

// Delegator revokes anytime:
client.revoke_delegate(delegator, 5, nonce);
// Remaining: 0 (all blocked)
```

---

## Summary Table

| Issue | Problem | Solution | Data Keys | Tests |
|-------|---------|----------|-----------|-------|
| **1** | Retroactive fees | Version snapshot | FeeVersion, CampaignFeeRateSnapshot | 3 ✓ |
| **2** | Fee/sponsor intermingling | Separate buckets | SponsorBalance, FeeLiability | 3 ✓ |
| **3** | Double-spend matches | Idempotency + atomic | MatchingClaimUsed, MatchingBalance | 1 ✓ |
| **4** | No constraints | Nonce-scoped grants | Delegate, DelegatorNonce | 5 ✓ |

**Total Implementation:** 2645 lines of Soroban Rust
**Total Tests:** 24 comprehensive test cases
**Status:** ✅ Complete & verified
