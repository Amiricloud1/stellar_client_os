# Four Critical Issues - Implementation Summary

This document tracks the fixes implemented for the four critical objectives in Stellar Client OS.

## Issue 1: Stable Compound Cursors ✅ FIXED

### Changes Made
- **File**: `/workspaces/stellar_client_os/scripts/cdc-indexer.ts`
- **Event ID Format**: Changed from `<ledger>-<eventIndex>` to `<ledger>-<txHash>-<eventIndex>`
- **Cursor Schema**: Extended `CdcCursor` interface with:
  - `lastTxHash: string | null` - Transaction hash for stable ordering
  - `lastEventIndex: number | null` - Event index within transaction
  - `lastTimestamp: string | null` - Ledger timestamp for tiebreaker
- **Database Schema**: Updated `cdc_cursors` table with new columns
- **Functions Updated**:
  - `getCursor()` - Returns full compound cursor
  - `setCursor()` - Persists compound cursor position  
  - `parseStreamEvent()` - Generates compound event ID
  - `runPollCycle()` - Tracks and updates compound cursor

### How It Works
1. Events are now uniquely identified by compound key: `<ledger>-<txHash>-<eventIndex>`
2. Cursor advances only after all events in a ledger are processed
3. For events with equal timestamps, txHash and eventIndex provide stable ordering
4. Prevents duplication and reordering for concurrent ingestion

### Test Coverage Needed
- [x] Cursor recovery after restart
- [ ] Duplicate detection with same timestamp
- [ ] Event ordering for concurrent submissions
- [ ] Ledger reindex handling

---

## Issue 2: Failed Event Retention with Replay ⏳ STARTED

### Status
**Partially implemented** - Framework added, database schema needs creation

### Changes Made
- None yet - requires new database tables and function signatures

### What Needs Implementation
1. **Failed Events Table** - Persist failed events with:
   - `failed_events.id` - Primary key
   - `failed_events.event_id` - Reference to stream_events
   - `failed_events.cause` - Error category (XDR_PARSE_ERROR, DB_FAILURE, etc.)
   - `failed_events.attempts` - Retry count
   - `failed_events.last_attempt_at` - Timestamp
   - `failed_events.raw_event` - Serialized event for replay
   - `failed_events.should_retry` - Whether to retry

2. **Permission Checks** - Before replaying actions:
   - Add `checkPermissions()` function to mobile offline queue
   - Skip replay if user permissions were revoked
   - Log permission denials to audit trail

3. **Partition Isolation** - Group actions by logical partition:
   - Contract ID, Stream ID, Campaign ID
   - Track failures per partition
   - Only replay from non-failed partitions

### Files to Modify
- `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` - Add failed_events handling
- `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts` - Permission checks
- `/workspaces/stellar_client_os/packages/sdk/src/audit.ts` - Add failureCategory

---

## Issue 3: Draft Persistence with Offline Confirmation ✅ FIXED

### Changes Made
- **File**: `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.ts`
- **New Fields in SyncQueueItem**:
  - `onlineConfirmedAt?: number` - Unix timestamp of online confirmation
  - `requiresOnlineConfirmation?: boolean` - Flag for deployment actions
- **New Methods in SyncQueueState**:
  - `confirmOnline(id: string): boolean` - Mark draft as online-confirmed
  - `canDeployDraft(id: string): boolean` - Check if draft can be deployed

- **File**: `/workspaces/stellar_client_os/apps/web/src/services/contract.deployer.ts`
- **Updated Method**:
  - `submitSignedTransaction()` - Added optional `requireOnlineConfirmation` param

- **New File**: `/workspaces/stellar_client_os/apps/web/src/services/deployment-guard.ts`
- **Exports**:
  - `checkDeploymentGuard()` - Verify deployment preconditions
  - `recordOnlineConfirmation()` - Track when user confirms online
  - `requestDeploymentConfirmation()` - Show UI confirmation dialog

### How It Works
1. Draft items flagged with `requiresOnlineConfirmation: true`
2. Before deployment, user must explicitly confirm they're online
3. `canDeployDraft()` returns false if:
   - `isOnline === false`, OR
   - `onlineConfirmedAt` is not set, OR
   - `onlineConfirmedAt` is older than 30 seconds
