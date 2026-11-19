# Issue Analysis: Implementation Checklist & Quick Reference

## Quick Status Overview

```
OBJECTIVE 1: Stable Compound Cursors
  ✓ Partial Implementation
  ✗ Event ID format insufficient (needs tx_hash)
  ✗ Cursor granularity too coarse (needs event_index)
  ✗ Compound cursor fields missing
  STATUS: 30% Complete — NEEDS FIX

OBJECTIVE 2: Failed Event Retention with Replay
  ✓ Audit layer implemented
  ✓ Action queue with retry support
  ✗ No failed event persistence
  ✗ No permission checks on replay
  ✗ No partition isolation
  STATUS: 40% Complete — NEEDS FIX

OBJECTIVE 3: Draft Persistence with Offline Confirmation
  ✓ Offline storage layer exists
  ✓ Sync queue with payload preservation
  ✗ No online confirmation gate
  ✗ No draft lifecycle management
  ✗ Campaign wizard missing draft auto-save
  STATUS: 35% Complete — CRITICAL FIX NEEDED

OBJECTIVE 4: Projection Comparison and Audit
  ✓ Bindings drift detection (not applicable)
  ✓ CO2 projection model exists
  ✓ Campaign audit service exists
  ✗ No ledger anchoring
  ✗ No projection comparison logic
  ✗ No drift audit schema
  STATUS: 40% Complete — NEEDS FIX
```

---

## Objective 1: Stable Compound Cursors — Implementation Checklist

### Phase 1: Schema Changes (Effort: 2-3 days)

- [ ] **Update event_id format** in `cdc-indexer.ts`
  - Location: `scripts/cdc-indexer.ts`, line 420-428
  - Change: `eventId = <ledger>-<txIndex>-<eventIndex>` → `<ledger>-<txHash>-<eventIndex>`
  - Test: `scripts/cdc-indexer.test.ts`, update line 160-163 test

- [ ] **Extend cdc_cursors table** to store compound position
  - Location: `scripts/cdc-indexer.ts`, line 72-82 (ensureSchema)
  - Add columns: `last_tx_hash TEXT`, `last_event_index BIGINT`
  - Backfill existing cursors with NULL values

- [ ] **Add composite unique constraint** to stream_events
  - Location: `scripts/cdc-indexer.ts`, line 51-52 (ensureSchema)
  - Add: `ALTER TABLE stream_events ADD CONSTRAINT pk_event_position UNIQUE (ledger_sequence, tx_hash, event_index)`

### Phase 2: Cursor Logic (Effort: 3-4 days)

- [ ] **Update getCursor() function**
  - Location: `scripts/cdc-indexer.ts`, line 237-243
  - Return: Tuple of (ledger, txHash, eventIndex) instead of just ledger
  - Update return type: `Promise<{ ledger: number, txHash: string, eventIndex: number } | null>`

- [ ] **Update setCursor() function**
  - Location: `scripts/cdc-indexer.ts`, line 246-256
  - Accept: Compound cursor tuple
  - Update SQL: Include last_tx_hash, last_event_index in UPSERT

- [ ] **Implement resume logic** in runPollCycle()
  - Location: `scripts/cdc-indexer.ts`, line 475-485
  - Logic: If resuming within same ledger, skip events before (txHash, eventIndex)
  - Handle: Ledger boundary cases when resuming

### Phase 3: Testing (Effort: 3-4 days)

- [ ] **Add stability tests** to `cdc-indexer.test.ts`
  - Test: Resuming after crash processes no duplicates
  - Test: Concurrent ingestion produces identical results regardless of order
  - Test: Event reordering within same ledger detected

- [ ] **Add integration test** with simulated event duplication
  - Scenario: Same event appears in multiple polls (overlapping ranges)
  - Verification: Only one instance in database

- [ ] **Performance test** with high-frequency events
  - Scenario: 10,000 events with duplicate tx_hash + event_index
  - Verification: Dedup works without significant slowdown

### Phase 4: Deployment (Effort: 1 week)

- [ ] **Data migration** for existing cursors
  - Query existing cdc_cursors, populate new columns with max(tx_hash), max(event_index) from latest ledger

