# Stellar Client OS: Four Key Issues Analysis

## Executive Summary

This document analyzes the Stellar Client OS repository to identify and locate the implementation status of four critical issues:
1. **Stable compound cursors** for event deduplication
2. **Failed event retention with replay** under permissions
3. **Draft persistence with offline confirmation**
4. **Projection comparison and audit** with drift detection

---

## OBJECTIVE 1: Stable Compound Cursors

### Objective Summary
Use stable compound cursors combining `timestamp`, `transaction hash`, and `event index` to avoid duplication or reordering for events with equal timestamps and concurrent ingestion.

### Current Implementation Status

#### ✅ IMPLEMENTED (Partial)

**Location: `/workspaces/stellar_client_os/scripts/cdc-indexer.ts`**

The CDC (Change Data Capture) indexer implements cursor tracking for ledger sequences:

1. **Cursor Storage Schema** (lines 72-82):
   ```sql
   CREATE TABLE IF NOT EXISTS cdc_cursors (
     indexer_id      TEXT        PRIMARY KEY,
     last_ledger     BIGINT      NOT NULL,
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )
   ```

2. **Event Storage Schema** (lines 45-68):
   ```sql
   CREATE TABLE IF NOT EXISTS stream_events (
     ...
     event_id        TEXT        NOT NULL UNIQUE,   -- <ledger>-<tx_index>-<event_index>
     ledger_sequence BIGINT      NOT NULL,
     ledger_timestamp TIMESTAMPTZ NOT NULL,
     tx_hash         TEXT        NOT NULL,
     ...
   )
   ```

3. **Functions Implemented**:
   - `getCursor(db, indexerId)` - Retrieves last processed ledger
   - `setCursor(db, indexerId, lastLedger)` - Persists cursor position
   - `insertEvents()` - UPSERT operation prevents duplicates on `event_id`
   - `parseStreamEvent()` - Creates event ID as `<ledger>-<txIndex>-<eventIndex>`

#### ⚠️ GAPS & ISSUES IDENTIFIED

1. **Event ID Format Too Simple**
   - Current format: `<ledger>-<txIndex>-<eventIndex>`
   - **Issue**: Relies solely on ledger sequence number; does not encode timestamp or transaction hash
   - **Risk**: Same event_id can refer to different events if ledgers are reindexed or if concurrent submissions produce collisions at the same <ledger>-<txIndex>-<eventIndex>
   - **Location**: `/workspaces/stellar_client_os/scripts/cdc-indexer.ts`, line 420-428 in `parseStreamEvent()`

2. **Cursor Granularity Insufficient for Concurrency**
   - Current: Only tracks `last_ledger` per indexer
   - **Issue**: If multiple indexer instances run concurrently or if the same ledger contains events from multiple contracts, the ledger-only cursor cannot distinguish between processed and unprocessed events within a ledger
   - **Missing**: Ledger timestamp or transaction hash in cursor tuple
   - **Location**: `getCursor()` (line 237), `setCursor()` (line 246)

3. **No Timestamp Stability Guarantee**
   - The indexer uses `ledgerClosedAt` from RPC response (line 428)
   - **Issue**: `ledgerClosedAt` can vary in precision or format; if relied upon for cursor position, it could cause reordering with equal timestamps
   - **Missing**: Explicit stable ordering of events with identical `ledgerClosedAt` timestamps using (txHash, eventIndex) as tiebreaker

4. **Deduplication Relies on Single Natural Key**
   - UNIQUE constraint on `event_id` (line 51)
   - **Issue**: If `event_id` format changes or becomes ambiguous, the dedup protection is lost
   - **Missing**: Composite index or additional unique constraint on (ledger_sequence, tx_hash, event_index)

### Related Files & Tests

- **Tests**: `/workspaces/stellar_client_os/scripts/cdc-indexer.test.ts`
  - `describe("getCursor")` - line 203
  - `describe("setCursor")` - line 213
  - `describe("insertEvents")` - line 221
  - No tests specifically for compound cursor stability across restarts or concurrent ingestion

