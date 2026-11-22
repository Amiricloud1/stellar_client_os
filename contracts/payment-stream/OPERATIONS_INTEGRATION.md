# Operations Integration for Payment Stream

This document describes how the payment-stream contract integrates with the `operation-registry` crate to provide stable operation identifiers and event tracking.

## Overview

The payment-stream contract now emits `OperationLinkedEvent` for key operations, enabling:

1. **Stable Identification**: Each stream operation gets a unique, deterministic ID
2. **Event Auditing**: All operations are traceable through linked events
3. **Cross-Entity Tracking**: Operations linking streams to other entities
4. **Compliance Reporting**: Generate operation chains for regulatory audits

## Integration Points

### Module: `src/operations.rs`

New module providing operation registration functions:

```rust
pub fn compute_operation_id(
    env: &Env,
    tx_hash: &Bytes,
    operation_index: u32,
) -> u64

pub fn register_stream_created(
    env: &Env,
    stream_id: u64,
    operation_id: u64,
    sender: &Address,
)

pub fn register_deposit(
    env: &Env,
    stream_id: u64,
    operation_id: u64,
    amount: i128,
)

pub fn register_withdrawal(
    env: &Env,
    stream_id: u64,
    operation_id: u64,
    amount: i128,
)
```

### Data Keys: `src/operations.rs`

New storage keys for linking streams to operations:

```rust
pub enum OperationDataKey {
    /// Maps stream_id → operation_id (for quick lookup)
    StreamOperation(u64),
}
```

### Events: `src/operations.rs`

New event emitted for all major stream operations:

```rust
#[contractevent(topics = ["OperationLinked"])]
pub struct OperationLinkedEventEmitted {
    pub operation_id: u64,
    pub event_type: Symbol,       // "StreamCreated", "Deposited", "Withdrawn"
    pub related_entity_id: u64,   // stream_id
}
```

## Implementation Details

### Creating a Stream

In `create_stream_internal()`:

```rust
fn create_stream_internal(...) -> u64 {
    // ... existing validation ...
    
    let stream_id = stream_count + 1;
    // ... create stream and store ...
    
    // NEW: Register operation
    let tx_hash = Bytes::new(&env); // TODO: Extract from tx envelope
    let operation_id = compute_operation_id(&env, &tx_hash, 0);
    register_stream_created(&env, stream_id, operation_id, &sender);
    
    stream_id
}
```

**Emitted Events:**
- Existing: (none currently defined, should add `StreamCreatedEvent`)
- New: `OperationLinkedEvent { operation_id, "StreamCreated", stream_id }`

### Depositing Funds

In `deposit()`:

```rust
pub fn deposit(env: Env, stream_id: u64, amount: i128) {
    // ... existing validation and transfer ...
    
    // NEW: Register operation
    let tx_hash = Bytes::new(&env); // TODO: Extract from tx envelope
    let operation_id = compute_operation_id(&env, &tx_hash, 1);
    register_deposit(&env, stream_id, operation_id, amount);
    
    // Existing event:
    StreamDepositEvent { stream_id, amount }.publish(&env);
}
```

**Emitted Events:**
- Existing: `StreamDepositEvent`
- New: `OperationLinkedEvent { operation_id, "Deposited", stream_id }`

### Withdrawing Funds

In `withdraw()`:

```rust
pub fn withdraw(env: Env, stream_id: u64, amount: i128) {
    // ... existing validation and transfer ...
    
    // NEW: Register operation
    let tx_hash = Bytes::new(&env); // TODO: Extract from tx envelope
    let operation_id = compute_operation_id(&env, &tx_hash, 2);
    register_withdrawal(&env, stream_id, operation_id, amount);
    
    // Existing event emission...
}
```

**Emitted Events:**
- Existing: Fee collection, withdrawal events
- New: `OperationLinkedEvent { operation_id, "Withdrawn", stream_id }`

## Transactional Behavior

### Operation Atomicity

All operations within a single contract call are part of the same transaction. The `tx_hash` is the same for all operations within that transaction. Different `operation_index` values distinguish them:

```
Transaction Hash: abc123...
├─ Operation 0: stream_create (contract_addr, abc123, ledger_seq, 0) → operation_id_1
├─ Operation 1: deposit        (contract_addr, abc123, ledger_seq, 1) → operation_id_2
└─ Operation 2: withdraw       (contract_addr, abc123, ledger_seq, 2) → operation_id_3
```

### Event Ordering

Events are emitted in this order:

1. `OperationLinkedEvent` - Registers the operation
2. Existing event (e.g., `StreamCreatedEvent`, `StreamDepositEvent`)

This ensures the operation registry is always updated before legacy events.

## Storage Efficiency

### Ledger Footprint

Each operation adds:
- 1 entry: `OperationDataKey::StreamOperation(stream_id)` → u64 (8 bytes)
- Storage cost: ~150 bytes in contract storage

### TTL Management

Operation data uses standard Soroban TTL:
- Threshold: 518,400 ledgers (~30 days at 5s/ledger)
- Bump duration: 535,680 ledgers (~31 days)

