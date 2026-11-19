# Investigation Summary: Four Core Issues in Stellar Client OS

## Overview
This document identifies the current state of implementation for four critical issues affecting event tracking, capability versioning, projection persistence, and transaction state management across the Fundable Stellar SDK and web application.

---

## Issue 1: Track Contiguous Coverage Per Network with Bounded, Idempotent Replay

### Current State: **PARTIALLY IMPLEMENTED**

#### What Exists:
1. **CDC (Change Data Capture) Indexer** (`scripts/cdc-indexer.ts`):
   - Polls Soroban RPC `getEvents` endpoint on configurable intervals
   - Persists events to PostgreSQL with idempotency on `event_id` 
   - Maintains cursor in `cdc_cursors` table per indexer instance
   - Tables: `stream_events`, `cdc_cursors`, schema creation idempotent

2. **Event Pagination & Cursor Management** (`packages/sdk/src/utils/streamHistory.ts`):
   - Cursor-based pagination using `pagingToken` from RPC
   - Avoids skip/duplicate risk from `startLedger` advancement
   - `getStreamHistory()` returns `StreamHistoryResult` with cursor for continuation
   - `getAllStreamHistory()` implements multi-page fetching with safety cap

3. **Network Detection** (`packages/sdk/src/utils/networkDetection.ts`):
   - `detectNetworkPassphrase()` fetches network info from RPC
   - `detectNetworkMismatch()` compares wallet vs RPC network
   - Friendly names for testnet/mainnet/futurenet
   - Protocol version detection available

#### What's Missing:
1. **Per-Network Coverage Tracking**:
   - No table/schema tracking which ledger ranges have been indexed per network
   - No mechanism to detect gaps between indexed ledger sequences
   - `cdc_cursors` exists but lacks network discrimination—single `indexer_id` per instance
   - No way to query "what coverage do we have on testnet vs mainnet?"

2. **Bounded Replay with Authoritativeness**:
   - No "authoritative source" designation (which RPC or data snapshot is canonical?)
   - CDC indexer resumes from last cursor but no validation that ledger history is contiguous
   - No checksum/hash validation of event batches for replay verification
   - Replay logic is implicit in cursor restoration, not explicit/bounded

3. **Coverage API**:
   - No endpoint or service to report coverage status per network
   - No public interface to query "is the range [L1, L2] complete?"
   - Missing: coverage horizon, gaps, last-update timestamp per network

#### Related Files:
- `scripts/cdc-indexer.ts` (lines 1–450): core indexer logic, cursor management
- `packages/sdk/src/utils/streamHistory.ts` (lines 1–150): pagination helpers
- `packages/sdk/src/utils/networkDetection.ts` (lines 1–200): network detection
- `migrations/004_durable_campaign_state_and_webhooks.sql`: webhook/campaign state persistence (good pattern for idempotency)
- `docs/webhooks.md`: webhook event delivery model (reference for idempotent replay)

#### Suggested Fixes:
1. Extend `cdc_cursors` schema to include `network` and `ledger_range_start`/`ledger_range_end`
2. Add coverage integrity checks on startup (verify no gaps in indexed ledgers)
3. Introduce `CoverageService` with `getCoverageStatus(network: string)` returning gaps/horizon
4. Track event hash/checksum for batch replay verification

---

## Issue 2: Expose Typed Capability/Version Surface

### Current State: **PARTIALLY IMPLEMENTED**

#### What Exists:
1. **SDK Version Export** (`packages/sdk/src/index.ts`):
   - Exports `VERSION = "0.2.0"` (hardcoded string)
   - Available to consumers as `import { VERSION } from "@fundable/sdk"`

2. **Network Protocol Version Detection**:
   - `detectNetworkPassphrase()` fetches `protocolVersion` from RPC
   - Stored in `NetworkInfo` interface with `protocolVersion?: number`

3. **Event Schema Versioning** (`packages/sdk/src/utils/event-validator.ts`):
   - `EventSchemaDefinition` includes `version: number` field
   - Schema registry in `EVENT_SCHEMAS` with versioned keys like `payment-stream:StreamDeposit:v1`
   - `getEventSchema(contract, eventName, version?)` retrieves versioned schemas
   - `assertBackwardCompatibility()` enforces schema evolution rules

4. **OpenAPI Version** (`docs/openapi.yaml`):
   - `info.version: 0.1.0` defined
   - `x-api-version: 1.0.0` extension
   - Deprecation policy documented (90-day sunset window)

5. **Transaction Status Types** (`packages/sdk/src/recipes/transactions.ts`):
   - `TransactionOutcome<T>` discriminated union with `success` boolean
   - Error details include type, code, and suggestion
   - But **no version/capability checking before tx preparation**