- **Patch File**: `/workspaces/stellar_client_os/issue-873-event-dedup-wiring.patch`
  - Addresses event deduplication wiring but does NOT address stable compound cursors
  - Removes unbounded in-memory `seenEvents` Set in favor of bounded `EventDedupCache`
  - Missing: Integration of cursor stability improvements

### Recommendations for Fix

1. **Upgrade event_id format** to include transaction hash:
   ```
   eventId = <ledger>-<txHash>-<eventIndex>
   ```

2. **Extend cursor schema** to capture compound position:
   ```sql
   ALTER TABLE cdc_cursors ADD COLUMN (
     last_tx_hash TEXT,
     last_event_index BIGINT,
     last_timestamp TIMESTAMPTZ
   );
   ```

3. **Add composite unique constraint**:
   ```sql
   ALTER TABLE stream_events
   ADD CONSTRAINT event_identity UNIQUE (ledger_sequence, tx_hash, event_index);
   ```

4. **Implement tiebreaker logic** in `runPollCycle()` to order events by (timestamp, tx_hash, event_index) when fetching

---

## OBJECTIVE 2: Failed Event Retention with Replay

### Objective Summary
Retain failed events with causes and attempts; replay under permissions without blocking unrelated partitions.

### Current Implementation Status

#### ✅ IMPLEMENTED (Partial - Audit Layer)

**Location: `/workspaces/stellar_client_os/packages/sdk/src/audit.ts`**

1. **Audit Record Schema** (lines 42-53):
   ```typescript
   export interface AuditRecord extends AuditRecordParams {
     id: string;
     timestamp: string; // ISO 8601 UTC
     outcome: AuditOutcome; // "ALLOWED" or "DENIED"
     reason?: string;
   }
   ```

2. **Access Policy** (lines 63-86):
   - Role-based access control (admin, operator, auditor, viewer)
   - `DEFAULT_ACCESS_POLICY` enforces least-privilege for privileged actions

3. **Functions Implemented**:
   - `AuditLogger.record()` - Logs all privileged actions with actor, action, target, timestamp, reason
   - Metadata sanitization prevents secret logging

#### ✅ PARTIALLY IMPLEMENTED (Mobile Offline Layer)

**Location: `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts`**

1. **Idempotent Action Queue** (lines 86-173):
   - Persists failed actions with `status: "failed"` and `attemptCount`
   - Supports replay via `flushActionQueue()` (lines 286-321)
   - Tracks `operationId` for server-side idempotency

2. **Status Lifecycle** (line 45):
   - `"pending"` → `"in-flight"` → `"failed"` or dequeued
   - Allows retries without blocking other operations

3. **Functions Implemented**:
   - `markFailed()` - Marks action as failed for replay
   - `flushActionQueue()` - Replays failed actions with error handler
   - `onError` callback for per-action error handling

#### ❌ GAPS & ISSUES IDENTIFIED

1. **No Failed Event Retention in CDC Indexer**
   - Current: Failed events are skipped with a warning (line 528 in cdc-indexer.ts)
   - **Issue**: Failed events are not persisted; they are simply logged and continue
   - **Missing**: Dedicated `failed_events` table with retry count and cause
   - **Location**: `/workspaces/stellar_client_os/scripts/cdc-indexer.ts`, line 528

2. **No Permission Check Before Replay**
   - Mobile offline queue does not verify permissions before replaying actions
   - **Issue**: Any queued action can be replayed without checking if the user's role changed or if permissions were revoked
   - **Missing**: Permission validation in `flushActionQueue()` before calling `handler`
   - **Location**: `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts`, line 305

3. **Partition Isolation Not Enforced**
   - If one action in the queue fails (e.g., network error), `flushActionQueue()` continues processing others
   - **Issue**: No mechanism to isolate failed partitions and prevent cascading failures
   - **Missing**: Partition-aware error handling; grouping actions by logical partition (e.g., by contract, stream, or campaign)
   - **Location**: `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts`, line 308-315

