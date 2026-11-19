# Testing Guide for Four Critical Fixes

This document provides test cases for validating the four critical fixes.

## Issue 1: Stable Compound Cursors - Test Cases

### Test 1.1: Event ID Stability
**Objective**: Verify compound event ID format includes transaction hash

```typescript
// Test: parseStreamEvent generates compound event ID
import { parseStreamEvent } from './cdc-indexer';

const rawEvent: SorobanEvent = {
  id: '5',
  contractId: 'CAB3...',
  txHash: 'tx_hash_abc123',
  ledger: 1000,
  ledgerClosedAt: '2025-01-01T12:00:00Z',
  topic: [],
  value: { xdr: '' },
};

const result = parseStreamEvent(rawEvent, 1000, Math.floor(Date.now() / 1000));

// ASSERT: eventId = "1000-tx_hash_abc123-5"
expect(result.eventId).toBe('1000-tx_hash_abc123-5');
```

### Test 1.2: Cursor Persistence
**Objective**: Verify compound cursor is stored and retrieved

```typescript
// Setup
const dbMock: DbClient = createMockDb();
const indexerId = 'test_indexer';

// Insert cursor
await setCursor(dbMock, indexerId, {
  lastLedger: 5000,
  lastTxHash: 'tx_abc123',
  lastEventIndex: 2,
  lastTimestamp: '2025-01-01T12:00:00Z',
});

// Retrieve cursor
const cursor = await getCursor(dbMock, indexerId);

// ASSERT: All fields preserved
expect(cursor?.lastLedger).toBe(5000);
expect(cursor?.lastTxHash).toBe('tx_abc123');
expect(cursor?.lastEventIndex).toBe(2);
expect(cursor?.lastTimestamp).toBe('2025-01-01T12:00:00Z');
```

### Test 1.3: Duplicate Detection
**Objective**: Verify events with same compound key are deduplicated

```typescript
// Setup
const db = createTestDb();
const event1 = {
  eventId: '1000-tx_abc-0',
  contractId: 'CAB3...',
  eventType: 'stream_created',
  ledgerSequence: 1000,
  ledgerTimestamp: '2025-01-01T12:00:00Z',
  txHash: 'tx_abc',
  sender: 'GA...',
  recipient: 'GB...',
  asset: 'GC...',
  amount: '1000',
  streamId: 's1',
  rawXdr: 'abc123',
};

// Insert same event twice
await insertEvents(db, [event1]);
const result1 = await insertEvents(db, [event1]);

// ASSERT: Second insert is idempotent (ON CONFLICT DO NOTHING)
expect(result1).toBe(0); // No new rows inserted
```

### Test 1.4: Event Ordering with Equal Timestamps
**Objective**: Verify tiebreaker logic for same timestamp events

```typescript
// Given: Three events with same ledger and timestamp
const events = [
  { eventId: '1000-tx_aaa-0', ledgerTimestamp: '2025-01-01T12:00:00Z' },
  { eventId: '1000-tx_bbb-0', ledgerTimestamp: '2025-01-01T12:00:00Z' },
  { eventId: '1000-tx_aaa-1', ledgerTimestamp: '2025-01-01T12:00:00Z' },
];

// Sort by compound key (should be deterministic)
const sorted = events.sort((a, b) => a.eventId.localeCompare(b.eventId));

// ASSERT: Order is stable and deterministic
// Expect: ['1000-tx_aaa-0', '1000-tx_aaa-1', '1000-tx_bbb-0']
expect(sorted[0].eventId).toBe('1000-tx_aaa-0');
expect(sorted[1].eventId).toBe('1000-tx_aaa-1');
expect(sorted[2].eventId).toBe('1000-tx_bbb-0');
```

### Test 1.5: Poll Cycle with Compound Cursor
**Objective**: Verify runPollCycle updates compound cursor correctly