#### What's Missing:
1. **Client Capability Declaration**:
   - No `CapabilitySet` or `ClientCapabilities` interface
   - No method to declare "this client supports X operations"
   - No way for SDK to validate "is operation Y available on this network?"
   - Missing: capability manifest or feature flags

2. **Pre-Transaction Capability Validation**:
   - `executeTransaction()` doesn't check capabilities before invocation
   - No `canExecute(operation: string): boolean` pattern
   - Clients risk submitting unsupported operations, getting errors only at RPC
   - No typed rejection path before transaction preparation

3. **Versioned Operation Support Matrix**:
   - No table mapping SDK version → supported operations
   - Missing: contract method availability by version
   - No `SupportMatrix` type or service

4. **OpenAPI Capability Section**:
   - No `/api/capabilities` or `/api/version` endpoint
   - No capability discovery in the HTTP API
   - Deprecation headers (Sunset, Deprecation) not implemented in responses

#### Related Files:
- `packages/sdk/src/index.ts` (line 1): bare VERSION export
- `packages/sdk/src/utils/event-validator.ts` (lines 1–250): event schema versioning pattern (good model)
- `packages/sdk/src/recipes/transactions.ts` (lines 1–150): transaction execution (pre-validation point)
- `packages/sdk/src/utils/networkDetection.ts` (lines 1–80): network detection with protocol version
- `docs/openapi.yaml` (lines 1–100): API versioning & deprecation policy

#### Suggested Fixes:
1. Create `ClientCapabilities` interface with supported operation flags
2. Add `CapabilityChecker` class with `canExecuteOperation(op: string, network: StellarNetwork): boolean`
3. Validate capabilities before `AssembledTransaction` is sent
4. Export `OperationSupport` type matrix for each SDK version
5. Add `/api/capabilities` endpoint returning versioned feature set
6. Implement deprecation/sunset headers in API responses

---

## Issue 3: Persist Ledger Cursors with Projections Atomically

### Current State: **PARTIALLY IMPLEMENTED**

#### What Exists:
1. **Campaign Progress Cache** (`apps/web/src/services/campaign-progress-cache.service.ts`):
   - `CampaignProgressMetrics` interface includes `cachedAt`, `expiresAt`, TTL tracking
   - `buildCampaignProgressCacheKey()` for isolated cache namespacing
   - Invalidation reasons: `mutation`, `chain-correction`, `manual`
   - `CampaignProgressInvalidationResult` tracks what was invalidated and when

2. **Webhook Idempotency & Atomic State** (`migrations/004_durable_campaign_state_and_webhooks.sql`):
   - `webhook_subscriptions` table has `idempotency_key` (nullable, unique where not null)
   - Unique partial index: `uq_webhook_subscriptions_idempotency_key`
   - Prevents duplicate subscriptions on retried requests after crash
   - Trigger `set_updated_at()` enforces monotonic timestamps
   - `updated_at` NOT NULL with default `clock_timestamp()`
   - Append-only `webhook_delivery_attempts` table with triggers preventing UPDATE/DELETE

3. **Campaign State Persistence** (`migrations/004_durable_campaign_state_and_webhooks.sql`):
   - `campaigns` table with `state` (draft|scheduled|active|paused|completed|cancelled)
   - `campaigns_state_check` constraint enforces valid states
   - Index: `idx_campaigns_state_updated_at` for listing by state + recency
   - `updated_at` monotonicity trigger prevents going backwards
   - All statements idempotent (IF NOT EXISTS)

4. **CDC Cursor Persistence** (`scripts/cdc-indexer.ts`):
   - `cdc_cursors` table tracks `last_ledger` per indexer instance
   - `setCursor()` uses UPSERT (INSERT ... ON CONFLICT ... DO UPDATE)
   - Resumption after process failure queries `getCursor()` first
   - Ledger sequence prevents duplicate event processing

5. **Event Storage** (`scripts/cdc-indexer.ts`):
   - `stream_events` table with `event_id` (UNIQUE) for idempotency
   - `insertEvents()` uses ON CONFLICT (event_id) DO NOTHING pattern
   - Tables created idempotently with IF NOT EXISTS

6. **Durable JSON File Storage** (`apps/web/src/services/event-aggregator.service.ts`):
   - `EventAggregatorService` with atomic file writes via temp file + rename
   - Handles ENOENT gracefully (returns empty array)
   - Not recommended for production but shows idempotent append pattern

#### What's Missing:
1. **Atomic Projection + Cursor Writes**:
   - Cache invalidation (`campaign-progress-cache.service.ts`) doesn't use transactions
   - No guarantee that cursor and projection are committed together
   - Possible gap: cache rebuilt but cursor not advanced, or vice versa
   - Missing: single transaction wrapping both cursor and derived state updates

2. **Multi-Ledger Projection State**:
   - No table for "projection state" (which operations have been applied, at which ledger)
   - Campaign progress cache tracks TTL/expiry, not ledger provenance
   - Missing: `projection_ledger_state` table linking projections to ledger cursors