4. **No Cause Recording for Failed Events**
   - Audit logs record action outcome but not the specific cause (network error, contract failure, permission denied)
   - **Missing**: `failureCategory` or `errorCode` field in AuditRecord for categorizing failures
   - **Location**: `/workspaces/stellar_client_os/packages/sdk/src/audit.ts`

5. **Retention Manager Not Integrated with Event Replay**
   - `RetentionManager` (retention.ts) handles data deletion but does not interact with event replay
   - **Issue**: Failed events may never be deleted if retention rules are not applied
   - **Missing**: Integration point between `RetentionManager` and failed event cleanup
   - **Location**: `/workspaces/stellar_client_os/packages/sdk/src/retention.ts`

### Related Files & Tests

- **Audit Tests**: `/workspaces/stellar_client_os/packages/sdk/src/__tests__/audit.test.ts`
  - Tests for access policy and audit logging
  - No tests for failed event retention or replay

- **Mobile Offline Tests**: `/workspaces/stellar_client_os/apps/mobile/src/offline/__tests__/`
  - `actionQueue.test.ts` - Tests queue operations
  - `offlineFlow.test.ts` - Tests offline flow
  - Missing tests for permission checks and partition isolation

- **Retention Tests**: `/workspaces/stellar_client_os/packages/sdk/src/__tests__/retention.test.ts`
  - Tests retention policy but not event replay

### Recommendations for Fix

1. **Create failed_events table** in CDC indexer:
   ```sql
   CREATE TABLE failed_events (
     id BIGSERIAL PRIMARY KEY,
     event_id TEXT NOT NULL,
     cause TEXT NOT NULL, -- e.g. "XDR_PARSE_ERROR", "DB_INSERT_FAILURE"
     attempts INT NOT NULL DEFAULT 1,
     last_attempt_at TIMESTAMPTZ NOT NULL,
     raw_event JSONB NOT NULL,
     should_retry BOOLEAN DEFAULT TRUE
   );
   ```

2. **Add permission check to mobile action queue**:
   ```typescript
   async function flushActionQueue(...) {
     for (const action of actions) {
       const hasPermission = await checkPermissions(action.type);
       if (!hasPermission) {
         onError?.(new PermissionError("..."), action);
         continue;
       }
       // ... retry logic
     }
   }
   ```

3. **Implement partition isolation**:
   - Group actions by partition key (contract_id, stream_id, etc.)
   - Track failures per partition
   - Only replay actions from non-failed partitions

4. **Add failureCategory to AuditRecord**:
   ```typescript
   export interface AuditRecord {
     ...
     failureCategory?: "NETWORK" | "PERMISSION" | "VALIDATION" | "INTERNAL";
   }
   ```

---

## OBJECTIVE 3: Draft Persistence with Offline Confirmation

### Objective Summary
Persist drafts across restarts and prohibit deployment or financial actions until online state is confirmed.

### Current Implementation Status

#### ✅ PARTIALLY IMPLEMENTED (Offline Storage Layer)

**Location: `/workspaces/stellar_client_os/apps/mobile/src/offline/storage.ts`**

1. **Persistent Storage Interface** (lines 14-22):
   ```typescript
   export interface KeyValueStorage {
     getItem(key: string): Promise<string | null>;
     setItem(key: string, value: string): Promise<void>;
     removeItem(key: string): Promise<void>;
   }
   ```

2. **Configuration** (lines 46-49):
   - `configureOfflineStorage(storage)` - Registers backend (AsyncStorage, MMKV, etc.)
   - `getOfflineStorage()` - Returns configured or in-memory fallback

3. **JSON Serialization Helpers** (lines 74-82):
   - `readJSON<T>()` - Deserializes stored drafts
   - `writeJSON<T>()` - Persists drafts

#### ⚠️ PARTIALLY IMPLEMENTED (Campaign/Action Queue)