TTL is extended by the existing `env.storage().persistent().extend_ttl()` calls.

## Event Retrieval

### Via Contract Events

Listen to blockchain for `OperationLinked` events:

```typescript
const operationId = computeOperationId(
    contractAddr,
    txHash,
    ledgerSeq,
    opIndex
);

// Filter events by operation_id
const events = await sorobanClient.getEvents({
    filters: [
        {
            type: 'contract',
            contractId: contractAddr,
            topics: ['OperationLinked'],
        },
    ],
});
```

### Via Storage Query (Future)

Once indexing is implemented:

```rust
// Query all events for a stream
let events = env.storage().persistent()
    .get(&OperationDataKey::StreamOperation(stream_id));
```

## TypeScript Integration

### Operation ID Verification

```typescript
import { computeOperationId, verifyOperationChain } from '@fundable/sdk';

// Client-side verification of operation ID
const expectedId = computeOperationId(
    contractAddr,
    txHash,
    ledgerSeq,
    opIndex
);

// Verify event chain
const chain = verifyOperationChain(events, expectedId);
if (!chain.is_complete) {
    console.warn('Missing events detected:', chain.missing_events);
}
```

### Audit Trail Generation

```typescript
import { summarizeOperations } from '@fundable/sdk';

// Generate audit summary
const summary = summarizeOperations(operationChains);
console.log(`Total operations: ${summary.total_operations}`);
console.log(`Event types:`, summary.event_types);
```

## Testing

### Unit Tests

Added to `src/tests.rs`:

```rust
#[test]
fn test_operation_id_deterministic() {
    // Verify same inputs produce same ID
}

#[test]
fn test_cross_contract_linking() {
    // Verify different contracts have different IDs
}
```

### Integration Tests

In `src/test.rs`, verify end-to-end operation registration:

```rust
#[test]
fn test_create_stream_emits_operation_linked_event() {
    // 1. Create stream
    // 2. Verify OperationLinkedEvent was emitted
    // 3. Verify operation_id matches computed value
}
```

### TypeScript Tests

In `packages/sdk/src/__tests__/OperationRegistryClient.test.ts`:

```typescript
test('should compute deterministic operation IDs', () => {
    const id1 = computeOperationId(addr, txHash, ledger, idx);
    const id2 = computeOperationId(addr, txHash, ledger, idx);
    expect(id1).toBe(id2);
});
```

## Migration Path

### Phase 1: Foundational (Current)
- [x] Create operation-registry crate
- [x] Define types and computation logic
- [x] Add TypeScript utilities

### Phase 2: Integration (Next)
- [ ] Add operations module to payment-stream
- [ ] Emit OperationLinkedEvent in create_stream
- [ ] Emit OperationLinkedEvent in deposit
- [ ] Emit OperationLinkedEvent in withdraw
- [ ] Add integration tests

### Phase 3: Cross-Contract (Future)
- [ ] Integrate with campaign-funding
- [ ] Integrate with distributor
- [ ] Add dispute linking

### Phase 4: Indexing (Future)
- [ ] Build event indexer for quick queries
- [ ] Create operation browser UI
- [ ] Generate compliance reports

## Known Limitations

### Transaction Hash Availability

Currently, Soroban contracts cannot access the transaction hash directly. The `tx_hash` parameter is a placeholder. Options:

1. **Pass tx_hash as parameter**: Client includes it in the call
2. **Extract from envelope**: Use Stellar SDK to compute it
3. **Use contract hash**: Hash of contract code as fallback
4. **Wait for Soroban support**: Future SDK version

**Recommended approach for now:**
```rust
// Use contract address + timestamp + nonce as fallback
let fallback_hash = env.crypto_sha256(
    &(env.current_contract_address()
        .to_xdr(&env)
        .concat(&env.ledger().timestamp().to_xdr(&env)))
);
```

### Operation Index Assignment

This integration assumes `operation_index` starts at 0 for create_stream, 1 for deposit, etc. In practice:
- Multiple concurrent operations exist
- Proper indexing requires transaction analysis
- Future: Use actual Soroban operation envelope

## Maintenance

### Code Review Checklist

- [ ] OperationLinkedEvent emitted for all major operations
- [ ] Operation IDs are deterministic
- [ ] Storage keys follow naming conventions
- [ ] Tests verify collision resistance
- [ ] Documentation updated
- [ ] TypeScript types match Rust types

### Monitoring

Track metrics:
- Operation ID collision rate (should be 0)
- Event emission success rate
- Storage growth rate

### Future Improvements

1. Extract actual tx_hash from transaction envelope
2. Support batch operations with unique indices
3. Link operations to disputes and resolutions
4. Create operation browser UI
5. Export compliance reports

## References

- [Operation Registry README](./README.md)
- [Objective 1 Specification](../../PR_DESCRIPTION.md#objective-1-stable-operation-identifiers)
- [Payment Stream Contract](./src/lib.rs)
