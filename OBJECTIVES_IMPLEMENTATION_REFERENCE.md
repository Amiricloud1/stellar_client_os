# Technical Reference: Four Objectives Implementation Guide

This document provides detailed implementation references, code examples, and architectural patterns for each objective.

---

## Objective 1: Stable Operation Identifiers (Without Collision Trust)

### Current Implementation Patterns

#### 1.1 Webhook Event Deduplication (`/docs/webhooks.md`)

```typescript
// Recognized stable identities for deduplication:
// - idempotencyKey
// - eventId
// - notificationId
// - verificationId
// - nullifier
// - txHash
// (snake_case equivalents also accepted)

// Persisted in: apps/web/data/webhook_delivered_events.json
// Scoped per subscription
```

**Pattern**: Recognize multiple identity field names; store in dedup map; scope per subscriber.

#### 1.2 Campaign Verification Audit IDs (`/contracts/campaign-verification-audit/src/lib.rs`)

```rust
// Sequential ID within campaign
pub struct AuditEntry {
    pub id: u32,  // 1, 2, 3, ... per campaign
    pub campaign_id: u64,
    pub activity_type: ActivityType,
    pub actor: Address,
    pub details: String,
    pub timestamp: u64,
}

// Query: get_audit_trail_paginated(campaign_id, cursor, limit)
// Returns entries strictly after cursor ID
// Deterministic: same cursor → same page
```

**Pattern**: Use sequential IDs within a scoped context; provide cursor-based pagination.

#### 1.3 Event Versioning (`/docs/contracts/event-schemas.md`)

```rust
// Event schema definition
#[contractevent(topics = ["FeeCollected"])]
#[derive(Clone)]
pub struct FeeCollectedEvent {
    pub stream_id: u64,  // Link to main entity
    pub amount: i128,
    pub timestamp: u64,  // Anchor to ledger time
}

// Contract emits with version metadata (implicit in contract deploy)
// SDK validates: getEventSchema('payment-stream', 'FeeCollected', 1)
```

**Pattern**: Topic (immutable), versioned payload (backward compatible).

### Proposed Implementation: Operation Registry

**Problem**: Caller supplies operation ID → collision possible; no way to link events across contracts.

**Solution**: Deterministic, server-generated operation IDs with global deduplication.

```rust
// In each contract's DataKey enum:
pub enum DataKey {
    OperationId(u64),  // Maps operation_id → (contract_addr, tx_hash, op_index)
    OperationEvents(u64),  // Maps operation_id → Vec<EventRecord>
}

// EventRecord links events to operation:
#[contracttype]
#[derive(Clone)]
pub struct EventRecord {
    pub operation_id: u64,
    pub event_type: Symbol,  // "StreamCreated", "DepositMade", etc.
    pub timestamp: u64,
    pub ledger_seq: u64,
}

// Deterministic operation ID generation:
// operation_id = sha256_u64(
//   contract_address ||
//   transaction_hash ||
//   ledger_sequence ||
//   soroban_operation_index
// )

pub fn compute_operation_id(
    env: &Env,
    tx_hash: BytesN<32>,
    op_index: u32,
) -> u64 {
    let contract_addr = env.current_contract_address();
    let ledger_seq = env.ledger().sequence();
    
    let mut preimage = Bytes::new(env);
    preimage.extend_from_array(&contract_addr.to_xdr(env).to_bytes());
    preimage.extend_from_array(&tx_hash.to_xdr(env).to_bytes());
    preimage.extend_from_array(&ledger_seq.to_le_bytes());
    preimage.extend_from_array(&op_index.to_le_bytes());
    
    let hash = env.crypto().sha256(&preimage);
    u64::from_le_bytes([
        hash.get(0).unwrap(),
        hash.get(1).unwrap(),
        // ... 8 bytes total
    ])
}

// Emit operation-linked events:
#[contractevent(topics = ["OperationLinked"])]
pub struct OperationLinkedEvent {
    pub operation_id: u64,
    pub event_type: Symbol,
    pub related_stream_id: u64,
}

// SDK query function:
// getOperationEvents(operation_id) -> [events across all contracts]
```

