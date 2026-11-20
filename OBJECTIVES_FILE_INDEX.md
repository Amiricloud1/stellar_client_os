# File Index: Four Objectives Reference Materials

This document provides a complete index of all relevant source files, tests, and documentation for the four strategic objectives.

---

## Objective 1: Stable Operation Identifiers

### Contract Source Files
- **Payment Stream** (`/contracts/payment-stream/src/lib.rs`)
  - Lines: Event definitions (topics, struct definitions)
  - Key types: `FeeCollectedEvent`, `StreamDepositEvent`, etc.
  - Function: `initialize()` stores admin and contract state

- **Campaign Verification Audit** (`/contracts/campaign-verification-audit/src/lib.rs`)
  - Lines: Sequential audit entry ID tracking
  - Key type: `AuditEntry { id: u32, campaign_id: u64, ... }`
  - Function: `get_audit_trail_paginated()` for ID-based pagination

- **Distributor** (`/contracts/distributor/src/lib.rs`)
  - Function: `get_distribution_history(start_id, limit)` for event history retrieval

### Documentation Files
- **Event Schemas** (`/docs/contracts/event-schemas.md`)
  - Sections: "Event Versioning & Compatibility Policy", "Core Contract Event Specifications"
  - Covers: Semantic versioning, backward compatibility, SDK validation

- **Webhooks** (`/docs/webhooks.md`)
  - Sections: "Idempotent Event Delivery", "Event Types"
  - Covers: Stable identities (verificationId, batchId, completionId, eventId)
  - File storage: `apps/web/data/webhook_delivered_events.json`

- **Campaign Sponsorship Receipts** (`/docs/campaign-sponsorship-receipts.md`)
  - Topic: Transaction hash as stable identity for receipts

### Test Files
- **Payment Stream Tests** (`/contracts/payment-stream/src/test.rs`)
  - Tests: Event emission and metadata capture

- **Campaign Verification Audit Tests** (`/contracts/campaign-verification-audit/src/test.rs`)
  - Test: `test_get_audit_trail_paginated_boundaries_and_cursors()`
  - Verifies: Deterministic cursor pagination

---

## Objective 2: Selective Pause Without Fund Redirection

### Contract Source Files
- **Payment Stream** (`/contracts/payment-stream/src/lib.rs`)
  - Lines: ~250–350 (initialization and admin functions)
  - Enums: `StreamStatus { Active, Paused, Canceled, Completed, Disputed }`
  - Structs: `Stream { paused_at: Option<u64>, total_paused_duration: u64 }`
  - Functions:
    - `pause_stream(stream_id)` — sender-only
    - `resume_stream(stream_id)` — sender-only
    - `emergency_pause()` / `emergency_unpause()` — admin-only global
    - `assert_not_paused(env)` — guard function
  - Events: `StreamPausedEvent`, `StreamResumedEvent`, `EmergencyPausedEvent`, `EmergencyUnpausedEvent`

- **Campaign Funding** (`/contracts/campaign-funding/src/lib.rs`)
  - Lines: Escrow state machine
  - Enums: `EscrowStatus { Held, Verified, Released, Disputed }`
  - Structs: `EscrowAccount { status: EscrowStatus, ... }`
  - Forward-only state transitions

- **Sponsor Crowdfunding** (`/contracts/sponsor-crowdfunding/src/lib.rs`)
  - Enums: `PoolStatus { Open, Settled, Dissolved }`
  - Functions: `settle_pool()`, `payout_funds()`, `dissolve_pool()`
  - Separation: Revenue calculation vs. fund distribution

### Documentation Files
- **Privileged Roles & Authorization** (`/docs/contracts/privileged-roles-and-authorization.md`)
  - Sections: "Role Hierarchy & Expectations", "Contract Privileged Method Inventory"
  - Lists: Admin-only, creator-only, verifier-only operations
  - Key insight: No role can redirect funds to non-original beneficiary

- **Campaign Funding** (`/docs/contracts/campaign-funding.md`)
  - Sections: "Escrow state transitions", "Admin matching funds"
  - Shows: Separation of sponsor refund flow from matched funds

- **Storage Versioning & Migrations** (`/docs/contracts/storage-versioning-and-migrations.md`)
  - Topic: Admin-only migration functions