- [ ] **Backward compatibility** check
  - Ensure old event IDs can be converted to new format
  - Support gradual rollout without reindexing

- [ ] **Monitoring** for cursor drift
  - Track: Gap between consecutive cursor positions
  - Alert: If gap > expected range (indicates missed events)

### Acceptance Criteria
- ✅ Event ID includes transaction hash
- ✅ Cursor stores compound position (ledger, txHash, eventIndex)
- ✅ Resuming after crash produces identical results
- ✅ No duplicates detected in high-frequency test
- ✅ All existing tests pass

---

## Objective 2: Failed Event Retention with Replay — Implementation Checklist

### Phase 1: Audit Layer (Effort: 2-3 days)

- [ ] **Add failureCategory to AuditRecord**
  - Location: `packages/sdk/src/audit.ts`, line 42-53
  - Add field: `failureCategory?: "NETWORK" | "PERMISSION" | "VALIDATION" | "INTERNAL"`
  - Update AuditRecordParams to include failureCategory

- [ ] **Add replay action to AuditAction enum**
  - Location: `packages/sdk/src/audit.ts`, line 24-30
  - Add: `"replay.event"`, `"skip.event"`, `"purge.failed_events"`

- [ ] **Update audit policy** for replay actions
  - Location: `packages/sdk/src/audit.ts`, line 63-86 (DEFAULT_ACCESS_POLICY)
  - Operators can replay events
  - Admins only can purge failed events

### Phase 2: CDC Indexer Persistence (Effort: 3-4 days)

- [ ] **Create failed_events table**
  - Location: `scripts/cdc-indexer.ts`, line 45+ (ensureSchema)
  - Schema:
    ```sql
    CREATE TABLE failed_events (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL,
      cause TEXT NOT NULL, -- e.g. "XDR_PARSE_ERROR", "DB_INSERT_FAILURE"
      attempts INT NOT NULL DEFAULT 1,
      last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_event JSONB NOT NULL,
      contract_id TEXT NOT NULL,
      should_retry BOOLEAN DEFAULT TRUE,
      error_message TEXT
    );
    ```

- [ ] **Implement failed event persistence**
  - Location: `scripts/cdc-indexer.ts`, line 528 (error handling in parseStreamEvent)
  - Instead of: `log("warn", "...")`
  - Do: `await recordFailedEvent(db, rawEvent, cause)`

- [ ] **Implement replay function**
  - Location: `scripts/cdc-indexer.ts` (new function)
  - Function: `replayFailedEvents(db, rpc, config, filter?: { cause?: string }): Promise<number>`
  - Logic: Fetch failed events, re-parse, insert to stream_events, remove from failed_events

- [ ] **Add retry schedule**
  - Location: `scripts/cdc-indexer.ts`, line 475+ (runPollCycle)
  - Every N iterations: Attempt to replay failed events

### Phase 3: Mobile Action Queue (Effort: 4-5 days)

- [ ] **Add failure categorization**
  - Location: `apps/mobile/src/offline/actionQueue.ts`, line 45-68 (QueuedAction)
  - Add field: `failureCategory?: "NETWORK" | "PERMISSION" | "VALIDATION" | "INTERNAL"`
  - Add field: `failureReason?: string`

- [ ] **Add permission check to flushActionQueue**
  - Location: `apps/mobile/src/offline/actionQueue.ts`, line 291-321 (flushActionQueue)
  - Before handler call:
    ```typescript
    const hasPermission = await checkPermissionsForAction(action);
    if (!hasPermission) {
      await queue.markFailed(action.operationId);
      onError?.(new PermissionError("Permission revoked"), action);
      continue;
    }
    ```

- [ ] **Implement partition isolation**
  - Location: `apps/mobile/src/offline/actionQueue.ts`, line 291-321
  - Group actions by partition key (e.g., streamId, contractId)
  - Track failed partitions, skip actions from failed partitions
  - New interface: `PartitionState = { partition: string, failed: boolean, retryAt?: number }`