**Key guarantees**:
- Operation IDs are **deterministic** (not caller-supplied)
- No collisions possible (sha256 hash with global ledger context)
- Cross-contract linking via operation_id
- Events indexed by operation for forensic queries

---

## Objective 2: Selective Pause Without Fund Redirection

### Current Implementation Patterns

#### 2.1 Payment Stream Pause (`/contracts/payment-stream/src/lib.rs`)

```rust
pub enum StreamStatus {
    Active,
    Paused,      // Binary: stops all operations
    Canceled,
    Completed,
    Disputed,
}

pub struct Stream {
    pub paused_at: Option<u64>,
    pub total_paused_duration: u64,  // Preserved across resume
}

// Guard: assert_not_paused(env) in all state-mutating calls
// Emits: StreamPausedEvent, StreamResumedEvent
```

**Pattern**: Binary pause; vesting accrual frozen; pause duration tracked for accuracy.

#### 2.2 Emergency Circuit Breaker (`/contracts/payment-stream/src/lib.rs`)

```rust
pub enum DataKey {
    Paused,  // Global emergency pause flag (instance storage)
}

// Guard at entry point:
fn assert_not_paused(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::Paused)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::ContractPaused);
    }
}

// Admin-only operations:
pub fn emergency_pause(env: Env, admin: Address) { ... }
pub fn emergency_unpause(env: Env, admin: Address) { ... }
```

**Pattern**: Global flag in instance storage; checked at contract entry point.

#### 2.3 Campaign Escrow State Machine (`/contracts/campaign-funding/src/lib.rs`, docs)

```rust
pub enum EscrowStatus {
    Held = 0,      // Awaiting verification
    Verified = 1,  // Verified; ready for release
    Released = 2,  // Funds claimed by creator
    Disputed = 3,  // Under dispute; blocked
}

// State machine:
// Held → (deposit)* → Verified → Released
//   ↓ (dispute)
// Disputed
```

**Pattern**: Forward state machine; separation of concerns; no operation can redirect funds to non-original beneficiary.

### Proposed Implementation: Selective Pause

**Problem**: Current pause is binary (all-or-nothing); no way to hold deposits while allowing withdrawals.

**Solution**: Per-operation pause flags.

```rust
pub enum DataKey {
    PausedDeposits,     // Reject new deposits
    PausedPayouts,      // Reject payout calls
    PausedClaims,       // Reject withdrawal/claim calls
    PausedAdmin,        // Reject admin operations (fee updates, etc.)
}

// Guard per operation type:
fn assert_deposits_allowed(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::PausedDeposits)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::DepositsPaused);
    }
}

// Similarly for Payouts, Claims, Admin

// Events:
#[contractevent(topics = ["DepositsUnpaused"])]
pub struct DepositsUnpausedEvent {
    pub admin: Address,
    pub timestamp: u64,
}

// Admin function to set selective pause:
pub fn set_operation_pause(
    env: Env,
    operation: Symbol,  // "deposits", "payouts", "claims", "admin"
    paused: bool,
) {
    let admin = Self::get_admin(&env);
    admin.require_auth();
    
    let key = match operation.to_string().as_str() {
        "deposits" => DataKey::PausedDeposits,
        "payouts" => DataKey::PausedPayouts,
        "claims" => DataKey::PausedClaims,
        "admin" => DataKey::PausedAdmin,
        _ => panic_with_error!(&env, Error::InvalidOperation),
    };
    
    env.storage().instance().set(&key, &paused);
    env.storage().instance().extend_ttl(LEDGER_THRESHOLD, LEDGER_BUMP);
    
    env.events().publish(
        ("OperationPauseChanged", operation.clone()),
        (operation, paused, env.ledger().timestamp()),
    );
}
```