**Location: `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.ts`**

1. **Sync Queue Persistence** (lines 245-260):
   - Stores queue items in localStorage with `storageKey` (default: "fundable_sync_queue")
   - Survives page refreshes
   - Tracks item status: pending, syncing, synced, failed, conflict

2. **Draft Preservation** (lines 41-42):
   - `payload?: unknown` - Preserves user input across sync attempts
   - `label` and `description` for UI presentation

3. **Functions Implemented**:
   - `enqueue()` - Adds draft to queue
   - `updatePayload()` - Updates draft without losing state
   - `clearSynced()` - Removes only completed items

#### ❌ CRITICAL GAPS IDENTIFIED

1. **No Online State Confirmation Before Deployment**
   - Campaign deployment and financial actions can proceed without explicit online confirmation
   - **Issue**: Draft persisted but no guard against deploying while offline
   - **Missing**: Pre-deployment online check that requires user confirmation
   - **Location**: `/workspaces/stellar_client_os/apps/web/src/services/contract.deployer.ts`

2. **No Draft Lifecycle Management**
   - Drafts stored but not explicitly marked as "confirmed online" or "ready for deployment"
   - **Issue**: No distinction between "draft saved" and "draft ready for deployment"
   - **Missing**: `draftStatus` field (e.g., "editing", "offline_saved", "online_confirmed", "deployed")
   - **Location**: Mobile and web apps need unified draft schema

3. **Offline Detection Not Integrated with Deployment Guards**
   - `useSyncQueue` tracks `isOnline` state but deployment logic does not consume it
   - **Issue**: Deployment may proceed even if `isOnline === false`
   - **Missing**: Guard clause in deployment handler checking online state
   - **Location**: `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.ts`, line 180

4. **No Atomic Draft-to-Deployment Transition**
   - Draft persisted separately from deployment transaction
   - **Issue**: If deployment fails after draft is moved offline, recovery path is unclear
   - **Missing**: Transactional guard: draft must remain in storage until deployment confirmed on-chain
   - **Location**: Mobile campaign creation and web campaign wizard

5. **Mobile Offline Layer Missing Draft Semantics**
   - `actionQueue.ts` persists pending actions but does not distinguish draft actions from other actions
   - **Issue**: No explicit "draft" concept; drafts are conflated with queued operations
   - **Missing**: Draft-specific lifecycle and guards
   - **Location**: `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts`

6. **Campaign Wizard Does Not Persist Draft State**
   - Web campaign wizard accepts user input but does not persist drafts locally
   - **Issue**: If page is refreshed, all input is lost
   - **Missing**: Auto-save of campaign draft to localStorage after each field change
   - **Location**: `/workspaces/stellar_client_os/apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx`

### Related Files & Tests

- **Offline Storage Tests**: `/workspaces/stellar_client_os/apps/mobile/src/offline/__tests__/`
  - `encryptedStorage.test.ts` - Tests secure storage
  - `sync.test.ts` - Tests sync logic
  - Missing: Draft persistence and offline confirmation tests

- **Sync Queue Tests**: `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.test.ts`
  - Tests queue operations
  - Missing: Online confirmation requirement before deployment

- **Campaign Wizard**: No test for draft persistence
  - `/workspaces/stellar_client_os/apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx`

- **Deployment Documentation**: `/workspaces/stellar_client_os/apps/web/src/__tests__/deployment-docs.test.ts`
  - Tests deployment lifecycle
  - Missing: Draft persistence and offline confirmation requirements

### Recommendations for Fix

1. **Extend draft schema** with confirmation state:
   ```typescript
   export interface CampaignDraft {
     id: string;
     payload: CampaignFormData;
     status: "editing" | "offline_saved" | "online_confirmed" | "deployed";
     savedAt: number;
     confirmedOnlineAt?: number;
     deployedAt?: number;
   }
   ```

