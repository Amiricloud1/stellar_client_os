# Four Critical Issues - Complete Implementation Guide

This repository now contains fixes for four critical issues affecting reliability, safety, and auditability of the Stellar Client OS platform.

## Executive Summary

| Issue | Status | Impact | Risk If Not Fixed |
|-------|--------|--------|-------------------|
| **1. Stable Compound Cursors** | ✅ DONE | Prevents event duplication | Events processed multiple times, duplicate payments |
| **2. Failed Event Retention** | ⏳ QUEUED | Enables auditable recovery | Lost failed events, no replay capability |
| **3. Draft + Online Confirmation** | ✅ DONE | **PREVENTS OFFLINE DEPLOYMENT** | **Deployments while offline, lost transactions** |
| **4. Projection Comparison** | ⏳ QUEUED | Enables drift audit trail | Silent state corruption, undetectable drift |

---

## Issue 1: Stable Compound Cursors ✅ FIXED

### What It Fixes
- **Problem**: Events could be duplicated or reordered if they had equal timestamps and concurrent ingestion
- **Root Cause**: Event IDs only used ledger sequence, not transaction hash
- **Solution**: Compound cursor uses `<ledger>-<txHash>-<eventIndex>` for stable deduplication

### Files Changed
- `scripts/cdc-indexer.ts` - Implemented compound cursor tracking
- `DATABASE_MIGRATIONS.md` - Migration 001 adds cursor columns

### How It Works
1. Event ID now includes transaction hash: `1000-tx_abc123-5` instead of `1000-5`
2. Cursor stores: ledger, txHash, eventIndex, timestamp
3. Events with same timestamp are ordered by txHash, then eventIndex
4. Prevents reordering and duplicate processing

### Verification
```bash
# After applying migration 001:
psql $DATABASE_URL -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'cdc_cursors'
  ORDER BY ordinal_position;
"
# Should show: last_tx_hash, last_event_index, last_timestamp
```

### Testing
See TESTING_FIXES.md - Test Cases 1.1 through 1.5

---

## Issue 2: Failed Event Retention with Replay ⏳ QUEUED

### What It Fixes
- **Problem**: Failed events are lost; no way to replay them later
- **Root Cause**: No persistence layer for failed events
- **Solution**: Create `failed_events` table with retry state, permission checks, and partition isolation

### Files to Create/Modify
- `scripts/cdc-indexer.ts` - Add failed event persistence and replay logic
- `apps/mobile/src/offline/actionQueue.ts` - Add permission checks before replay
- `DATABASE_MIGRATIONS.md` - Migration 002 creates failed_events tables

### Implementation Needed
1. Persist failed events with cause and error message
2. Track retry attempts and backoff
3. Check permissions before replay
4. Isolate failures by partition (contract, stream, campaign)
5. Audit replay attempts

### Test Cases in TESTING_FIXES.md
- Test 2.1: Failed Event Persistence
- Test 2.2: Permission Check on Replay
- Test 2.3: Partition Isolation

---

## Issue 3: Draft Persistence with Offline Confirmation ✅ FIXED

### What It Fixes
- **Problem**: Campaigns could be deployed while offline, causing sync issues
- **Root Cause**: No guard preventing deployment without online confirmation
- **Solution**: Require explicit online confirmation before deployment

### Files Changed
- `apps/web/src/hooks/use-sync-queue.ts` - Added online confirmation tracking
- `apps/web/src/services/contract.deployer.ts` - Updated for guard support
- `apps/web/src/services/deployment-guard.ts` - NEW: Deployment precondition checks

### How It Works
1. Draft items can be flagged with `requiresOnlineConfirmation: true`
2. Before deployment, `canDeployDraft()` checks:
   - User is online
   - Confirmation timestamp is recent (within 30 seconds)
3. Deployment blocked until both conditions met

### Usage in Campaign Wizard
```typescript
const { canDeployDraft, confirmOnline } = useSyncQueue();

// When user clicks "Deploy Campaign"
if (!canDeployDraft(draftId)) {
  // Show dialog: "Please confirm you are online"
  const confirmed = await showConfirmationDialog();
  if (confirmed) {
    confirmOnline(draftId);
  }
  return;
}

// Now safe to deploy
await deployCampaign(draftId);
```