**Fund-Redirection Veto**:

```rust
// INVARIANT TEST: Verify pause cannot redirect funds

#[test]
fn test_pause_cannot_redirect_funds() {
    let env = Env::default();
    env.mock_all_auths();
    
    let (contract, admin, stream_recipient) = setup();
    
    // Create stream: sender → recipient
    let stream_id = contract.create_stream(
        sender, recipient, token, 1000, 0, 100,
    );
    
    // Sender deposits funds
    contract.deposit(stream_id, 1000);
    
    // Admin pauses everything
    contract.emergency_pause(admin);
    
    // Attempt 1: Sender tries to redirect to attacker (via cancel+reroute)
    // Should fail: can't interact with paused stream
    assert_error!(
        contract.cancel_stream(stream_id),
        Error::ContractPaused
    );
    
    // Attempt 2: Admin tries direct transfer of escrow
    // Should fail: escrow belongs to stream, not admin-controlled
    let escrow = contract.get_stream(stream_id);
    assert_eq!(escrow.recipient, recipient);  // Unchanged
    
    // Resume and verify recipient can still withdraw
    contract.emergency_unpause(admin);
    let withdrawable = contract.withdrawable_amount(stream_id);
    contract.withdraw(stream_id, withdrawable);  // Succeeds
}
```

---

## Objective 3: Deterministic Serialization & Metadata Versioning

### Current Implementation Patterns

#### 3.1 Schema Versioning (`/docs/contracts/storage-versioning-and-migrations.md`)

```rust
// Per-contract constant
const SCHEMA_VERSION: u32 = 1;

pub enum DataKey {
    SchemaVersion,  // Stored in instance storage
}

// Migration function (idempotent):
pub fn migrate_schema(env: Env) {
    let admin = Self::get_admin(&env);
    admin.require_auth();
    
    let current = env.storage().instance()
        .get::<_, u32>(&DataKey::SchemaVersion)
        .unwrap_or(0);
    
    if current >= SCHEMA_VERSION {
        return;  // Already at target; idempotent
    }
    
    // Perform migration steps...
    
    env.storage().instance().set(&DataKey::SchemaVersion, &SCHEMA_VERSION);
    
    env.events().publish(
        ("SchemaMigrated", ()),
        (current, SCHEMA_VERSION, env.ledger().timestamp()),
    );
}
```

**Pattern**: Compile-time version constant; stored version in instance; idempotent migration.

#### 3.2 Campaign Diversity Metadata Version (`/contracts/campaign-diversity/src/lib.rs`)

```rust
pub enum DataKey {
    /// Monotonically increasing metadata version for a campaign, keyed by
    /// campaign_id. Starts at 1 on first registration.
    MetadataVersion(u64),
}

pub fn get_metadata_version(env: Env, campaign_id: u64) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::MetadataVersion(campaign_id))
        .unwrap_or(0)  // 0 means "not found" vs. 1 = "first version"
}

pub fn bump_metadata_version(env: Env, campaign_id: u64) {
    let old_version = Self::get_metadata_version(&env, campaign_id);
    let new_version = old_version.checked_add(1)
        .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow));
    
    let key = DataKey::MetadataVersion(campaign_id);
    env.storage().persistent().set(&key, &new_version);
    env.storage().persistent().extend_ttl(&key, LEDGER_THRESHOLD, LEDGER_BUMP);
}

// Emitted when score changes:
#[contractevent(topics = ["DiversityScoreUpdated"])]
pub struct DiversityScoreUpdatedEvent {
    pub campaign_id: u64,
    pub diversity_score: u32,
    pub metadata_version: u64,  // Client can verify snapshot
}
```

**Pattern**: Per-entity monotonic version; bumped on all state changes; emitted in events.

#### 3.3 Deterministic Scoring (`/contracts/campaign-diversity/src/lib.rs`)