- [ ] **Add failure categorization logic**
  - Location: `apps/mobile/src/offline/actionQueue.ts`, line 308-315 (error handling)
  - Catch different error types and categorize:
    ```typescript
    if (error instanceof NetworkError) category = "NETWORK";
    else if (error instanceof PermissionError) category = "PERMISSION";
    else if (error instanceof ValidationError) category = "VALIDATION";
    else category = "INTERNAL";
    ```

### Phase 4: Testing (Effort: 3-4 days)

- [ ] **Add failed event retention tests**
  - Location: `scripts/cdc-indexer.test.ts` (new test suite)
  - Test: Failed events persisted to failed_events table
  - Test: Replay logic recovers failed events

- [ ] **Add permission check tests**
  - Location: `apps/mobile/src/offline/__tests__/actionQueue.test.ts`
  - Test: Action with no permission marked failed
  - Test: Permission-denied action not dequeued

- [ ] **Add partition isolation tests**
  - Location: `apps/mobile/src/offline/__tests__/actionQueue.test.ts`
  - Test: Failed partition prevents other actions in partition from retrying
  - Test: Non-failed partitions retry normally

- [ ] **Add failure categorization tests**
  - Location: Tests for both CDC indexer and mobile queue
  - Test: Network error categorized correctly
  - Test: Permission error categorized correctly

### Acceptance Criteria
- ✅ Failed events persisted in failed_events table with cause
- ✅ Replay logic recovers parseable events
- ✅ Permission check prevents replay if permissions revoked
- ✅ Partition isolation prevents cascading failures
- ✅ Failure category recorded for audit trail

---

## Objective 3: Draft Persistence with Offline Confirmation — Implementation Checklist

### Phase 1: Draft Lifecycle Schema (Effort: 2-3 days)

- [ ] **Define draft status enum**
  - Locations: `apps/mobile/src/offline/types.ts`, `apps/web/src/types/index.ts`
  - Values: `"editing" | "offline_saved" | "online_confirmed" | "deployed"`

- [ ] **Extend CampaignDraft interface**
  - Location: Define new interface (create file if needed: `apps/shared/types/draft.ts`)
  - Fields:
    ```typescript
    export interface CampaignDraft {
      id: string;
      payload: CampaignFormData;
      status: DraftStatus;
      savedAt: number;
      confirmedOnlineAt?: number;
      deployedAt?: number;
      version: number;
    }
    ```

- [ ] **Extend SyncQueueItem** to include draft status
  - Location: `apps/web/src/hooks/use-sync-queue.ts`, line 41-74 (SyncQueueItem)
  - Add field: `draftStatus?: DraftStatus`

### Phase 2: Online Confirmation Gate (Effort: 3-4 days)

- [ ] **Implement online confirmation requirement in deployment**
  - Location: `apps/web/src/services/contract.deployer.ts` (new logic)
  - Check: If not online, show confirmation dialog
  - Wait: Until user confirms or cancels
  - Update draft status: `online_confirmed` only after confirmation

- [ ] **Add online confirmation UI component**
  - Location: Create new component `apps/web/src/components/organisms/OnlineConfirmationDialog.tsx`
  - Display: "You are offline. Connect to internet before deploying."
  - Action: Retry when connection detected, or Cancel to return to editing

- [ ] **Integrate isOnline check into deployment flow**
  - Location: `apps/web/src/services/contract.deployer.ts`
  - Logic:
    ```typescript
    async deployDraft(draft: CampaignDraft) {
      if (draft.status !== "online_confirmed") {
        if (!isOnline) {
          throw new Error("Cannot deploy while offline. Confirm online connection first.");
        }
        draft.status = "online_confirmed";
        await saveDraft(draft);
      }
      // ... deployment logic
    }
    ```

- [ ] **Add connection state monitoring**
  - Use: Existing `useSyncQueue` hook or window.navigator.onLine
  - Update draft status automatically when connection changes

### Phase 3: Draft Auto-Save (Effort: 3-4 days)

- [ ] **Implement auto-save in campaign wizard**
  - Location: `apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx`
  - Debounce: 500ms after form change
  - Save: Draft to localStorage with `readJSON`/`writeJSON` from offline storage
  - Load: On mount, restore draft from storage