3. **Gap Detection on Resume**:
   - CDC indexer resumes from `last_ledger` but doesn't validate no events were missed
   - No checksum/snapshot mechanism to detect gaps post-crash
   - Missing: ledger range validation (e.g., if last_ledger = 1000, check ledger 1001 is the next available)

4. **Transaction-Scoped Projection Updates**:
   - `campaign-progress-cache.service` doesn't expose transaction-aware API
   - No pattern like `updateProjectionWithCursor(tx, projection, cursor)` 
   - Cache invalidation is fire-and-forget, not transactional

#### Related Files:
- `apps/web/src/services/campaign-progress-cache.service.ts` (lines 1–150): campaign progress with TTL but no cursor binding
- `migrations/004_durable_campaign_state_and_webhooks.sql` (entire file): idempotency & atomic patterns (good reference)
- `scripts/cdc-indexer.ts` (lines 200–350): cursor persistence & event upserts
- `apps/web/src/services/event-aggregator.service.ts` (lines 1–100): atomic file write pattern (not DB, but shows intent)

#### Suggested Fixes:
1. Create `ProjectionLedgerState` table: `(projection_id, last_applied_ledger, snapshot_hash, updated_at)`
2. Wrap cursor + projection updates in explicit transactions
3. Add `resumeFromCursor()` with gap detection (compare expected vs actual next ledger)
4. Implement snapshot hash validation to detect corruption post-crash
5. Create `ProjectionService.updateWithCursor(ledgerCursor, projections)` returning atomic result

---

## Issue 4: Use Consistent Pending, Confirmed, Failed States Across API and UI

### Current State: **FRAGMENTED**

#### What Exists:
1. **Offramp/Settlement State Machine** (`apps/web/src/types/offramp.ts`):
   - `PayoutStatus = "pending" | "processing" | "confirmed" | "completed" | "failed" | "expired" | "timeout" | "delayed"`
   - `SettlementRecord` includes `status: PayoutStatus`, timestamps (`createdAt`, `updatedAt`, `completedAt`)
   - `ReconciliationResult` tracks state transitions with `previousStatus` → `currentStatus`
   - Per-provider failure categories: `SettlementFailureCategory`
   - Fine-grained UI state: `OfframpStep = "form" | "quote" | "signing" | "processing" | "completed" | "failed"`

2. **Hook-Level State Management** (`apps/web/src/hooks/`):
   - `useTransactionGuard.ts`: `MutationStatus = "idle" | "pending" | "success" | "error"`
   - `use-sync-queue.ts`: `SyncItemStatus = "pending" | "syncing" | "synced" | "failed" | "conflict"`
   - `use-sync-queue.ts`: Failure types: `"transient" | "permanent" | "stale" | "duplicate" | "conflict"`

3. **Service-Level State** (`apps/web/src/services/`):
   - `campaign-verification-queue.service.ts`: `VerificationJobStatus = "pending" | "processing" | "succeeded" | "failed"`
   - `campaign-sponsorship-receipt.service.ts`: `SponsorshipReceiptState = "issued" | "pending" | "verified" | "failed"`
   - `batch-verification.service.ts`: `BatchStatus = "pending" | "verified" | "rejected"`
   - `campaign-stretch-goals.service.ts`: `StretchGoalStatus = "pending" | "unlocked" | "expired"`

4. **History/Distribution State** (`apps/web/src/types/`):
   - `history.ts`: `DistributionStatus = "completed" | "failed" | "pending"`
   - `fraud-detection.ts`: States for verification: `'verified' | 'rejected' | 'pending'`

5. **SDK Transaction Outcome** (`packages/sdk/src/recipes/transactions.ts`):
   - `TransactionOutcome<T>` with `success: boolean` discriminator
   - Includes `hash`, `ledger`, `result` (on success) or `error` (on failure)
   - Discriminated union pattern for type safety

6. **API Versioning** (`docs/openapi.yaml`):
   - `info.version: 0.1.0` and `x-api-version: 1.0.0`
   - Deprecation policy documented (90-day sunset)
   - Rate limit headers defined

#### What's Missing:
1. **Global Unifying State Enum**:
   - No canonical `TransactionState = "pending" | "confirmed" | "failed"` enum across SDK + Web
   - Services define ad-hoc states without central registry
   - No `StateTransitionValidator` to enforce legal state transitions

2. **Ledger Finality Binding**:
   - No clear "confirmed = included in finalized ledger" definition
   - States don't track ledger sequence where confirmation occurred
   - Missing: `OnChainState` type with `ledgerNumber`, `confirmationTime`

3. **API Response Consistency**:
   - No standardized response envelope for transactional endpoints
   - State names vary: `confirmed` vs `processing`, `failed` vs `error` vs `rejected`
   - Missing: response wrapper with `state`, `ledger`, `timestamp`, `error` fields