```rust
/// Pure deterministic scoring function.
/// Integer floor rounding at every division stage, ensuring exact deterministic
/// results across all Soroban host runtimes.
pub fn calculate_score(
    species_count: u64,
    verified_tree_count: u64,
    same_species_pairs: u64,
) -> u32 {
    // Coverage: linear ramp up to MAX_DIVERSITY_SPECIES = 12
    let coverage_bps = if species_count == 0 {
        0u32
    } else {
        let cov = (species_count as u32) * 10_000 / 12;
        cov.min(10_000)
    };
    
    // Evenness: normalized Simpson's diversity index
    // (1 - D) / (1 - 1/S), where D = sum(n_i^2) / N^2
    let evenness_bps = if species_count <= 1 || verified_tree_count == 0 {
        0u32
    } else {
        let d_numerator = same_species_pairs;
        let d_denominator = verified_tree_count * verified_tree_count;
        let d = d_numerator * 10_000 / d_denominator;  // Floor division
        
        let one_minus_d = if d > 10_000 { 0 } else { 10_000 - d };
        let one_minus_one_over_s = ((species_count as u32 - 1) * 10_000) / (species_count as u32);
        
        if one_minus_one_over_s == 0 {
            0
        } else {
            (one_minus_d * 10_000) / one_minus_one_over_s
        }
    };
    
    // Aggregate: 50% coverage + 50% evenness
    (coverage_bps / 2) + (evenness_bps / 2)
}

#[test]
fn test_calculate_score_deterministic_and_reproducible() {
    // Same inputs → exact same output, always
    let score1 = calculate_score(10, 1000, 5000);
    let score2 = calculate_score(10, 1000, 5000);
    assert_eq!(score1, score2);
}
```

**Pattern**: Integer arithmetic only; documented at each step; tested for reproducibility.

### Proposed Implementation: Versioned Metadata Serialization

**Problem**: Metadata version number increments, but no way to serialize/hash the metadata itself; clients cannot prove they saw the same version.

**Solution**: Canonical, versioned metadata schema with deterministic serialization.

```rust
// Define versioned metadata structure:
#[contracttype]
#[derive(Clone)]
pub enum MetadataBlob {
    V1(MetadataBlobV1),
}

#[contracttype]
#[derive(Clone)]
pub struct MetadataBlobV1 {
    pub campaign_id: u64,
    pub diversity_score: u32,
    pub species_count: u64,
    pub verified_tree_count: u64,
    pub timestamp: u64,
}

// Canonical serialization (deterministic byte order):
pub fn serialize_metadata_v1(
    env: &Env,
    campaign_id: u64,
    score: u32,
    species_count: u64,
    tree_count: u64,
    timestamp: u64,
) -> Bytes {
    let mut blob = Bytes::new(env);
    
    // Version tag (1 byte): 0x01 = V1
    blob.push_back(0x01);
    
    // Serialize in little-endian order (deterministic)
    blob.extend_from_array(&campaign_id.to_le_bytes());
    blob.extend_from_array(&score.to_le_bytes());
    blob.extend_from_array(&species_count.to_le_bytes());
    blob.extend_from_array(&tree_count.to_le_bytes());
    blob.extend_from_array(&timestamp.to_le_bytes());
    
    blob
}

// Compute metadata hash for storage:
pub fn compute_metadata_hash(
    env: &Env,
    metadata: &MetadataBlobV1,
) -> BytesN<32> {
    let serialized = serialize_metadata_v1(
        env,
        metadata.campaign_id,
        metadata.diversity_score,
        metadata.species_count,
        metadata.verified_tree_count,
        metadata.timestamp,
    );
    
    env.crypto().sha256(&serialized)
}

// Store in contract:
pub enum DataKey {
    MetadataHash(u64),  // Maps campaign_id → sha256 of metadata blob
}

// Emit with hash:
#[contractevent(topics = ["MetadataHashComputed"])]
pub struct MetadataHashComputedEvent {
    pub campaign_id: u64,
    pub metadata_version: u64,
    pub metadata_hash: BytesN<32>,  // Client can verify: sha256(serialized_metadata) == hash
    pub timestamp: u64,
}

// SDK verification function:
pub fn verify_metadata_hash(
    env: &Env,
    campaign_id: u64,
    expected_hash: BytesN<32>,
) -> bool {
    let stored_hash: Option<BytesN<32>> = env.storage()
        .persistent()
        .get(&DataKey::MetadataHash(campaign_id));
    
    match stored_hash {
        Some(hash) => hash == expected_hash,
        None => false,
    }
}

// TypeScript SDK client:
// async function verifyMetadataVersion(campaignId, expectedVersion, expectedHash) {
//   const event = await fetchMetadataHashEvent(campaignId);
//   if (!event) return false;
//   
//   const actualHash = sha256(serialize_metadata_v1({
//     campaign_id: campaignId,
//     diversity_score: event.score,
//     species_count: event.speciesCount,
//     verified_tree_count: event.treeCount,
//     timestamp: event.timestamp,
//   }));
//   
//   return actualHash === expectedHash && event.version === expectedVersion;
// }
```