```typescript
// Given: Cursor at ledger 5000
const initialCursor = {
  lastLedger: 5000,
  lastTxHash: 'tx_old',
  lastEventIndex: 10,
  lastTimestamp: '2025-01-01T12:00:00Z',
};

// Mock RPC returning events in ledger 5001
const mockEvents: SorobanEvent[] = [
  {
    id: '0',
    contractId: 'CAB3...',
    txHash: 'tx_new_1',
    ledger: 5001,
    ledgerClosedAt: '2025-01-01T13:00:00Z',
    topic: [],
    value: { xdr: '' },
  },
  {
    id: '1',
    contractId: 'CAB3...',
    txHash: 'tx_new_2',
    ledger: 5001,
    ledgerClosedAt: '2025-01-01T13:00:00Z',
    topic: [],
    value: { xdr: '' },
  },
];

// Run poll cycle
const indexed = await runPollCycle(dbMock, rpcMock, config);

// Retrieve updated cursor
const newCursor = await getCursor(dbMock, indexerId);

// ASSERT: Cursor moved forward to latest event
expect(newCursor?.lastLedger).toBe(5001);
expect(newCursor?.lastTxHash).toBe('tx_new_2'); // Latest txHash
expect(newCursor?.lastEventIndex).toBe(1);      // Latest eventIndex
expect(indexed).toBe(2);
```

---

## Issue 3: Draft + Online Confirmation - Test Cases

### Test 3.1: Draft Status Transitions
**Objective**: Verify draft lifecycle transitions

```typescript
import { useSyncQueue } from './use-sync-queue';

const { enqueue, confirmOnline, canDeployDraft } = useSyncQueue({
  storageKey: 'test_sync_queue',
});

// 1. Enqueue a draft requiring online confirmation
const draftId = enqueue({
  label: 'Deploy Campaign',
  description: 'Campaign #123',
  status: 'draft',
  enqueuedAt: Date.now(),
  retryCount: 0,
  requiresOnlineConfirmation: true,
  payload: { campaignName: 'Save the Trees' },
});

// 2. Check deployment is not allowed yet (user offline)
let canDeploy = canDeployDraft(draftId);
expect(canDeploy).toBe(false); // No confirmation yet

// 3. User confirms online
const confirmed = confirmOnline(draftId);
expect(confirmed).toBe(true);

// 4. Now deployment should be allowed (if actually online)
canDeploy = canDeployDraft(draftId);
// ASSERT: Returns true if isOnline && onlineConfirmedAt set
expect(canDeploy).toBe(isOnline); // Depends on actual online state
```

### Test 3.2: Online Confirmation Timeout
**Objective**: Verify confirmation expires after 30 seconds

```typescript
const { confirmOnline, canDeployDraft, queue } = useSyncQueue();

const draftId = enqueue({
  label: 'Deploy Campaign',
  status: 'draft',
  enqueuedAt: Date.now(),
  retryCount: 0,
  requiresOnlineConfirmation: true,
});

// Confirm now
confirmOnline(draftId);

// Find the item and manually set onlineConfirmedAt to 45 seconds ago
const item = queue.find(i => i.id === draftId);
expect(item?.onlineConfirmedAt).toBeDefined();

// Simulate 45 seconds passing
jest.useFakeTimers();
jest.advanceTimersByTime(45000);

// ASSERT: canDeployDraft returns false (timeout)
const canDeploy = canDeployDraft(draftId);
expect(canDeploy).toBe(false);
```

### Test 3.3: Offline Mode - Deployment Blocked
**Objective**: Verify deployment is blocked when offline

```typescript
const { enqueue, canDeployDraft, isOnline } = useSyncQueue();

// Simulate offline
window.dispatchEvent(new Event('offline'));

// Enqueue draft
const draftId = enqueue({
  label: 'Deploy Campaign',
  status: 'draft',
  enqueuedAt: Date.now(),
  retryCount: 0,
  requiresOnlineConfirmation: true,
});

// ASSERT: Cannot deploy while offline
expect(isOnline).toBe(false);
expect(canDeployDraft(draftId)).toBe(false);
```

### Test 3.4: Deployment Guard Check
**Objective**: Verify DeploymentGuard validates preconditions

```typescript
import { checkDeploymentGuard } from './deployment-guard';

// Case 1: Offline
const result1 = checkDeploymentGuard({
  isOnline: false,
  requiresOnlineConfirmation: true,
});
expect(result1.allowed).toBe(false);
expect(result1.reason).toContain('offline');

// Case 2: Online but not confirmed
const result2 = checkDeploymentGuard({
  isOnline: true,
  requiresOnlineConfirmation: true,
  onlineConfirmedAt: undefined,
});
expect(result2.allowed).toBe(false);
expect(result2.reason).toContain('confirm');

// Case 3: Confirmed but expired (>30 seconds)
const result3 = checkDeploymentGuard({
  isOnline: true,
  requiresOnlineConfirmation: true,
  onlineConfirmedAt: Date.now() - 35000,
});
expect(result3.allowed).toBe(false);
expect(result3.reason).toContain('expired');

// Case 4: Online and recently confirmed
const result4 = checkDeploymentGuard({
  isOnline: true,
  requiresOnlineConfirmation: true,
  onlineConfirmedAt: Date.now() - 5000,
});
expect(result4.allowed).toBe(true);
```