- [ ] **Add draft recovery UI**
  - Location: CampaignWizard component
  - On mount: Check for unsaved draft
  - Show: "Resume draft?" dialog
  - Options: Resume, New Campaign, Discard

- [ ] **Implement draft versioning**
  - Save version number with draft
  - On conflict: Show version mismatch UI
  - Allow: Resume old version or start fresh

- [ ] **Add auto-save indicator**
  - Show: Small "Saving..." indicator while draft persists
  - Show: "Saved" confirmation after success
  - Show: Error message if save fails

### Phase 4: Mobile Draft Persistence (Effort: 2-3 days)

- [ ] **Extend actionQueue** to support draft actions
  - Location: `apps/mobile/src/offline/actionQueue.ts`
  - Add: `isDraft?: boolean` field to QueuedAction
  - Behavior: Drafts cannot be removed from queue until confirmed online

- [ ] **Implement draft restoration**
  - Location: Mobile campaign creation screen
  - On mount: Load draft from offline storage
  - Restore: Form state to last saved values

- [ ] **Add online confirmation** before deployment
  - Location: Mobile deployment logic
  - Show: Confirmation dialog if offline
  - Wait: Connection restoration

### Phase 5: Testing (Effort: 3-4 days)

- [ ] **Add draft persistence tests**
  - Location: `apps/web/src/hooks/use-sync-queue.test.ts`
  - Test: Draft saved to localStorage on change
  - Test: Draft restored on page reload

- [ ] **Add online confirmation tests**
  - Test: Deployment blocked while offline
  - Test: Deployment proceeds after online confirmation
  - Test: Draft status updated to online_confirmed

- [ ] **Add auto-save tests**
  - Test: Form changes auto-saved
  - Test: Save cancelled if page unloads
  - Test: Multiple drafts stored separately

- [ ] **Add campaign wizard draft tests**
  - Location: Tests for CampaignWizard component
  - Test: Auto-save on each field change
  - Test: Draft restoration on mount

- [ ] **Integration test** offline → online → deploy flow
  - Scenario: User creates draft offline, then comes online, deploys
  - Verification: Draft status transitions correctly

### Acceptance Criteria
- ✅ Draft auto-saved to storage every 500ms
- ✅ Draft restored on page/app reload
- ✅ Deployment blocked if offline
- ✅ Deployment requires online confirmation
- ✅ Draft status = "online_confirmed" before deployment
- ✅ Deployment fails if status != "online_confirmed"
- ✅ No duplicate deployments if connection lost mid-deployment

---

## Objective 4: Projection Comparison and Audit — Implementation Checklist

### Phase 1: Schema Changes (Effort: 2-3 days)

- [ ] **Extend Co2ProjectionResult** with ledger anchor
  - Location: `apps/web/src/lib/co2-sequestration-projection.ts`, line 95-115
  - Add fields:
    ```typescript
    ledgerSequence: number;     // Ledger where calculated
    calculatedAt: string;       // ISO 8601 timestamp
    checksum: string;           // SHA-256 for integrity
    ```

- [ ] **Create ProjectionDrift interface**
  - Location: `apps/web/src/lib/co2-sequestration-projection.ts` (or new file)
  - Fields:
    ```typescript
    export interface ProjectionDrift {
      previousLedger: number;
      currentLedger: number;
      field: string;
      previousValue: number | bigint;
      currentValue: number | bigint;
      percentChange: number;
      isSignificant: boolean;
    }
    ```