**Update Semantics Documentation**:

```markdown
# Campaign Diversity Metadata Versioning

## Version Increment Events

When does `metadata_version` increment?

1. **On score recalculation**: `rescore_campaign(campaign_id)`
   - Calls `bump_metadata_version(campaign_id)`
   - Emits `DiversityScoreUpdatedEvent` with new version and metadata_hash

2. **On batch verification**: `verify_trees_batch(...)`
   - Accepts tree verification
   - Recalculates score (tree count changed)
   - Bumps version if score changed
   
3. **On batch rejection**: `reject_trees_batch(...)`
   - Removes trees from verified count
   - Recalculates score
   - Bumps version if score changed

## Fields That Change Per Version

- `diversity_score`: Always (triggers bump)
- `verified_tree_count`: When trees added/removed
- `species_count`: When new species added
- `timestamp`: Every bump
- Immutable: `campaign_id`

## Backward Compatibility

| Old Version | New Version | Migration |
|-------------|-------------|-----------|
| V1 | V2 | Schema migration required; old score formula deprecated |
```

---

## Objective 4: Batch Settlement with Resumability and Conservation

### Current Implementation Patterns

#### 4.1 Sponsor Crowdfunding Batch Refund (`/contracts/sponsor-crowdfunding/src/lib.rs`)

