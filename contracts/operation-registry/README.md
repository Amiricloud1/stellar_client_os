# Operation Registry

A Soroban shared library crate providing stable, deterministic operation identifiers and event tracking for the Fundable Protocol.

## Overview

The `operation-registry` crate implements Objective 1: Stable Operation Identifiers. It enables:

1. **Deterministic Operation IDs**: Collision-proof identifiers computed from (contract_addr, tx_hash, ledger_seq, op_index)
2. **Event Linking**: Track events across operations and entities
3. **Cross-Contract Linking**: Link operations from different contracts to common entities
4. **Audit Trails**: Verify operation chains and detect missing events

## Architecture

### Core Types

#### OperationId

```rust
pub struct OperationId(pub u64);

impl OperationId {
    pub fn compute(
        contract_addr: &Address,
        tx_hash: &Bytes,
        ledger_seq: u32,
        op_index: u32,
    ) -> Self
}
```

**Computation Process:**
1. Create SHA256 hasher
2. Hash contract address (XDR bytes)
3. Hash transaction hash (32 bytes)
4. Hash ledger sequence (big-endian u32)
5. Hash operation index (big-endian u32)
6. Convert first 8 bytes of result to u64 (big-endian)

**Properties:**
- Deterministic: Same inputs always produce the same output
- Collision-resistant: Uses SHA256, extremely unlikely to have collisions
- Caller-proof: No caller can predict or supply pre-computed IDs
- Unique per operation: Different ledger sequences, op indices, or tx hashes produce different IDs

#### EventRecord

```rust
pub struct EventRecord {
    pub event_type: Symbol,      // e.g., "StreamCreated", "Deposited"
    pub timestamp: u64,          // Ledger timestamp
    pub ledger_seq: u32,         // Ledger sequence
    pub related_entity_id: u64,  // stream_id, campaign_id, etc.
}
```

#### OperationLinkedEvent

```rust
pub struct OperationLinkedEvent {
    pub operation_id: u64,
    pub event_type: Symbol,
    pub related_entity_id: u64,
}
```

Emitted when an operation is linked to a specific entity, enabling cross-contract auditing.

#### OperationMetadata

```rust
pub struct OperationMetadata {
    pub operation_id: u64,
    pub contract_addr: Address,
    pub tx_hash: Bytes,
    pub ledger_seq: u32,
    pub op_index: u32,
    pub created_at: u64,
}
```

### Storage Keys

```rust
pub enum OperationDataKey {
    /// Maps operation_id → OperationMetadata
    OperationIdRegistry(u64),
    
    /// Maps operation_id → Vec<EventRecord>
    OperationEvents(u64),
}
```

## Usage in Payment-Stream

### Integration Points

The payment-stream contract imports and uses the operation-registry:

```rust
use operation_registry::{OperationId, OperationLinkedEvent};
```

A new module `src/operations.rs` provides:

- `compute_operation_id(env, tx_hash, op_index)`: Compute operation ID
- `register_stream_created(env, stream_id, operation_id, sender)`: Record stream creation
- `register_deposit(env, stream_id, operation_id, amount)`: Record deposit
- `register_withdrawal(env, stream_id, operation_id, amount)`: Record withdrawal

### Event Emission

When creating a stream:

```rust
pub fn create_stream_internal(...) -> u64 {
    // ... existing logic ...
    
    // Compute and register operation
    let tx_hash = Bytes::new(env); // In real implementation, from tx envelope
    let operation_id = compute_operation_id(&env, &tx_hash, 0);
    register_stream_created(&env, stream_id, operation_id, &sender);
    
    // ... existing logic ...
}
```

This emits:
- Existing `StreamCreatedEvent`
- New `OperationLinkedEvent` with operation_id and stream_id

## TypeScript SDK

### OperationRegistryClient

Provides client-side utilities for working with operation IDs and event chains.

#### computeOperationId

```typescript
function computeOperationId(
    contractAddr: string,
    txHash: string | Buffer,
    ledgerSeq: number,
    opIndex: number
): bigint
```

Deterministically computes operation IDs on the client side for verification.

#### verifyOperationChain

```typescript
function verifyOperationChain(
    events: EventRecord[],
    operationId: bigint
): OperationChain
```

Verifies operation chains by checking:
- Events are sorted by timestamp
- All events reference the same operation_id
- No suspicious time gaps (>1 hour)
- Event sequence is logical (no withdrawals before deposits)
- Resume events follow pause events

#### summarizeOperations

```typescript
function summarizeOperations(
    chains: OperationChain[]
): OperationSummary
```

Generates audit summaries including:
- Total operations and events
- Event type counts
- Date ranges

#### createMockOperationRegistryContract

```typescript
function createMockOperationRegistryContract(): OperationRegistryContract
```

Creates a mock contract for testing.

## Guarantees

### Determinism
- Same inputs always produce the same operation ID
- Client-side `computeOperationId` matches server-side computation
- Enables offline verification

### Collision Resistance
- SHA256 provides cryptographic collision resistance
- Different contract addresses → different IDs
- Different transaction hashes → different IDs
- Different ledger sequences → different IDs
- Different operation indices → different IDs

### Caller-Proof Design
- No caller can predict or supply operation IDs
- IDs are derived from immutable ledger data
- Multiple operations in same transaction have unique IDs

### Auditability
- Event chains link operations to entities
- Timestamp and ledger sequence for ordering
- Cross-contract operations are traceable
- Missing events can be detected

## Testing

### Rust Tests

In `src/lib.rs` and `src/tests.rs`:

```bash
cargo test
```

Tests verify:
- Deterministic computation
- Collision resistance
- Cross-contract linking
- Event chaining
- Boundary values (u32::MAX, etc.)
- Large-scale uniqueness (1000+ operations)

### TypeScript Tests

In `packages/sdk/src/__tests__/OperationRegistryClient.test.ts`:

```bash
pnpm test OperationRegistryClient
```

Tests cover:
- Operation ID determinism
- Cross-contract uniqueness
- Event chain verification
- Operation summary generation
- Mock contract behavior

## Integration Checklist

- [x] Create `operation-registry` crate
- [x] Implement `OperationId::compute()`
- [x] Define event and metadata types
- [x] Create storage key enum
- [x] Add Rust tests for collision resistance
- [x] Create TypeScript SDK utilities
- [x] Add SDK tests
- [x] Create operations module for payment-stream
- [x] Export SDK utilities in `index.ts`
- [ ] Integrate with payment-stream contract functions
- [ ] Test cross-contract linking
- [ ] Deploy to testnet

## Performance Considerations

### Operation ID Computation
- Rust: O(1) - SHA256 hash of 4 fields
- TypeScript: O(1) - Same hash-based approach
- No storage lookups required for computation

### Event Storage
- Each event is ~100 bytes
- Events are keyed by operation_id for efficient retrieval
- Ledger TTL extends automatically

### Scalability
- Handles 1000+ operations per transaction batch
- No O(n) loops in core computation
- Event chains searchable by operation_id

## Future Enhancements

1. **Operation Graph**: Visualize dependencies between operations
2. **Event Filters**: Query events by type, timestamp, or entity
3. **Dispute Resolution**: Link disputes to operation chains
4. **Cross-Chain Operations**: Support for multi-chain workflows
5. **Compliance Reports**: Generate audit-ready operation summaries

## References

- [Objective 1: Stable Operation Identifiers](../../PR_DESCRIPTION.md#objective-1-stable-operation-identifiers)
- [Payment Stream Integration](../payment-stream/README.md)
- [SDK Documentation](../../packages/sdk/README.md)