### Deployment Guard
New utility in `deployment-guard.ts`:
```typescript
import { checkDeploymentGuard } from '@/services/deployment-guard';

const result = checkDeploymentGuard({
  isOnline: navigator.onLine,
  requiresOnlineConfirmation: true,
  onlineConfirmedAt: draft.onlineConfirmedAt,
});

if (!result.allowed) {
  showError(result.reason); // "Please confirm you are online..."
}
```

### Verification
```bash
# Check hooks are updated
grep -n "confirmOnline\|canDeployDraft" \
  apps/web/src/hooks/use-sync-queue.ts

# Should output: Both methods present with implementations
```

### Testing
See TESTING_FIXES.md - Test Cases 3.1 through 3.5

---

## Issue 4: Projection Comparison and Audit ⏳ QUEUED

### What It Fixes
- **Problem**: CO2 projections could silently diverge between calculations
- **Root Cause**: No ledger anchoring or drift tracking
- **Solution**: Anchor projections to ledger, compare versions, require audit for changes

### Files to Modify
- `apps/web/src/lib/co2-sequestration-projection.ts` - Add ledger anchoring
- `packages/sdk/src/audit.ts` - Add projection audit actions
- `DATABASE_MIGRATIONS.md` - Migration 003 creates audit tables

### Implementation Needed
1. Add `ledgerSequence` to projection results
2. Implement `compareProjections()` function
3. Create `projection_audits` table for repair trail
4. Create `ledger_snapshots` table for rollback capability
5. Mandate audit entry before recalculation

### How It Works
```typescript
// Calculate projection with ledger anchor
const projection = await calculateProjection(campaignId, ledger);
// Result includes: ledgerSequence, calculatedAt, checksum

// Compare with previous
const drifts = compareProjections(previous, current);

// If drifts detected, audit before accepting
if (drifts.length > 0) {
  await auditProjectionDrift(campaignId, previous, current, actor);
}

// Require second approval for critical repairs
if (criticalDrift) {
  projection.status = 'PENDING_APPROVAL';
  projection.approvedBy = secondaryApprover;
}
```

### Test Cases in TESTING_FIXES.md
- Test 4.1: Ledger Anchoring
- Test 4.2: Drift Detection
- Test 4.3: Audit Trail

---

## Implementation Roadmap

### Phase 1: Foundation (Done) ✅
- [x] Issue #1: Compound cursors - Prevents event duplication
- [x] Issue #3: Offline confirmation - **CRITICAL** - Prevents data loss

### Phase 2: Recovery (Ready to Start) ⏳
- [ ] Issue #2: Failed event retention - Start after Phase 1 tests pass
- [ ] Issue #4: Projection comparison - Can run in parallel with Phase 2

### Recommended Timeline
1. **Week 1-2**: Validate Issue #1 and #3 implementations
   - Run test suite (TESTING_FIXES.md)
   - Deploy to staging
   - Monitor CDC indexer and draft sync behavior

2. **Week 3-4**: Implement Issue #2
   - Create failed_events tables (Migration 002)
   - Add replay with permission checks
   - Implement partition isolation
   - Write tests

3. **Week 5-6**: Implement Issue #4
   - Create projection audit tables (Migration 003)
   - Add ledger anchoring to projections
   - Implement drift detection
   - Write tests and auditors

---

## Deployment Checklist

### Before Deploying Issue #1 and #3

- [ ] Run full test suite: `npm test`
- [ ] Check TypeScript compilation: `npm run type-check`
- [ ] Review code changes:
  - `scripts/cdc-indexer.ts` (compound cursors)
  - `apps/web/src/hooks/use-sync-queue.ts` (draft confirmation)
  - `apps/web/src/services/deployment-guard.ts` (new file)
- [ ] Backup database before migration
- [ ] Apply migration 001 to staging: `psql $DATABASE_URL < migrations/001_extend_cdc_cursors_for_compound_keys.sql`
- [ ] Test CDC indexer restart scenarios
- [ ] Test draft deployment flow offline/online
- [ ] Deploy to staging, monitor logs
- [ ] Run smoke tests on staging
- [ ] Deploy to production

### Before Deploying Issue #2

- [ ] Issue #1 and #3 deployed and stable (1+ week)
- [ ] Failed event tests passing
- [ ] Permission system tested
- [ ] Apply migration 002
- [ ] Deploy with feature flag to canary group
- [ ] Monitor replay behavior
- [ ] Audit failed event retries