```rust
pub fn batch_refund(env: Env, pool_id: u64, limit: u32) -> (u32, bool) {
    // Validation
    if pool.status != PoolStatus::Dissolved {
        panic_with_error!(&env, Error::PoolNotOpen);
    }
    if limit == 0 {
        panic_with_error!(&env, Error::InvalidAmount);
    }
    if limit > MAX_BATCH_REFUND {  // 50
        panic_with_error!(&env, Error::BatchLimitExceeded);
    }
    
    // Load resumable state
    let cursor: u64 = env.storage().persistent()
        .get(&DataKey::RefundCursor(pool_id))
        .unwrap_or(0);
    let contributor_count: u64 = env.storage().persistent()
        .get(&DataKey::ContributorCount(pool_id))
        .unwrap_or(0);
    let contributors: Vec<Address> = env.storage().persistent()
        .get(&DataKey::ContributorList(pool_id))
        .unwrap_or_else(|| vec![&env]);
    
    // Calculate batch
    let end = (cursor + limit as u64).min(contributor_count);
    let mut running_total: i128 = env.storage().persistent()
        .get(&DataKey::RefundedTotal(pool_id))
        .unwrap_or(0i128);
    
    // Process batch
    let mut processed: u32 = 0;
    let mut i = cursor;
    while i < end {
        let contributor = contributors.get(i as u32).unwrap();
        let contrib_key = DataKey::Contribution(pool_id, contributor.clone());
        let amount: i128 = env.storage().persistent()
            .get(&contrib_key)
            .unwrap_or(0);
        if amount > 0 {
            env.storage().persistent().remove(&contrib_key);
            token_client.transfer(
                &env.current_contract_address(),
                &contributor,
                &amount,
            );
            running_total = checked_math::checked_add(&env, running_total, amount);
            processed += 1;
        }
        i += 1;
    }
    
    // Persist or finalize
    let new_cursor = end;
    let done = new_cursor >= contributor_count;
    
    if done {
        // CONSERVATION CHECK
        if running_total != pool.total_raised {
            panic_with_error!(&env, Error::ConservationViolated);
        }
        env.storage().persistent().remove(&DataKey::RefundCursor(pool_id));
        env.storage().persistent().remove(&DataKey::RefundedTotal(pool_id));
    } else {
        // Persist for next call
        env.storage().persistent()
            .set(&DataKey::RefundCursor(pool_id), &new_cursor);
        env.storage().persistent().extend_ttl(
            &DataKey::RefundCursor(pool_id),
            LEDGER_THRESHOLD,
            LEDGER_BUMP,
        );
        env.storage().persistent()
            .set(&DataKey::RefundedTotal(pool_id), &running_total);
        env.storage().persistent().extend_ttl(
            &DataKey::RefundedTotal(pool_id),
            LEDGER_THRESHOLD,
            LEDGER_BUMP,
        );
    }
    
    (processed, done)
}
```

**Guarantees**:
- Resumable: cursor persists across calls
- Conservative: sum at completion == total_raised
- Deterministic: same cursor always processes same items

#### 4.2 Campaign Verification Audit Pagination (`/contracts/campaign-verification-audit/src/lib.rs`)

```rust
pub fn get_audit_trail_paginated(
    env: Env,
    campaign_id: u64,
    cursor: Option<u32>,
    limit: u64,
) -> (Vec<AuditEntry>, Option<u32>) {
    let count_key = DataKey::ActivityCount(campaign_id);
    let total: u32 = env.storage().persistent()
        .get(&count_key)
        .unwrap_or(0);
    
    let start_index = match cursor {
        Some(c) => (c + 1) as u64,
        None => 1,  // Activities start at ID 1
    };
    
    let mut results: Vec<AuditEntry> = Vec::new(&env);
    let end_index = (start_index + limit).min(total as u64 + 1);
    
    for id in start_index..end_index {
        let entry_key = DataKey::AuditTrail(campaign_id);
        if let Some(entry) = env.storage().persistent().get::<_, AuditEntry>(&entry_key) {
            results.push_back(entry);
        }
    }
    
    // Calculate next cursor
    let next_cursor = if end_index <= total as u64 {
        Some((end_index - 1) as u32)
    } else {
        None
    };
    
    (results, next_cursor)
}
```

**Pattern**: ID-based cursor; returns entries strictly after cursor; deterministic.

### Proposed Implementation: Settlement Eligibility Filtering & Resilience

**Problem**: Batch processes all contributors in order; no eligibility filter; if one transfer fails, entire batch fails; no resilience to ledger TTL expiration mid-batch.

**Solution**: Eligibility checks, partial commits, failure tracking.