### Test Files
- **Payment Stream Tests** (`/contracts/payment-stream/src/test.rs`)
  - Tests:
    - `test_pause_and_resume_stream()`
    - `test_pausing_stops_token_vesting()`
    - `test_only_sender_can_pause()`
    - `test_only_sender_can_resume()`
    - `test_withdrawable_amount_zero_for_paused_streams()`
    - `test_operations_resume_after_unpause()`

- **Campaign Funding Tests** (`/contracts/campaign-funding/src/test.rs` if exists)
  - Tests for escrow state transitions

---

## Objective 3: Deterministic Serialization & Metadata Versioning

### Contract Source Files
- **Campaign Diversity** (`/contracts/campaign-diversity/src/lib.rs`)
  - Lines: Metadata versioning and scoring logic
  - Enums: `DataKey::MetadataVersion(u64)` (per-campaign monotonic version)
  - Functions:
    - `get_metadata_version(campaign_id) -> u64`
    - `bump_metadata_version(campaign_id)` — increments and persists
    - `calculate_score(...)` — pure deterministic scoring, integer arithmetic only
  - Events: `DiversityScoreUpdatedEvent { metadata_version, ... }`
  - Test: `test_calculate_score_deterministic_and_reproducible()`

- **Payment Stream** (`/contracts/payment-stream/src/lib.rs`)
  - Lines: Protocol metrics tracking
  - Structs: `ProtocolMetrics { total_active_streams, total_tokens_streamed, ... }`
  - Storage: Instance-level metrics

### Documentation Files
- **Storage Versioning & Migrations** (`/docs/contracts/storage-versioning-and-migrations.md`)
  - Sections: "Overview & Standard", "Upgrade Proxy Authorization & Recovery"
  - Key concept: `SCHEMA_VERSION: u32` constant and instance storage marker
  - Guarantees: Idempotent migrations, explicit version markers, auditable events
  - Function pattern: `migrate_schema()` emits `SchemaMigrated` event

- **Campaign Diversity Scoring** (mentioned in `/docs/contracts/storage-versioning-and-migrations.md`)
  - Section: "Deterministic Campaign Diversity Scoring"
  - Details: Inputs, normalization (coverage + evenness), rounding policy, auditability

- **Event Schemas** (`/docs/contracts/event-schemas.md`)
  - Sections: "Event Versioning & Compatibility Policy"
  - Topic: Backward-compatible field additions, payload immutability per version

### Test Files
- **Campaign Diversity Tests** (`/contracts/campaign-diversity/src/lib.rs`, test section if embedded)
  - Test: `test_calculate_score_deterministic_and_reproducible()`

---

## Objective 4: Batch Settlement with Resumability & Conservation

### Contract Source Files
- **Sponsor Crowdfunding** (`/contracts/sponsor-crowdfunding/src/lib.rs`)
  - Lines: ~400–550 (batch_refund implementation)
  - Enums: `DataKey::RefundCursor(u64)`, `DataKey::RefundedTotal(u64)`
  - Constants: `MAX_BATCH_REFUND = 50`
  - Function: `batch_refund(pool_id, limit) -> (processed_count, done)`
  - Guarantees:
    - Resumable cursor in persistent storage
    - Running total accumulation
    - Conservation check: `running_total == pool.total_raised` at completion
    - Deterministic: same cursor → same items processed
  - Error: `ConservationViolated` if sum doesn't match
  - Events: Emitted per refund

- **Campaign Verification Audit** (`/contracts/campaign-verification-audit/src/lib.rs`)
  - Lines: Pagination function
  - Function: `get_audit_trail_paginated(campaign_id, cursor, limit) -> (Vec<AuditEntry>, next_cursor)`
  - Type: `cursor: Option<u32>` — ID-based cursor
  - Behavior: Returns entries *strictly after* cursor; deterministic

- **Distributor** (`/contracts/distributor/src/lib.rs`)
  - Function: `get_distribution_history(start_id, limit) -> Vec<DistributionHistory>`

### Documentation Files
- **Offramp Settlement Trust Boundaries** (`/docs/offramp-settlement-trust-boundaries.md`)
  - Sections: "Settlement State Machine", "Idempotency & Duplicate Callback Handling", "Delayed Settlement & Reconciliation"
  - Patterns:
    - State machine: pending → confirmed → processing → delayed / completed / failed / expired
    - Deduplication: Track `callbackId`; replay rejection
    - Terminal immutability: Once in `completed`, ignore late callbacks
    - Delayed reconciliation: `> 5 minutes` → operator review

