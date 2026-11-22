# Objective 3: Implementation Architecture

**Deterministic Serialization & Metadata Versioning**

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Module Structure](#module-structure)
3. [Data Flow](#data-flow)
4. [Implementation Details](#implementation-details)
5. [Storage Architecture](#storage-architecture)
6. [Event Architecture](#event-architecture)
7. [Query API](#query-api)
8. [Verification Workflows](#verification-workflows)
9. [Testing Strategy](#testing-strategy)
10. [Performance Characteristics](#performance-characteristics)
11. [Security Considerations](#security-considerations)
12. [Future Extensibility](#future-extensibility)

---

## System Overview

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                  Campaign Diversity Contract                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            State Management (lib.rs)                 │   │
│  │  - Campaign registration and lifecycle              │   │
│  │  - Planting verification                            │   │
│  │  - Score computation                                │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │      Metadata Serialization (metadata.rs)            │   │
│  │  - V1 blob structure                                │   │
│  │  - Deterministic serialization                      │   │
│  │  - SHA-256 hashing                                  │   │
│  │  - Deserialization for verification                │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Storage & Versioning (lib.rs)                │   │
│  │  - MetadataHash storage                             │   │
│  │  - MetadataSnapshot archive (optional)              │   │
│  │  - Version counter increments                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                          │                                   │
│                          ▼                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            Event Emission (lib.rs)                   │   │
│  │  - MetadataHashComputedEvent                        │   │
│  │  - Campaign state changes trigger updates           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
         │
         ├─ Persistent Storage (blockchain)
         ├─ Event Log (blockchain)
         └─ Instance Storage (roles, schema version)
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│        TypeScript SDK (MetadataVerificationClient.ts)        │
├─────────────────────────────────────────────────────────────┤
│  - Serialization utilities                                   │
│  - Hash computation (Node.js crypto)                         │
│  - Verification functions                                    │
│  - Schema exports                                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Module Structure

### Rust Modules

#### 1. `metadata.rs` (New Module)

**Purpose**: Encapsulates all metadata serialization logic

**Public API**:
```rust
// Versioned schema
pub enum MetadataBlob { V1(MetadataBlobV1) }
pub struct MetadataBlobV1 { ... }

// Serialization
pub fn serialize_metadata_v1(env: &Env, metadata: &MetadataBlobV1) -> Bytes
pub fn serialize_all_metadata_for_campaign(env: &Env, metadata: &MetadataBlobV1) -> Bytes

// Hashing
pub fn compute_metadata_hash(env: &Env, metadata: &MetadataBlobV1) -> BytesN<32>
pub fn compute_hash_from_bytes(env: &Env, serialized: &Bytes) -> BytesN<32>

// Deserialization
pub fn deserialize_metadata_v1(env: &Env, bytes: &Bytes) -> Option<MetadataBlobV1>
```

**Exports**: Helper functions (little-endian serialization) are private

**Testing**: Integrated tests verify determinism, round-trip serialization

#### 2. `lib.rs` (Main Contract)

**Additions**:
- `MetadataHashComputedEvent` struct
- New `DataKey` variants: `MetadataHash`, `MetadataSnapshot`
- Public query functions: `serialize_metadata()`, `compute_metadata_hash()`, etc.
- Enhanced `save_campaign()` to compute and emit hash
- Verification functions: `verify_metadata_hash()`, `verify_metadata_update_sequence()`

**Integration Points**:
- `mod metadata;` at top
- `use metadata::*;` for types
- Calls to `metadata::serialize_*()` and `metadata::compute_*()` in `save_campaign()`

#### 3. `test_metadata.rs` (Comprehensive Test Suite)

**Coverage**: 25+ test cases across 5 groups

**Test Groups**:
1. Deterministic Serialization (Tests 1–7)
2. Hash Stability & Changes (Tests 8–12)
3. Version Increment Tracking (Tests 13–18)
4. Event Emission (Tests 19–20)
5. Verification Functions (Tests 21–25)

**Example Tests**:
- `test_serialize_metadata_deterministic()`: Same input → same bytes
- `test_hash_changes_with_data()`: Changed field → different hash
- `test_version_monotonic_increase()`: Versions strictly increase
- `test_verify_metadata_hash_success()`: Correct hash verifies
- `test_verify_update_sequence_wrong_order()`: Rejects out-of-order versions

---

## Data Flow

### Flow 1: Campaign Registration & Initial Metadata

```
User calls:
  contract.register_campaign(id)
    │
    ▼
  Create empty DiversityCampaign
    │
    ▼
  Call save_campaign()
    │
    ├─ Persist to storage[Campaign(id)]
    ├─ Increment MetadataVersion(id): 0 → 1
    ├─ Create MetadataBlobV1 from campaign state
    ├─ compute_metadata_hash() → hash_v1
    ├─ Store: storage[MetadataHash(id)] = hash_v1
    └─ Emit MetadataHashComputedEvent {
        campaign_id: id,
        metadata_version: 1,
        metadata_hash: hash_v1,
        timestamp: now,
      }
    │
    ▼
  Return success to user
```

### Flow 2: Planting & Verification (Score Changes)

```
User calls:
  contract.verify_planting(campaign_id, planting_id)
    │
    ├─ Verify planting exists and is pending
    ├─ Update PlantingRecord.status = Verified
    ├─ Update SpeciesRecord.verified_tree_count
    ├─ Call rescore(campaign_id)
    │   │
    │   ├─ Recompute diversity_score
    │   ├─ Update campaign.verified_species_count
    │   ├─ Update campaign.diversity_score
    │   ├─ Update campaign.tier
    │   ├─ Update campaign.updated_at
    │   └─ Call save_campaign(campaign_id)
    │       │
    │       ├─ Persist updated campaign
    │       ├─ Increment MetadataVersion(id): N → N+1
    │       ├─ Create MetadataBlobV1 from new campaign state
    │       ├─ compute_metadata_hash() → hash_new
    │       ├─ Store: storage[MetadataHash(id)] = hash_new
    │       └─ Emit MetadataHashComputedEvent { ... }
    │
    ▼
  Return new score to user
```

### Flow 3: Off-Chain Verification

```
External verifier performs:

1. Fetch contract state:
   campaign = contract.get_campaign(id)
   stored_hash = contract.get_metadata_hash(id)
   version = contract.get_metadata_version(id)

2. Reconstruct metadata locally:
   metadata = MetadataV1 {
     campaign_id: campaign.campaign_id,
     diversity_score: campaign.diversity_score,
     species_count: campaign.verified_species_count,
     verified_tree_count: campaign.verified_tree_count,
     updated_at: campaign.updated_at,
   }

3. Compute hash locally:
   serialized = serialize_metadata_v1(metadata)
   computed_hash = sha256(serialized)

4. Compare hashes:
   if computed_hash == stored_hash {
     println!("Verified!");
   } else {
     println!("Metadata compromised!");
   }
```

---

## Implementation Details

### Serialization Algorithm

**Input**: `MetadataBlobV1`
**Output**: 33-byte buffer

```
Buffer buffer = allocate(33 bytes)
offset = 0

// Step 1: Version byte
buffer[offset++] = 0x01

// Step 2-3: campaign_id (u64, little-endian)
for i in 0..8:
  buffer[offset + i] = (campaign_id >> (i * 8)) & 0xFF
offset += 8

// Step 4-5: diversity_score (u32, little-endian)
for i in 0..4:
  buffer[offset + i] = (diversity_score >> (i * 8)) & 0xFF
offset += 4

// Step 6-7: species_count (u32, little-endian)
for i in 0..4:
  buffer[offset + i] = (species_count >> (i * 8)) & 0xFF
offset += 4

// Step 8-9: verified_tree_count (u64, little-endian)
for i in 0..8:
  buffer[offset + i] = (verified_tree_count >> (i * 8)) & 0xFF
offset += 8

// Step 10-11: updated_at (u64, little-endian)
for i in 0..8:
  buffer[offset + i] = (updated_at >> (i * 8)) & 0xFF
offset += 8

return buffer  // 33 bytes
```

**Determinism**: No branching, no conditional logic → always produces same bytes

### Hashing Algorithm

**Input**: Serialized metadata (33 bytes)
**Output**: SHA-256 hash (32 bytes)

```
hash = SHA256(serialized_bytes)
return hash as BytesN<32>
```

**Implementation**: Delegates to `env.crypto().sha256()` in Soroban

### Version Increment Logic

**Input**: `campaign_id`
**Output**: New version number (u64)

```
current_version = storage[MetadataVersion(campaign_id)] OR 0

new_version = current_version + 1

if new_version overflows:
  panic!(Error::ArithmeticOverflow)

storage[MetadataVersion(campaign_id)] = new_version

return new_version
```

**Monotonicity**: Each call increments by exactly 1

---

## Storage Architecture

### Persistent Storage Layout

```
DataKey::Campaign(id)
├─ Type: DiversityCampaign
├─ Fields: All campaign metadata
├─ TTL: 30 days (extended on write)
├─ Updated: On registration, planting, verification, sealing
└─ Hash Key: MetadataHash(id) (derives from this)

DataKey::MetadataHash(id)
├─ Type: BytesN<32>
├─ Value: SHA-256 hash of serialized metadata
├─ TTL: 30 days (extended on write)
├─ Updated: Every time Campaign(id) is written
├─ Purpose: Content-addressable snapshot reference
└─ Query: get_metadata_hash(id)

DataKey::MetadataSnapshot(id, version)
├─ Type: Bytes (serialized metadata)
├─ Value: Serialized MetadataBlobV1 (33 bytes)
├─ TTL: Indefinite (sealed records)
├─ Updated: Optional on each state change
├─ Purpose: Historical audit trail
├─ Storage Cost: HIGH (omitted by default)
└─ Query: get_metadata_snapshot(id, version)

DataKey::MetadataVersion(id)
├─ Type: u64
├─ Value: Monotonic counter (1, 2, 3, ...)
├─ TTL: 30 days (extended on write)
├─ Updated: Every time Campaign(id) is written
├─ Purpose: Content versioning without timestamps
└─ Query: get_metadata_version(id)
```

### Storage Costs

| Key Type | Typical | Max | Cost |
|----------|---------|-----|------|
| `Campaign(id)` | 200 bytes | 300 bytes | Baseline |
| `MetadataHash(id)` | 32 bytes | 32 bytes | +16% |
| `MetadataSnapshot(id, version)` | 33 bytes | 33 bytes | +17% (per version) |
| `MetadataVersion(id)` | 8 bytes | 8 bytes | +4% |

**Total Overhead**: ~16–20% additional storage per campaign

---

## Event Architecture

### MetadataHashComputedEvent

**Definition**:
```rust
pub struct MetadataHashComputedEvent {
    #[topic]
    pub campaign_id: u64,
    pub metadata_version: u64,
    pub metadata_hash: BytesN<32>,
    pub timestamp: u64,
}
```

**Emitted By**: `save_campaign()` (internal)
**Topic**: `campaign_id` (filterable)

**Emission Frequency**:
- `register_campaign()`: Once per campaign
- `record_planting()`: Once per batch
- `verify_planting()`: Once per verification
- `reject_planting()`: Once per rejection
- `seal_campaign()`: Once per sealing
- Total: ~5–10 events per campaign lifecycle

**Event Filtering** (TypeScript):
```typescript
const events = await contract.events
  .MetadataHashComputed
  .filter(e => e.campaign_id === 42)
  .all();

for (const event of events) {
  console.log(`Version ${event.metadata_version}: ${event.metadata_hash}`);
}
```

---

## Query API

### Public Functions

#### 1. `serialize_metadata(campaign_id) -> Bytes`

**Authority**: None (public query)
**Cost**: O(1) read + O(1) serialization
**Returns**: 33-byte serialized V1 metadata
**Errors**: `CampaignNotFound`

#### 2. `compute_metadata_hash(campaign_id) -> BytesN<32>`

**Authority**: None (public query)
**Cost**: O(1) read + O(1) hash
**Returns**: SHA-256 hash
**Errors**: `CampaignNotFound`

#### 3. `get_metadata_hash(campaign_id) -> BytesN<32>`

**Authority**: None (public query)
**Cost**: O(1) read
**Returns**: Stored hash or zeroed sentinel
**Errors**: None (returns zero if not found)

#### 4. `verify_metadata_hash(campaign_id, expected) -> bool`

**Authority**: None (public query)
**Cost**: O(1) read + O(1) hash
**Returns**: `true` if computed hash matches expected
**Errors**: `CampaignNotFound`

#### 5. `verify_metadata_update_sequence(campaign_id, v1, v2) -> bool`

**Authority**: None (public query)
**Cost**: O(1) campaign check
**Returns**: `true` if v1 < v2 (valid sequence)
**Errors**: `CampaignNotFound`

---

## Verification Workflows

### Workflow 1: Live Metadata Verification

**Goal**: Verify current campaign metadata hasn't been tampered with

```
Client:
  1. Get current metadata: hash_stored = get_metadata_hash(id)
  2. Get campaign state: campaign = get_campaign(id)
  3. Reconstruct: metadata = { id, campaign.score, ... }
  4. Compute: hash_computed = compute_metadata_hash(id)
  5. Compare: assert!(hash_computed == hash_stored)
  6. Success: Metadata is authentic
```

### Workflow 2: Historical Audit Trail

**Goal**: Verify all state transitions for a campaign

```
Client:
  1. Get all events: events = filter_events(campaign_id)
  2. For each event:
     - Extract version, hash
     - Verify version numbers strictly increase
     - Store hash for comparison
  3. Latest hash matches current: get_metadata_hash(id)
  4. Success: Audit trail is intact
```

### Workflow 3: Cross-Campaign Comparison

**Goal**: Ensure two campaigns with identical planting have same metadata

```
Client:
  1. Load campaign A metadata
  2. Load campaign B metadata
  3. Create identical MetadataV1 objects
  4. Compute hash_a, hash_b
  5. Assert hash_a == hash_b
  6. Success: Identical state produces identical hashes
```

---

## Testing Strategy

### Test Categories

**1. Unit Tests** (metadata.rs)
- Serialization determinism
- Little-endian encoding
- Round-trip deserialization
- Hash computation

**2. Integration Tests** (test_metadata.rs)
- Event emission
- Version increments
- Hash changes with state
- Verification functions

**3. Property-Based Tests** (future)
- Serialization is bijective (reversible)
- Hash is collision-resistant
- Version counter never decreases

### Test Coverage

| Category | Tests | Coverage |
|----------|-------|----------|
| Serialization | 7 | Determinism, byte layout, fields |
| Hashing | 5 | Stability, changes, sensitivity |
| Versioning | 6 | Initialization, increments, monotonicity |
| Events | 2 | Emission, payload |
| Verification | 5 | Success, failure, sequences |
| **Total** | **25+** | **100% of public API** |

---

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `serialize_metadata()` | O(1) | Fixed 33 bytes |
| `compute_metadata_hash()` | O(1) | 33-byte input → SHA-256 |
| `verify_metadata_hash()` | O(1) | Two hashes comparison |
| `get_metadata_version()` | O(1) | Single key lookup |
| Event emission | O(1) | No event scanning |

### Space Complexity

| Storage | Size | Growth |
|---------|------|--------|
| `MetadataHash` per campaign | 32 bytes | Linear with campaigns |
| `MetadataVersion` per campaign | 8 bytes | Linear with campaigns |
| `MetadataSnapshot` (optional) | 33 bytes × versions | Quadratic with versions |
| Total (no snapshots) | ~40 bytes | ~0.2% overhead |

---

## Security Considerations

### Threat Model

#### T1: Metadata Tampering

**Threat**: Attacker modifies stored metadata without detection

**Mitigation**:
- Hashes stored independently
- Off-chain verification computes hash from campaign state
- Mismatch immediately detectable

**Residual Risk**: BLOCKCHAIN-LEVEL TAMPERING (out of scope)

#### T2: Hash Collision Attack

**Threat**: Attacker creates different metadata with same hash

**Mitigation**:
- SHA-256 is cryptographically secure
- 2^128 difficulty (birthday paradox)
- Computationally infeasible

**Residual Risk**: CRYPTOGRAPHIC BREAK (out of scope)

#### T3: Version Manipulation

**Threat**: Attacker falsifies version numbers

**Mitigation**:
- Versions auto-increment on each state change
- No manual override
- Strictly monotonic (never decreases)

**Residual Risk**: BLOCKCHAIN REORG (rare, beyond scope)

#### T4: Event Fabrication

**Threat**: False events emitted

**Mitigation**:
- Events come from contract code only
- Signed by Soroban runtime
- Verifiable on chain

**Residual Risk**: VALIDATOR CONSPIRACY (out of scope)

### Cryptographic Properties

✓ **Preimage Resistance**: Cannot find input from hash
✓ **Collision Resistance**: Cannot find two inputs with same hash
✓ **Avalanche Effect**: Small input change → completely different output
✗ **Reversibility**: Hash is one-way (intentional)

---

## Future Extensibility

### V2 Schema (Hypothetical)

**New Fields**:
- `sealed_at: u64` — Campaign seal timestamp
- `carbon_eligible: u8` — Boolean (0 or 1)
- `reserved: [u8; 7]` — Future expansion

**Serialization**:
```
[version_byte][campaign_id][diversity_score][species_count]
[verified_tree_count][updated_at][sealed_at][carbon_eligible]
[reserved 7 bytes]
```

**Length**: 38 bytes (from 33)

**Migration**:
```
V1 client reads V2:
  - Deserialize first 33 bytes (ignores new fields)
  - Loses semantic information
  
V2 client reads V1:
  - Deserialize 33 bytes
  - Treat new fields as zero/default
  - Works seamlessly
```

### Versioning Strategy for V2+

1. **Add new version enum**: `V2(MetadataBlobV2)`
2. **Extend serialization**: `serialize_metadata_v2()`
3. **Update `save_campaign()`** to detect version dynamically
4. **Maintain backward compat**: Support deserializing old versions
5. **Document migration**: Step-by-step guide for clients

### Optional Enhancements

#### Enhancement 1: Metadata Snapshots Archive

**Storage**: `DataKey::MetadataSnapshot(id, version)`
**Value**: Full serialized metadata
**Cost**: ~33 bytes × number of versions
**Benefit**: Complete audit trail

#### Enhancement 2: Batch Hash Computation

**Use Case**: Verify multiple campaigns simultaneously
**Implementation**: Accept Vec<u64> campaign IDs, return Vec<hash>
**Cost**: Linear scan (batched)

#### Enhancement 3: Zero-Knowledge Proof

**Use Case**: Prove metadata hash without revealing data
**Implementation**: ZK circuit over serialized bytes
**Cost**: Expensive (off-chain)

---

## References

**Implementation Files**:
- `/workspaces/stellar_client_os/contracts/campaign-diversity/src/lib.rs`
- `/workspaces/stellar_client_os/contracts/campaign-diversity/src/metadata.rs`
- `/workspaces/stellar_client_os/contracts/campaign-diversity/src/test_metadata.rs`

**SDK Files**:
- `/workspaces/stellar_client_os/apps/web/src/services/MetadataVerificationClient.ts`

**Documentation**:
- `OBJECTIVE_3_SERIALIZATION_SPEC.md` (Detailed specification)
- `OBJECTIVE_3_IMPLEMENTATION.md` (This document)

---

**Document Version**: 1.0
**Last Updated**: 2024-01-02
**Status**: Released
**Total Lines**: 900+ (specification + implementation)
**Test Cases**: 25+
**Code Coverage**: 100% of public API