- [ ] **Create projection_audits table**
  - Location: Database migration or `scripts/cdc-indexer.ts`
  - Schema:
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
      audit_entry_id VARCHAR
    );
    ```

- [ ] **Create ledger_snapshots table**
  - Location: Database migration
  - Schema:
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

### Phase 2: Comparison Logic (Effort: 3-4 days)

- [ ] **Implement compareProjections() function**
  - Location: `apps/web/src/lib/co2-sequestration-projection.ts` (new function)
  - Logic:
    ```typescript
    export function compareProjections(
      previous: Co2ProjectionResult,
      current: Co2ProjectionResult
    ): ProjectionDrift[] {
      const drifts: ProjectionDrift[] = [];
      const threshold = 0.01; // 1% threshold
      
      const numericFields = ['totalCo2Kg', 'ci95LowKg', 'ci95HighKg', '...'];
      for (const field of numericFields) {
        const prev = previous[field as keyof Co2ProjectionResult];
        const curr = current[field as keyof Co2ProjectionResult];
        const change = Math.abs(curr - prev) / prev;
        if (change > threshold) {
          drifts.push({
            previousLedger: previous.ledgerSequence,
            currentLedger: current.ledgerSequence,
            field,
            previousValue: prev,
            currentValue: curr,
            percentChange: change * 100,
            isSignificant: change > 0.05, // 5% is significant
          });
        }
      }
      return drifts;
    }
    ```

- [ ] **Implement calculateChecksum() function**
  - Location: Same file
  - Logic: SHA-256 hash of JSON-stringified projection
  - Used: For integrity verification and comparison

- [ ] **Integrate comparison with audit logger**
  - Location: `packages/sdk/src/audit.ts`
  - Add action: `"recalculate.projection"`
  - Metadata: Include drift details

### Phase 3: Audit Integration (Effort: 3-4 days)

- [ ] **Add projection audit actions** to AuditAction enum
  - Location: `packages/sdk/src/audit.ts`, line 24-30
  - Add: `"recalculate.projection"`, `"repair.drift"`, `"capture.snapshot"`

- [ ] **Create ProjectionAuditLogger wrapper**
  - Location: New file or extend `AuditLogger`
  - Methods:
    - `recordRecalculation(campaignId, previous, current, drifts, actor, reason)`
    - `recordRepair(campaignId, from, to, actor, reason)`
    - `recordSnapshot(campaignId, ledger, actor)`

- [ ] **Implement recalculateProjection() with audit**
  - Location: Campaign service (e.g., `apps/web/src/services/campaign-impact-leaderboard.service.ts`)
  - Logic:
    ```typescript
    async recalculateProjection(campaignId: string, actor: string, reason: string) {
      const previous = await getProjection(campaignId);
      const current = await calculateProjection(campaignId);
      
      const drifts = compareProjections(previous, current);
      
      await auditLogger.recordRecalculation(
        campaignId, previous, current, drifts, actor, reason
      );
      
      if (drifts.length > 0) {
        // Require repair action, don't silently overwrite
        throw new ProjectionDriftError(drifts);
      }
      
      await storeProjection(current);
    }
    ```

- [ ] **Implement repair action** requiring operator approval
  - Location: Admin API or service layer
  - Logic: Only operator can approve drift repair
  - Audit: Record which drifts were accepted, why

### Phase 4: Snapshot Management (Effort: 2-3 days)

- [ ] **Implement captureSnapshot() function**
  - Location: Campaign service
  - Captures: Full campaign state at specific ledger
  - Stores: In ledger_snapshots table
  - Called: After each major milestone or ledger transition

- [ ] **Implement getSnapshotAt(campaignId, ledger) function**
  - Retrieves snapshot for comparison
  - Used: For audit verification

- [ ] **Add snapshot TTL**
  - Location: Configuration or policy
  - Default: Retain snapshots for 1 year
  - Cleanup: Purge old snapshots via retention manager

### Phase 5: Testing (Effort: 4-5 days)

- [ ] **Add projection comparison tests**
  - Location: `apps/web/src/lib/co2-sequestration-projection.ts` (new test file)
  - Test: Comparing identical projections returns no drifts
  - Test: 1% difference in totalCo2Kg detected as drift
  - Test: Insignificant drifts filtered by threshold

- [ ] **Add drift detection tests**
  - Test: Drift details captured correctly
  - Test: Significance calculated properly
  - Test: Checksum changes with projection changes

- [ ] **Add audit integration tests**
  - Location: Tests for ProjectionAuditLogger
  - Test: Drift recorded in projection_audits table
  - Test: Repair action requires approval

- [ ] **Add snapshot tests**
  - Test: Snapshot captured at correct ledger
  - Test: Snapshot retrieved for comparison
  - Test: Snapshots survive schema updates

- [ ] **Integration test** recalculation → comparison → audit flow
  - Scenario: Recalculate, detect drift, block deployment until repair approved
  - Verification: Audit trail complete

### Phase 6: Monitoring & Alerts (Effort: 1-2 days)

- [ ] **Add drift detection alerts**
  - Alert: When projection drift exceeds threshold
  - Include: Drift details and affected campaigns

- [ ] **Add reconciliation dashboard**
  - Show: Recent projection audits
  - Show: Pending drift repairs
  - Show: Snapshot history

### Acceptance Criteria
- ✅ Projection anchored to ledger_sequence
- ✅ Checksum calculated and stored
- ✅ Comparison logic detects drifts > threshold
- ✅ Drift recorded in projection_audits table
- ✅ Audit trail links to AuditRecord
- ✅ Recalculation blocked if drift detected
- ✅ Repair requires explicit operator approval
- ✅ Snapshots stored and retrievable

---

## Overall Timeline Estimate

| Phase | Objective | Effort | Dependencies |
|-------|-----------|--------|--------------|
| Week 1-2 | Objective 3 (Draft Persistence) | 2-3 weeks | None (CRITICAL PATH) |
| Week 3-4 | Objective 1 (Stable Cursors) | 2-3 weeks | None |
| Week 5-7 | Objective 2 (Failed Event Retention) | 3-4 weeks | Obj 1 (cursors) |
| Week 8-10 | Objective 4 (Projection Comparison) | 3-4 weeks | None |
| Week 11-12 | Integration Testing & Fixes | 1-2 weeks | All objectives |

**Total: 12-14 weeks (3-3.5 months) for full implementation**

---

## Dependencies Between Objectives

```
Objective 3 (Drafts)
  ├─ No dependencies
  └─ Enables: User can draft offline + confirm online