### Test Files
- **Sponsor Crowdfunding Tests** (`/contracts/sponsor-crowdfunding/src/lib.rs`, test section)
  - Test: `test_batch_refund_resumable()`
  - Verifies: Cursor persistence, partial completion, resumability

---

## Cross-Cutting Reference Materials

### Architecture & Overview
- **Architecture** (`/docs/architecture.md`)
  - Lists all contracts and their roles

- **Campaign Contract Architecture** (`/CAMPAIGN_CONTRACT_ARCHITECTURE.md`)
  - If present; provides high-level design

### API & Integration
- **API Reference** (`/docs/api-reference.md`)
  - REST endpoints for queries

- **SDK Integration Guide** (`/packages/sdk/DEVELOPMENT_GUIDE.md`)
  - Instructions for SDK client implementations

### Security & Audit
- **Contract Security Remediation** (`/docs/audits/contract-security-remediation.md`)
  - Links to security issues and fixes

- **Privileged Action Audit** (`/docs/privileged-action-audit.md`)
  - Inventory of privileged operations

- **Soroban Best Practices Audit** (`/docs/audits/soroban-best-practices-audit.md`)
  - Best practices and gaps

### Deployment & Operations
- **Mainnet Deployment Checklist** (`/docs/mainnet-deployment-checklist.md`)
  - Pre-deployment verification steps

- **Health Checks & Probes** (`/docs/health-checks-and-probes.md`)
  - Monitoring and resilience patterns

---

## Quick Navigation by Objective

### For Objective 1 (Operation Identifiers):
1. Start: `/docs/webhooks.md` (stable event identities)
2. Read: `/docs/contracts/event-schemas.md` (event versioning)
3. Code: `/contracts/campaign-verification-audit/src/lib.rs` (audit trails)
4. Test: `/contracts/campaign-verification-audit/src/test.rs` (pagination tests)

### For Objective 2 (Pause Separation):
1. Start: `/docs/contracts/privileged-roles-and-authorization.md` (roles matrix)
2. Read: `/docs/contracts/campaign-funding.md` (state transitions)
3. Code: `/contracts/payment-stream/src/lib.rs` (pause/resume logic)
4. Test: `/contracts/payment-stream/src/test.rs` (pause tests)

### For Objective 3 (Deterministic Serialization):
1. Start: `/docs/contracts/storage-versioning-and-migrations.md` (schema versioning)
2. Read: `/docs/contracts/event-schemas.md` (event versioning)
3. Code: `/contracts/campaign-diversity/src/lib.rs` (metadata versioning + deterministic scoring)
4. Test: Within `/contracts/campaign-diversity/src/lib.rs` (determinism tests)

### For Objective 4 (Batch Settlement):
1. Start: `/docs/offramp-settlement-trust-boundaries.md` (settlement state machine)
2. Read: Look for resumability patterns
3. Code: `/contracts/sponsor-crowdfunding/src/lib.rs` (batch_refund function)
4. Test: Within `/contracts/sponsor-crowdfunding/src/lib.rs` (batch resumability tests)

---

## File Count Summary

| Category | Count | Notes |
|----------|-------|-------|
| Rust Contract Files | 23 | Across /contracts directory (excluding target/) |
| Documentation Files | 60+ | Across /docs, /docs/contracts, /docs/audits, /docs/runbooks |
| Test Files | Embedded | Within contract .rs files (cfg(test) sections) |
| TypeScript/SDK | Multiple | /packages/sdk/src/* |

---

## Search Commands for Quick Reference

```bash
# Find all pause-related code
grep -r "pause\|Pause" /contracts --include="*.rs" | grep -v target

# Find event definitions
grep -r "contractevent\|Event" /contracts --include="*.rs" | grep -v target

# Find batch/pagination code
grep -r "batch\|cursor\|pagination" /contracts --include="*.rs" | grep -v target

# Find versioning code
grep -r "version\|Version" /contracts --include="*.rs" | grep -v target | grep -v "protocol_version"

# Find state machine patterns
grep -r "enum.*Status\|pub enum.*State" /contracts --include="*.rs" | grep -v target
```