2. **Implement online confirmation dialog**:
   ```typescript
   // In deployment handler
   if (!isOnline) {
     await showConfirmationDialog("You are offline. Wait for connection.");
     return;
   }
   
   // After connection restored
   const confirmed = await confirmOnlineState();
   if (!confirmed) return;
   
   draft.status = "online_confirmed";
   await deployDraft(draft);
   ```

3. **Add pre-deployment guards** in `contract.deployer.ts`:
   ```typescript
   async deployDraft(draft: CampaignDraft) {
     if (draft.status !== "online_confirmed") {
       throw new Error("Draft not confirmed online");
     }
     // ... deployment logic
   }
   ```

4. **Auto-save campaign wizard** to localStorage:
   ```typescript
   useEffect(() => {
     const timer = debounce(() => {
       saveDraftToStorage(formData);
     }, 500);
     return timer.cancel;
   }, [formData]);
   ```

5. **Unify draft semantics** across mobile and web:
   - Single draft schema
   - Consistent lifecycle
   - Synchronized storage layer

---

## OBJECTIVE 4: Projection Comparison and Audit

### Objective Summary
Compare projections at a fixed ledger, record drift, and require auditable repair rather than silent overwrite.

### Current Implementation Status

#### ✅ IMPLEMENTED (Bindings Drift Detection)

**Location: `/workspaces/stellar_client_os/packages/sdk/src/__tests__/bindings-drift.test.ts`**

1. **Drift Detection** (lines 12-113):
   - `detectBindingsDrift()` - Compares contract source mtime to generated bindings mtime
   - Identifies when contract source is newer than generated bindings
   - Provides remediation command: `pnpm --filter @fundable/sdk generate:wasm --contract <name>`

2. **Check Script** (referenced in test, likely at `/workspaces/stellar_client_os/packages/sdk/scripts/check-bindings-drift.js`):
   - Runs as part of CI/CD to catch stale bindings

#### ✅ PARTIALLY IMPLEMENTED (CO2 Projection Model)

**Location: `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts`**

1. **Projection Schema** (lines 48-80):
   - Species-specific sequestration profiles
   - Climate scenario modeling
   - 95% confidence interval calculation

2. **Snapshot Data Points** (lines 83-93):
   - Year-by-year CO2 projections
   - Cumulative values with CI bounds
   - Surviving tree count

#### ✅ PARTIALLY IMPLEMENTED (Audit Trail for Campaign Verification)

**Location: `/workspaces/stellar_client_os/apps/web/src/services/campaign-verification-audit.service.ts`**

1. **Audit Service** (inferred from file name, see below for details):
   - Records campaign verification events
   - Tracks reviewer actions

#### ❌ CRITICAL GAPS IDENTIFIED

1. **No Projection Snapshot Ledger Tracking**
   - CO2 projections are computed but not anchored to a specific ledger sequence
   - **Issue**: Projections can be recalculated at any time, producing different results without audit trail
   - **Missing**: `ledgerSequence` field in projection result to denote "calculated at this ledger"
   - **Location**: `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts`, lines 95-115

2. **No Projection Comparison at Fixed Ledger**
   - System cannot compare two projections calculated at different ledgers to detect drift
   - **Issue**: Silent divergence in calculated values goes undetected
   - **Missing**: `compareProjections(projection1, projection2): ProjectionDrift` function
   - **Location**: No comparison logic found

3. **No Drift Recording Mechanism**
   - Even if drift is detected, there is no schema to record it
   - **Issue**: Drift is invisible to auditors and operators
   - **Missing**: `projection_drift_audit` table to log drift events
   - **Location**: Database schema files (likely in migrations or SQL files)

4. **No Audit Requirement for Projection Repairs**
   - If a projection is corrected/recalculated, no audit entry is created
   - **Issue**: Silent overwrite of projections without operator oversight
   - **Missing**: Mandatory audit log before allowing projection recalculation
   - **Location**: Campaign impact calculation services