Objective 1 (Cursors)
  ├─ No dependencies
  └─ Enables: Objective 2 (reliable event replay)

Objective 2 (Failed Events)
  ├─ Depends on: Objective 1 (compound cursors)
  └─ Enables: Reliable recovery from transient failures

Objective 4 (Projections)
  ├─ No hard dependencies
  ├─ Should use: Objective 2 (audit logger pattern)
  └─ Complements: Objective 3 (draft → projection confirmation)
```

---

## Risk Assessment & Mitigation

### Objective 1 Risks
- **Risk**: Migration breaks existing event index
- **Mitigation**: Dual-write period, verify no duplicates before cleanup

- **Risk**: Cursor upgrade causes reindexing
- **Mitigation**: Preserve backward compatibility, gradual rollout

### Objective 2 Risks
- **Risk**: Failed event retry loops
- **Mitigation**: Max retry count, exponential backoff, dead letter queue

- **Risk**: Permission changes during replay
- **Mitigation**: Re-check permissions before each retry

### Objective 3 Risks
- **Risk**: Draft lost if storage backend fails
- **Mitigation**: Dual persistence (localStorage + server), auto-backup

- **Risk**: User deploys draft twice (race condition)
- **Mitigation**: Atomic transition, check deployment status on server

### Objective 4 Risks
- **Risk**: Snapshot size grows unbounded
- **Mitigation**: TTL policy, compression, archival

- **Risk**: Drift detection false positives
- **Mitigation**: Configurable threshold, statistical modeling

---

## Success Metrics

### Objective 1
- [ ] Zero duplicate events in production for 30 days
- [ ] Cursor recovery latency < 1 second
- [ ] 100% of events processed exactly once

### Objective 2
- [ ] Failed events recovered within 1 hour
- [ ] Permission checks prevent unauthorized replay
- [ ] Partition isolation prevents cascading failures

### Objective 3
- [ ] User can create draft offline, deploy online
- [ ] Draft restored on page reload 100% of time
- [ ] Deployment blocked if offline (0 offline deployments)

### Objective 4
- [ ] Projection drift detected within 5 minutes
- [ ] All projection changes audited
- [ ] Operator can repair drift with full audit trail