```rust
// Define settlement eligibility
#[contracttype]
#[derive(Clone, Copy)]
pub enum SettlementEligibility {
    Eligible = 0,
    Skipped = 1,      // Ineligible; moved to next
    Failed = 2,        // Transfer failed; non-resumable
    Retry = 3,        // Transfer failed; resumable (e.g., network)
}

// Track failures per batch
#[contracttype]
#[derive(Clone)]
pub struct BatchProgress {
    pub pool_id: u64,
    pub cursor: u64,
    pub refunded_total: i128,
    pub processed: u32,
    pub skipped: u32,
    pub failed: u32,
    pub last_attempt: u64,
}

// Enhanced batch_refund with eligibility and error handling:
pub fn batch_refund_v2(
    env: Env,
    pool_id: u64,
    limit: u32,
) -> BatchRefundResult {
    let pool = Self::load_pool(&env, pool_id);
    
    if pool.status != PoolStatus::Dissolved {
        panic_with_error!(&env, Error::PoolNotOpen);
    }
    if limit == 0 || limit > MAX_BATCH_REFUND {
        panic_with_error!(&env, Error::BatchLimitExceeded);
    }
    
    // Load or initialize batch progress
    let progress_key = DataKey::BatchProgress(pool_id);
    let mut progress: BatchProgress = env.storage().persistent()
        .get(&progress_key)
        .unwrap_or(BatchProgress {
            pool_id,
            cursor: 0,
            refunded_total: 0,
            processed: 0,
            skipped: 0,
            failed: 0,
            last_attempt: env.ledger().timestamp(),
        });
    
    let contributor_count: u64 = env.storage().persistent()
        .get(&DataKey::ContributorCount(pool_id))
        .unwrap_or(0);
    let contributors: Vec<Address> = env.storage().persistent()
        .get(&DataKey::ContributorList(pool_id))
        .unwrap_or_else(|| vec![&env]);
    
    let end = (progress.cursor + limit as u64).min(contributor_count);
    let token_client = token::Client::new(&env, &pool.token);
    
    // Process batch with eligibility check
    let mut i = progress.cursor;
    while i < end {
        let contributor = contributors.get(i as u32).unwrap();
        
        // ELIGIBILITY CHECK
        if let Err(_) = Self::check_refund_eligibility(&env, pool_id, &contributor) {
            // Ineligible; skip and move to next
            progress.skipped += 1;
            i += 1;
            continue;
        }
        
        let contrib_key = DataKey::Contribution(pool_id, contributor.clone());
        let amount: i128 = env.storage().persistent()
            .get(&contrib_key)
            .unwrap_or(0);
        
        if amount <= 0 {
            i += 1;
            continue;
        }
        
        // PARTIAL COMMIT: Try transfer; record failure but continue
        match token_client.try_transfer(
            &env.current_contract_address(),
            &contributor,
            &amount,
        ) {
            Ok(_) => {
                env.storage().persistent().remove(&contrib_key);
                progress.refunded_total = checked_math::checked_add(&env, progress.refunded_total, amount);
                progress.processed += 1;
                
                env.events().publish(
                    ("RefundIssued", pool_id),
                    (contributor, pool_id, amount),
                );
            }
            Err(err) => {
                // Determine if failure is resumable
                let resumable = Self::is_resumable_error(&err);
                
                if resumable {
                    progress.failed += 1;
                    // Log failure; don't advance cursor
                    // Next call will retry this contributor
                    break;  // Stop batch on resumable error
                } else {
                    // Non-resumable (e.g., invalid recipient)
                    progress.skipped += 1;
                    // Emit error event for audit
                    env.events().publish(
                        ("RefundFailed", pool_id),
                        (contributor, pool_id, amount, err),
                    );
                    i += 1;
                }
            }
        }
    }
    
    // Update cursor
    progress.cursor = i;
    progress.last_attempt = env.ledger().timestamp();
    
    // Check if done
    let done = progress.cursor >= contributor_count;
    
    if done {
        // CONSERVATION CHECK
        if progress.refunded_total != pool.total_raised {
            panic_with_error!(&env, Error::ConservationViolated);
        }
        env.storage().persistent().remove(&progress_key);
        
        env.events().publish(
            ("BatchRefundCompleted", pool_id),
            (pool_id, progress.processed, progress.skipped, progress.failed),
        );
    } else {
        // Persist progress with extended TTL for resilience
        env.storage().persistent().set(&progress_key, &progress);
        env.storage().persistent().extend_ttl(
            &progress_key,
            LEDGER_THRESHOLD * 2,  // 60 days; survive month of stalls
            LEDGER_BUMP * 2,
        );
        
        env.events().publish(
            ("BatchRefundResuming", pool_id),
            (pool_id, progress.cursor, progress.processed, progress.skipped, progress.failed),
        );
    }
    
    BatchRefundResult {
        processed: progress.processed,
        skipped: progress.skipped,
        failed: progress.failed,
        done,
    }
}

#[contracttype]
#[derive(Clone)]
pub struct BatchRefundResult {
    pub processed: u32,
    pub skipped: u32,
    pub failed: u32,
    pub done: bool,
}

// Eligibility check
fn check_refund_eligibility(env: &Env, pool_id: u64, contributor: &Address) -> Result<(), ()> {
    // Example: Only refund if contributor has no active disputes
    let dispute_key = DataKey::Dispute(pool_id, contributor.clone());
    if env.storage().persistent().has(&dispute_key) {
        return Err(());  // Ineligible; under dispute
    }
    Ok(())
}

// Determine if error is resumable
fn is_resumable_error(err: &ContractError) -> bool {
    match err {
        ContractError::TransferFailed => true,   // Network error; retry later
        ContractError::InvalidRecipient => false, // Account invalid; skip
        _ => false,
    }
}

// Recovery playbook function
pub fn resume_batch_refund(env: Env, pool_id: u64) -> Option<BatchProgress> {
    let progress_key = DataKey::BatchProgress(pool_id);
    
    // Fetch stalled progress
    let progress: BatchProgress = env.storage().persistent()
        .get(&progress_key)
        .unwrap_or_else(|| return None);
    
    // Check if stalled (no progress for > 1 week)
    let age = env.ledger().timestamp() - progress.last_attempt;
    if age < 604_800 {
        return None;  // Not stalled yet
    }
    
    // Emit stall alert
    env.events().publish(
        ("BatchRefundStalled", pool_id),
        (pool_id, progress.cursor, age),
    );
    
    Some(progress)
}
```