5. **State Comparison Not Integrated with Audit Logger**
   - Campaign verification audit exists but is not connected to projection comparison
   - **Issue**: Projection drift is not correlated with verification state changes
   - **Missing**: Cross-reference between `AuditRecord` and `ProjectionDrift`
   - **Location**: `/workspaces/stellar_client_os/packages/sdk/src/audit.ts` and campaign services

6. **No Ledger Snapshot Schema**
   - Projections are calculated but not snapshots are not preserved at specific ledgers
   - **Issue**: Operators cannot roll back to a previous ledger's state for auditing
   - **Missing**: `ledger_snapshots` table with campaign state frozen at each ledger
   - **Location**: Web app and SDK

### Related Files & Tests

- **Bindings Drift Tests**: `/workspaces/stellar_client_os/packages/sdk/src/__tests__/bindings-drift.test.ts`
  - Tests drift detection for WASM bindings
  - Not applicable to projection comparison

- **CO2 Projection**: `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts`
  - No tests found for ledger snapshots or drift detection

- **Campaign Verification Audit**: `/workspaces/stellar_client_os/apps/web/src/services/campaign-verification-audit.service.ts`
  - Likely implements some audit logging but not projection-specific

- **Campaign Impact Leaderboard**: `/workspaces/stellar_client_os/apps/web/src/services/campaign-impact-leaderboard.service.ts`
  - Calculates and caches impact data
  - No ledger snapshot logic

### Recommendations for Fix

1. **Extend projection schema** with ledger anchor:
   ```typescript
   export interface Co2ProjectionResult {
     ...
     ledgerSequence: number;  // NEW: Ledger where this projection was calculated
     calculatedAt: string;    // ISO 8601 timestamp
     checksum?: string;       // SHA-256 of result for drift detection
   }
   ```

2. **Implement projection comparison**:
   ```typescript
   export interface ProjectionDrift {
     previousLedger: number;
     currentLedger: number;
     field: string; // e.g. "totalCo2Kg", "ci95HighKg"
     previousValue: number;
     currentValue: number;
     percentChange: number;
   }
   
   export function compareProjections(
     prev: Co2ProjectionResult,
     current: Co2ProjectionResult
   ): ProjectionDrift[] {
     // Compare each field, return drifts exceeding threshold
   }
   ```

3. **Create projection audit table**:
   ```sql
   CREATE TABLE projection_audits (
     id BIGSERIAL PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     previous_ledger BIGINT,
     current_ledger BIGINT,
     drift_detected BOOLEAN NOT NULL,
     drift_details JSONB, -- ProjectionDrift[]
     actor VARCHAR NOT NULL,
     reason VARCHAR,
     timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     audit_entry_id VARCHAR -- Link to AuditRecord
   );
   ```

4. **Require audit before recalculation**:
   ```typescript
   async recalculateProjection(
     campaignId: string,
     actor: string,
     reason: string
   ): Promise<Co2ProjectionResult> {
     const previous = await getProjection(campaignId);
     const current = await calculateProjection(campaignId);
     
     const drifts = compareProjections(previous, current);
     if (drifts.length > 0) {
       await auditProjectionDrift(campaignId, previous, current, drifts, actor, reason);
     }
     
     await storeProjection(current);
     return current;
   }
   ```

5. **Add ledger snapshot schema**:
   ```sql
   CREATE TABLE ledger_snapshots (
     id BIGSERIAL PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     ledger_sequence BIGINT NOT NULL,
     snapshot_data JSONB NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL,
     UNIQUE(campaign_id, ledger_sequence)
   );
   ```

6. **Integrate with audit logger**:
   ```typescript
   // Before recalculating projections
   await auditLogger.record({
     actor: operatorId,
     action: "recalculate.projection",
     target: `campaign:${campaignId}:projection`,
     reason: "Drift detected or manual recalculation",
     outcome: drifts.length > 0 ? "DRIFT_DETECTED" : "ALLOWED",
   });
   ```

---

## Summary Table: Implementation Status