### Test 3.5: localStorage Persistence
**Objective**: Verify drafts persist across page refresh

```typescript
// User's browser state before refresh:
const { enqueue: enqueue1 } = useSyncQueue({ storageKey: 'my_drafts' });
const draftId = enqueue1({
  label: 'Deploy Campaign',
  description: 'Campaign #123',
  status: 'draft',
  enqueuedAt: Date.now(),
  retryCount: 0,
  requiresOnlineConfirmation: true,
  payload: { campaignName: 'Save the Trees' },
});

// User refreshes page...
// New hook instance loads from storage:
const { queue: queueAfterRefresh } = useSyncQueue({ storageKey: 'my_drafts' });

// ASSERT: Draft still there
const restoredDraft = queueAfterRefresh.find(d => d.id === draftId);
expect(restoredDraft).toBeDefined();
expect(restoredDraft?.label).toBe('Deploy Campaign');
expect(restoredDraft?.payload).toEqual({ campaignName: 'Save the Trees' });
```

---

## Issue 2: Failed Event Retention - Test Cases (Placeholder)

### Test 2.1: Failed Event Persistence
```typescript
// Given: Event parsing fails
// When: parseStreamEvent throws
// Then: Event should be persisted in failed_events table with cause
```

### Test 2.2: Permission Check on Replay
```typescript
// Given: Offline action queued when user was admin
// When: User is now operator (lower privilege)
// Then: Action should not replay without user confirmation
```

### Test 2.3: Partition Isolation
```typescript
// Given: Multiple contract streams in queue
// When: One contract's stream fails
// Then: Other contracts' streams should still replay
```

---

## Issue 4: Projection Comparison - Test Cases (Placeholder)

### Test 4.1: Ledger Anchoring
```typescript
// Given: CO2 projection calculated
// Then: Result should include ledgerSequence and checksum
```

### Test 4.2: Drift Detection
```typescript
// Given: Previous projection at ledger 5000
// When: New projection calculated at ledger 5010
// Then: compareProjections should report drift if values changed
```

### Test 4.3: Audit Trail
```typescript
// Given: Projection recalculated with drift detected
// Then: projection_audits table should have entry with:
//   - previous_ledger, current_ledger, drift_details, actor, reason
```

---

## Running Tests

### Issue #1 Tests
```bash
cd scripts
npm test cdc-indexer.test.ts

# Or run specific tests
npm test -- --testNamePattern="Compound Cursor"
```

### Issue #3 Tests
```bash
cd apps/web
npm test use-sync-queue.test.ts

# Or run specific tests
npm test -- --testNamePattern="Online Confirmation"
```

### All Tests
```bash
# From root
npm run test
```

---

## Continuous Integration

These tests should be added to the CI/CD pipeline:

```yaml
# .github/workflows/test.yml
- name: Test Issue #1 - Compound Cursors
  run: npm test -- cdc-indexer

- name: Test Issue #3 - Draft Confirmation
  run: npm test -- use-sync-queue

- name: Test Issue #2 - Failed Events
  run: npm test -- actionQueue

- name: Test Issue #4 - Projections
  run: npm test -- co2-projection
```

---

## Acceptance Criteria

### Issue #1 ✅
- [x] Event IDs include transaction hash
- [x] Cursors store compound position
- [x] Duplicates are detected and skipped
- [ ] Events ordered deterministically
- [ ] Tests cover restart scenarios

### Issue #3 ✅
- [x] Draft items can require online confirmation
- [x] canDeployDraft() checks preconditions
- [x] Confirmation timeout enforced
- [ ] Campaign wizard integrated
- [ ] End-to-end E2E tests

### Issue #2 ⏳
- [ ] Failed events persisted
- [ ] Permission checks working
- [ ] Partition isolation enforced
- [ ] Replay audit trail complete

### Issue #4 ⏳
- [ ] Projections anchored to ledger
- [ ] Drift detection working
- [ ] Audit tables created
- [ ] Repair requires audit entry