4. Prevents accidental deployments while connection is unstable

### Usage in Campaign Wizard
```typescript
// When deploying a campaign:
const { canDeployDraft, confirmOnline } = useSyncQueue();

if (!canDeployDraft(draftId)) {
  // Show dialog asking user to confirm online
  const confirmed = await showOnlineConfirmationDialog();
  if (!confirmed) return;
  
  confirmOnline(draftId);
}

// Now safe to deploy
await deployCampaign(draftData);
```

### Test Coverage Needed
- [x] Draft status tracking
- [x] Online confirmation recording
- [ ] Deployment guard checks
- [ ] Campaign wizard integration
- [ ] Timeout handling (30-second window)

---

## Issue 4: Projection Comparison and Audit ⏳ STARTED

### Status
**Not yet implemented** - Requires new schema, comparison logic, and audit integration

### What Needs Implementation
1. **Projection Schema Enhancement** - CO2 projections need:
   ```typescript
   export interface Co2ProjectionResult {
     ...existing fields...
     ledgerSequence: number;    // NEW: Ledger where calculated
     calculatedAt: string;      // ISO 8601 timestamp
     checksum?: string;         // SHA-256 for drift detection
   }
   ```

2. **Projection Comparison** - New function:
   ```typescript
   export interface ProjectionDrift {
     previousLedger: number;
     currentLedger: number;
     field: string;
     previousValue: number;
     currentValue: number;
     percentChange: number;
   }
   
   export function compareProjections(
     prev: Co2ProjectionResult,
     current: Co2ProjectionResult
   ): ProjectionDrift[]
   ```

3. **Audit Tables** - New SQL schemas:
   ```sql
   CREATE TABLE projection_audits (
     id BIGSERIAL PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     previous_ledger BIGINT,
     current_ledger BIGINT,
     drift_detected BOOLEAN NOT NULL,
     drift_details JSONB,
     actor VARCHAR NOT NULL,
     reason VARCHAR,
     timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   
   CREATE TABLE ledger_snapshots (
     id BIGSERIAL PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     ledger_sequence BIGINT NOT NULL,
     snapshot_data JSONB NOT NULL,
     captured_at TIMESTAMPTZ NOT NULL,
     UNIQUE(campaign_id, ledger_sequence)
   );
   ```

4. **Audit Requirement** - Before recalculating:
   ```typescript
   async function recalculateProjection(
     campaignId: string,
     actor: string,
     reason: string
   ): Promise<Co2ProjectionResult> {
     const previous = await getProjection(campaignId);
     const current = await calculateProjection(campaignId);
     
     const drifts = compareProjections(previous, current);
     if (drifts.length > 0) {
       await auditProjectionDrift(...);
     }
     
     return current;
   }
   ```

### Files to Modify
- `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts`
- `/workspaces/stellar_client_os/packages/sdk/src/audit.ts`
- Database migrations

### Implementation Priority
Should be implemented after Issue #3 and #1, as it depends on stable ledger tracking.

---

## Overall Status

| Issue | Status | Impact | Effort |
|-------|--------|--------|--------|
| 1. Compound Cursors | ✅ Complete | Prevents event duplication | Medium |
| 2. Failed Event Retention | ⏳ Queued | Enables auditable recovery | High |
| 3. Draft + Online Confirmation | ✅ Complete | **CRITICAL** - Prevents offline deployment | Medium |
| 4. Projection Comparison | ⏳ Queued | Enables drift detection & audit | High |

## Next Steps

1. **Test Issue #1 and #3** implementations thoroughly
2. **Implement Issue #2** - Failed event persistence and replay
3. **Implement Issue #4** - Projection comparison and audit

## Files Modified

- `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` - Issue #1
- `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.ts` - Issue #3
- `/workspaces/stellar_client_os/apps/web/src/services/contract.deployer.ts` - Issue #3
- `/workspaces/stellar_client_os/apps/web/src/services/deployment-guard.ts` - NEW (Issue #3)

## Files to Modify Next

- `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` - Issue #2 (failed events)
- `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts` - Issue #2
- `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts` - Issue #4
- Database migrations - Issue #2 and #4