### Before Deploying Issue #4

- [ ] Issue #2 deployed and stable
- [ ] Projection comparison tests passing
- [ ] Audit framework integrated
- [ ] Apply migration 003
- [ ] Deploy with monitoring on drift detection
- [ ] Verify audit trail generation

---

## Monitoring and Observability

### Key Metrics to Track

#### Issue #1
```
cdc_indexer_duplicate_events_skipped      # Should be 0 after fix
cdc_indexer_compound_cursor_position      # Should advance smoothly
cdc_indexer_poll_cycle_duration_seconds   # Should be stable
```

#### Issue #3
```
draft_deployments_blocked_offline         # Count of prevented offline deploys
draft_online_confirmation_timeout         # Confirmations that expired
campaign_deployment_guard_failures        # Deployment rejections
```

#### Issue #2
```
failed_events_persisted_total             # Retryable events stored
failed_events_replayed_successful         # Successful replays
failed_events_permission_denied           # Replay permission failures
failed_events_partition_failures          # Partitions in failed state
```

#### Issue #4
```
projection_drifts_detected_total          # Drift events recorded
projection_recalculations_with_audit      # Audited recalculations
projection_drift_percent_max              # Maximum drift % seen
```

### Log Patterns to Monitor

```bash
# Issue #1: Watch for duplicate event warnings
grep -i "duplicate.*skipped" logs/cdc-indexer.log

# Issue #3: Watch for deployment blocks
grep -i "online.*confirmation\|deployment.*blocked" logs/web.log

# Issue #2: Watch for replay activity
grep -i "failed_event\|replay.*attempt" logs/indexer.log

# Issue #4: Watch for drift alerts
grep -i "projection.*drift\|drift.*detected" logs/web.log
```

---

## Troubleshooting

### Issue #1 Troubleshooting
**Symptom**: CDC indexer keeps reprocessing same events
- Check: `SELECT last_tx_hash, last_event_index FROM cdc_cursors`
- If NULL: First run; normal behavior
- If not advancing: Debug cursor update logic

**Symptom**: High memory usage on long-running indexer
- Still using unbounded Set? Check `parseStreamEvent()` for `seenEvents`
- Should only use bounded `EventDedupCache`

### Issue #3 Troubleshooting
**Symptom**: Draft deployments still allowed while offline
- Check: `canDeployDraft()` implementation in use-sync-queue.ts
- Verify: `requiresOnlineConfirmation: true` set on draft
- Check: Browser `navigator.onLine` working correctly

**Symptom**: Users can't deploy even when online
- Confirmation timed out after 30 seconds
- User must click confirmation again
- By design - prevents accidental deployment

---

## Documentation Files

- **FIXES_SUMMARY.md** - Quick overview of what changed
- **TESTING_FIXES.md** - Complete test cases for all four issues
- **DATABASE_MIGRATIONS.md** - SQL migrations and setup instructions
- **IMPLEMENTATION_FIXES.md** - Implementation details and status
- **This file** - Complete guide and deployment instructions

---

## Support and Questions

For questions about these fixes:

1. Check the relevant test case in TESTING_FIXES.md
2. Review code comments in modified files
3. See IMPLEMENTATION_FIXES.md for architecture details
4. Run tests: `npm test -- --testNamePattern="Issue"`

---

## Related Issues

- Issue #531: Soroban Stream Event CDC Indexer
- Issue #078: Event deduplication bounded cache
- Issue #873: Event dedup wiring
- Issue #528, #73: Offline-first PWA sync queue
- Issue #109: Audit logging framework
- Issue #617: Soroban SDK upgrade

---

## Summary

These four fixes address critical gaps in reliability, safety, and auditability:

1. **Compound cursors**: Prevent event duplication from concurrent ingestion
2. **Failed event retention**: Enable auditable recovery without blocking other actions
3. **Draft + online confirmation**: **Prevent accidental offline deployment** (CRITICAL)
4. **Projection comparison**: Enable drift detection and require auditable repairs

Issues #1 and #3 are complete and ready for deployment. Issues #2 and #4 are queued for Phase 2 implementation.

For deployment instructions, see **Deployment Checklist** above.