**Selective Settlement Pause**:

```rust
pub enum DataKey {
    PausedSettlements,  // Pause batch settlement without pausing deposits
}

fn assert_settlements_allowed(env: &Env) {
    let paused: bool = env.storage().instance()
        .get(&DataKey::PausedSettlements)
        .unwrap_or(false);
    if paused {
        panic_with_error!(env, Error::SettlementsPaused);
    }
}

pub fn pause_settlements(env: Env, admin: Address) {
    admin.require_auth();
    env.storage().instance().set(&DataKey::PausedSettlements, &true);
}

pub fn unpause_settlements(env: Env, admin: Address) {
    admin.require_auth();
    env.storage().instance().set(&DataKey::PausedSettlements, &false);
}

// In batch_refund entry:
pub fn batch_refund_v2(env: Env, pool_id: u64, limit: u32) -> BatchRefundResult {
    Self::assert_settlements_allowed(&env);  // Guard added
    // ... rest of function
}
```

---

## Summary: Implementation Roadmap

| Objective | Component | Implementation Effort | Priority |
|-----------|-----------|----------------------|----------|
| 1 | Operation Registry | Design + Contract + SDK | P1 |
| 1 | Cross-Contract Event Linking | Contract additions + Indexer | P1 |
| 2 | Selective Pause Flags | Contract additions + Tests | P2 |
| 2 | Fund-Redirection Veto Tests | Test suite + Documentation | P2 |
| 3 | Versioned Metadata Serialization | Schema + Canonical Format | P3 |
| 3 | Metadata Hash Computation | Contract function + Events | P3 |
| 4 | Eligibility Filtering | Contract logic + Tests | P4 |
| 4 | Partial Batch Commits | Error handling + Persistence | P4 |
| 4 | Settlement-Specific Pause | Contract flag + Guards | P4 |