| Objective | Component | Status | Critical Gaps | Severity |
|-----------|-----------|--------|----------------|----------|
| 1. Stable Compound Cursors | CDC Indexer | Partial | Event ID format insufficient; cursor granularity too coarse | HIGH |
| 2. Failed Event Retention | Audit Layer | Partial | No failed event persistence; no permission checks on replay | HIGH |
| 2. Failed Event Retention | Mobile Queue | Partial | No partition isolation; no failure categorization | MEDIUM |
| 3. Draft Persistence | Offline Storage | Partial | No online confirmation gate; no atomic draft-to-deployment | CRITICAL |
| 3. Draft Persistence | Campaign Wizard | Missing | No draft auto-save; no lifecycle management | HIGH |
| 4. Projection Comparison | Bindings Drift | Implemented | Not applicable to projections | N/A |
| 4. Projection Comparison | CO2 Projection | Partial | No ledger anchoring; no comparison logic; no audit schema | HIGH |
| 4. Projection Comparison | Campaign Audit | Partial | Not integrated with projection drift detection | MEDIUM |

---

## Implementation Priority Recommendation

1. **CRITICAL** - Objective 3 (Draft Persistence with Offline Confirmation)
   - Reason: Prevents financial loss and data loss
   - Effort: Medium (1-2 weeks)
   - Impact: High (affects all offline users)

2. **HIGH** - Objective 1 (Stable Compound Cursors)
   - Reason: Prevents event duplication and reordering
   - Effort: Medium (2-3 weeks)
   - Impact: High (affects all event processing)

3. **HIGH** - Objective 2 (Failed Event Retention)
   - Reason: Enables auditable recovery and compliance
   - Effort: High (3-4 weeks)
   - Impact: Medium (affects offline recovery)

4. **HIGH** - Objective 4 (Projection Comparison)
   - Reason: Enables auditable state management
   - Effort: High (3-4 weeks)
   - Impact: Medium (affects impact reporting)

---

## Files to Modify Summary

| Objective | Files | Action |
|-----------|-------|--------|
| 1 | `scripts/cdc-indexer.ts` | Extend event_id format, upgrade cursor schema |
| 1 | `scripts/cdc-indexer.test.ts` | Add tests for compound cursor stability |
| 2 | `packages/sdk/src/audit.ts` | Add failureCategory field |
| 2 | `apps/mobile/src/offline/actionQueue.ts` | Add permission checks, partition isolation |
| 2 | `scripts/cdc-indexer.ts` | Create failed_events table, implement retry logic |
| 3 | `apps/web/src/hooks/use-sync-queue.ts` | Add online confirmation gate |
| 3 | `apps/mobile/src/offline/storage.ts` | Add draft lifecycle schema |
| 3 | `apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx` | Implement draft auto-save |
| 4 | `apps/web/src/lib/co2-sequestration-projection.ts` | Add ledgerSequence, checksum |
| 4 | `packages/sdk/src/audit.ts` | Add projection-specific audit actions |
| 4 | Database migrations | Create projection_audits, ledger_snapshots tables |

---

## Related Issues & Documentation

- **Issue #531**: Soroban Stream Event CDC Indexer (cdc-indexer.ts header)
- **Issue #109**: Privileged administrative action audit logging (audit.ts header)
- **Issue #873**: Event deduplication wiring (issue-873-event-dedup-wiring.patch)
- **Issue #78**: Bounded LRU cache size (referenced in patch)
- **Issue #90-#94**: Mobile offline features (mobile-issues-90-91-92-94.md)
- **Issue #528, #73**: Offline-first PWA sync queue (use-sync-queue.ts header)
- **Issue #617**: Soroban SDK upgrade (PR_DESCRIPTION.md)

---

## Next Steps

1. Review each objective with the team
2. Create focused tickets for each gap
3. Prioritize based on impact and dependencies
4. Implement compound cursor stability first (blocks other improvements)
5. Add comprehensive tests for each objective
6. Update documentation with new lifecycle guarantees