4. **UI-to-Ledger Mapping**:
   - UI components use local state (`pending`, `syncing`, `conflict`) without ledger binding
   - No component receives `(uiState, onChainState)` pairs for decision-making
   - Missing: derived state service combining both sources

5. **Error Categorization per State**:
   - Different services categorize failures differently (`transient`, `permanent`, `duplicate` vs `quote_expired`, `bridge_timeout`)
   - No unified error taxonomy
   - Missing: `ErrorCategory` enum linked to `TransactionState`

#### Related Files:
- `apps/web/src/types/offramp.ts` (entire file): most mature state machine (good template)
- `packages/sdk/src/recipes/transactions.ts` (lines 1–80): `TransactionOutcome` (SDK pattern)
- `apps/web/src/hooks/use-sync-queue.ts` (lines 1–100): local sync state + error categories
- `apps/web/src/services/campaign-verification-queue.service.ts` (lines 1–50): service state example
- `docs/openapi.yaml` (lines 1–50): API versioning (reference for response structure)
- `migrations/004_durable_campaign_state_and_webhooks.sql` (lines 1–100): campaign state enums (good DB pattern)

#### Suggested Fixes:
1. Create `TransactionStateModel` enum: `"pending" | "confirmed" | "failed"` (canonical)
2. Define `OnChainConfirmation = { ledger: number; timestamp: string; hash: string }`
3. Create `TransactionStateView = { state: TransactionState; onChain?: OnChainConfirmation; error?: ErrorDetails }`
4. Standardize API response envelope: `{ data: T; state: TransactionState; ledger?: number; timestamp: string }`
5. Add `StateTransitionService` enforcing allowed transitions per operation type
6. Create `ErrorTaxonomy` enum with categories: `"transient" | "permanent" | "user_error" | "compliance_hold"` etc.

---

## Cross-Cutting Patterns & Recommendations

### Database Patterns (Reference)
- **Idempotency**: `ON CONFLICT (unique_key) DO NOTHING` or `DO UPDATE` ✓
- **Monotonic Timestamps**: Trigger with `GREATEST(clock_timestamp(), old_value + INTERVAL '1 microsecond')` ✓
- **Append-Only**: Triggers preventing UPDATE/DELETE ✓
- **Atomic Transactions**: Single transaction for cursor + projection (needs work)

### TypeScript Patterns (To Adopt)
- **Discriminated Unions**: `TransactionOutcome` pattern for success/error ✓
- **Event Schema Versioning**: `EventSchemaDefinition` with backward compatibility checks ✓
- **Service Locators**: `getEventSchema(contract, name, version?)` for lookups (good)
- **Capability Checking**: Missing—needs implementation

### Documentation Gaps
- No "Event Coverage" section in `docs/`
- No "Capability Declaration" guide for SDK consumers
- No "Projection Consistency" design document
- No unified "Transaction State Machine" diagram

---

## Summary Table

| Issue | Exists | Missing | Priority |
|-------|--------|---------|----------|
| **1. Coverage Tracking** | CDC indexer, cursor mgmt | Per-network tracking, coverage API, gap detection | High |
| **2. Capability/Version Surface** | SDK version, schema versioning | Client capabilities, pre-tx validation, capability API | High |
| **3. Projection + Cursor Atomicity** | Idempotent UPSERT, monotonic timestamps | Transactional cursor-projection binding, gap detection | High |
| **4. Consistent Transaction States** | Multiple local state enums | Global enum, ledger binding, unified error taxonomy | High |

---

## Files to Create/Modify

### New Files
1. `packages/sdk/src/CoverageService.ts` — Issue 1 coverage tracking API
2. `packages/sdk/src/CapabilityChecker.ts` — Issue 2 capability validation
3. `packages/sdk/src/ProjectionService.ts` — Issue 3 atomic projection updates
4. `packages/sdk/src/TransactionStateModel.ts` — Issue 4 canonical state enum
5. `migrations/007_projection_ledger_state.sql` — projection + cursor persistence
6. `migrations/008_transaction_state_audit.sql` — audit trail for state transitions
7. `docs/coverage-tracking.md` — Issue 1 architecture
8. `docs/capability-versioning.md` — Issue 2 design
9. `docs/projection-consistency.md` — Issue 3 guarantees
10. `docs/transaction-state-model.md` — Issue 4 reference

### Modified Files
- `scripts/cdc-indexer.ts` — extend schema for per-network tracking
- `packages/sdk/src/index.ts` — export new services
- `packages/sdk/src/recipes/transactions.ts` — add capability pre-checks
- `apps/web/src/app/api/` — standardize response envelopes
- `apps/web/src/types/` — consolidate state enums
- `docs/openapi.yaml` — add `/api/capabilities` endpoint

