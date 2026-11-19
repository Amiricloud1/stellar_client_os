# Issue Analysis: Detailed File Reference and Code Locations

This document provides a quick reference to key files, line numbers, and implementation details for each of the four objectives.

---

## OBJECTIVE 1: Stable Compound Cursors — File Reference

### Primary Implementation Files

#### `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` (45,615 bytes)

**Event ID Generation**
- **Line 420-428**: `parseStreamEvent()` function
  - Creates `eventId = <ledger>-<txIndex>-<eventIndex>`
  - Current format does NOT include transaction hash
  - Issue: Insufficient for deduplication across concurrent submissions

```typescript
// Current (insufficient):
const eventId = `${ledgerSequence}-${rawEvent.id ?? "0"}`;

// Should be (sufficient):
const eventId = `${ledgerSequence}-${txHash}-${rawEvent.id ?? "0"}`;
```

**Database Schema (Cursor Management)**
- **Line 45-68**: `stream_events` table definition
  - `event_id TEXT NOT NULL UNIQUE` — Natural key for dedup
  - Missing: Composite unique index on (ledger_sequence, tx_hash, event_index)

- **Line 72-82**: `cdc_cursors` table definition
  - Tracks only `last_ledger` per indexer
  - Missing: `last_tx_hash`, `last_event_index` for granular resumption

**Cursor Functions**
- **Line 237-243**: `getCursor(db, indexerId)` — Retrieves last ledger
  - Returns: `number | null` (only ledger sequence)
  - Limitation: Cannot distinguish events within same ledger

- **Line 246-256**: `setCursor(db, indexerId, lastLedger)` — Persists cursor
  - Updates only `last_ledger`
  - Missing: Update compound cursor fields

**Polling Logic**
- **Line 475-485**: `runPollCycle()` — Main indexing loop
  - Line 483: Determines `startLedger` based only on cursor
  - Missing: Resume logic for partial ledger processing

#### `/workspaces/stellar_client_os/scripts/cdc-indexer.test.ts` (19,444 bytes)

**Cursor Tests**
- **Line 203-211**: `describe("getCursor")` test suite
  - Tests: cursor retrieval and null case
  - Missing: Tests for cursor stability across restarts with duplicate events

- **Line 213-219**: `describe("setCursor")` test suite
  - Tests: UPSERT query parameters
  - Missing: Tests for compound cursor updates

**Event ID Tests**
- **Line 159-165**: `describe("parseStreamEvent")`
  - Line 160-163: Tests that `eventId = <ledger>-<txIndex>`
  - Missing: Tests for collision resistance with concurrent events

### Supporting Files

#### `/workspaces/stellar_client_os/issue-873-event-dedup-wiring.patch`
- Removes unbounded `seenEvents` Set (memory leak)
- Replaces with bounded `EventDedupCache`
- **Issue**: Does NOT address compound cursor stability
- Missing: Cursor format upgrade

---

## OBJECTIVE 2: Failed Event Retention with Replay — File Reference

### Primary Implementation Files

#### `/workspaces/stellar_client_os/packages/sdk/src/audit.ts` (2,000+ bytes)

**Audit Record Schema**
- **Line 42-53**: `AuditRecord` interface
  ```typescript
  export interface AuditRecord extends AuditRecordParams {
    id: string;
    timestamp: string; // ISO 8601 UTC
    outcome: AuditOutcome; // "ALLOWED" or "DENIED"
    reason?: string;
  }
  ```
  - Current: Records action outcome but not failure category
  - Missing: `failureCategory?: "NETWORK" | "PERMISSION" | "VALIDATION" | "INTERNAL"`

**Access Policy**
- **Line 63-86**: `DEFAULT_ACCESS_POLICY` implementation
  - Controls who can perform which actions
  - Limitation: Static policy; does not check if permissions were revoked between retry attempts

**Audit Logger**
- **Line 88+**: `AuditLogger` class (not shown in excerpt)
  - Likely implements `record(params: AuditRecordParams): AuditRecord`

#### `/workspaces/stellar_client_os/packages/sdk/src/__tests__/audit.test.ts`

**Audit Tests**
- Tests for access policy and audit logging
- Missing: Tests for failed event retention and replay scenarios

#### `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts` (286 lines)

**Idempotent Action Queue**
- **Line 45**: Action status type definition
  ```typescript
  export type ActionStatus = "pending" | "in-flight" | "failed";
  ```

**QueuedAction Schema**
- **Line 54-68**: Interface
  - `operationId: string` — Stable ID for idempotency
  - `attemptCount: number` — Retry tracking
  - `status: ActionStatus` — Current state
  - Missing: `failureReason?: string` or `failureCategory?: string`

**Queue Operations**
- **Line 152-164**: `markFailed(operationId)` — Marks for replay
  - Sets status to "failed"
  - Does NOT record failure reason

- **Line 291-321**: `flushActionQueue()` — Replays actions
  ```typescript
  for (const action of actions) {
    await queue.markInFlight(action.operationId);
    try {
      await handler(action);
      await queue.dequeue(action.operationId);
      succeeded++;
    } catch (error) {
      await queue.markFailed(action.operationId);
      failed++;
    }
  }
  ```
  - Missing: Permission check before calling handler
  - Missing: Partition isolation (stops on first failure)
  - Missing: Failure categorization

#### `/workspaces/stellar_client_os/apps/mobile/src/offline/__tests__/actionQueue.test.ts`

**Action Queue Tests**
- Tests basic queue operations (enqueue, dequeue, etc.)
- Missing: Tests for permission checks and partition isolation

#### `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` (continued)

**Failed Event Handling**
- **Line 528**: Error handling during event parsing
  ```typescript
  } catch (err) {
    log("warn", "Failed to parse event — skipping", {
      eventId: raw.id,
      error: (err as Error).message,
    });
  }
  ```
  - Current: Logs and skips failed events
  - Missing: Persists failed events with retry count and cause
  - Missing: `failed_events` table and replay logic

**Event Insertion**
- **Line 289-315**: `insertEvents()` function
  - Current: UPSERT on `event_id` (idempotent)
  - Missing: Error handling for failed insertions (logs only)

### Supporting Files

#### `/workspaces/stellar_client_os/packages/sdk/src/retention.ts` (324 lines)

**Retention Manager**
- **Line 190-248**: `RetentionManager.scheduleDeletion()`
  - Manages personal record deletion
  - Missing: Integration with failed event cleanup

- **Line 251-258**: `purgeDeletionRecordsOlderThan()`
  - Purges old deletion records
  - Could be adapted for failed event TTL

#### `/workspaces/stellar_client_os/apps/mobile/src/offline/__tests__/`

- `sync.test.ts` — Sync operation tests
- `offlineFlow.test.ts` — Offline workflow tests
- Missing: Tests for failed event retention and replay with permission checks

---

## OBJECTIVE 3: Draft Persistence with Offline Confirmation — File Reference

### Primary Implementation Files

#### `/workspaces/stellar_client_os/apps/mobile/src/offline/storage.ts` (83 lines)

**Storage Interface**
- **Line 14-22**: `KeyValueStorage` interface
  ```typescript
  export interface KeyValueStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }
  ```

**Storage Configuration**
- **Line 46-49**: `configureOfflineStorage(storage)` — Register backend
- **Line 52-55**: `getOfflineStorage()` — Get configured or in-memory store

**JSON Helpers**
- **Line 74-82**: `readJSON()` and `writeJSON()` — Serialization
  - Used by action queue and cache modules

#### `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.ts` (450+ lines)

**Sync Queue Item Schema**
- **Line 41-74**: `SyncQueueItem` interface
  - `status: SyncItemStatus` — pending | syncing | synced | failed | conflict
  - `payload?: unknown` — Preserves user input
  - Missing: `draftStatus: "editing" | "offline_saved" | "online_confirmed" | "deployed"`

**Online State Tracking**
- **Line 180**: `isOnline: boolean` — Part of `SyncQueueState`
  - Current: Tracks online status
  - Missing: Used in deployment logic check

**Queue Operations**
- **Line 246-260**: `loadQueue()` and `saveQueue()` — localStorage persistence
- **Line 294-306**: `enqueue()` — Add draft to queue
- **Line 327-333**: `updatePayload()` — Update draft without losing state

**Sync Handler**
- **Line 380-420**: Sync logic (partial view)
  - Missing: Online confirmation gate before deployment

#### `/workspaces/stellar_client_os/apps/web/src/services/contract.deployer.ts`

**Deployment Service** (location inferred, not fully read)
- Missing: Check for `isOnline` before allowing deployment
- Missing: Check for `draftStatus === "online_confirmed"` before deployment

#### `/workspaces/stellar_client_os/apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx`

**Campaign Wizard** (location inferred)
- Missing: Draft auto-save on form changes
- Missing: Draft restoration from localStorage on mount
- Missing: Draft lifecycle management UI

### Supporting Files

#### `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts` (continued)

**Action Status Lifecycle**
- **Line 45**: Defines `ActionStatus` type
  - Current: "pending" | "in-flight" | "failed"
  - Missing: "draft" status or explicit draft semantics

#### `/workspaces/stellar_client_os/apps/mobile/src/offline/__tests__/`

- `actionQueue.test.ts` — Queue operation tests
- `offlineFlow.test.ts` — Offline workflow tests
- `sync.test.ts` — Sync operation tests
- Missing: Draft persistence and online confirmation tests

#### `/workspaces/stellar_client_os/apps/web/src/__tests__/deployment-docs.test.ts`

**Deployment Tests**
- Tests deployment lifecycle
- Missing: Draft persistence and offline confirmation requirements

---

## OBJECTIVE 4: Projection Comparison and Audit — File Reference

### Primary Implementation Files

#### `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts` (200+ lines)

**Projection Output Schema**
- **Line 95-115**: `Co2ProjectionResult` interface
  ```typescript
  export interface Co2ProjectionResult {
    speciesId: string;
    speciesLabel: string;
    initialTreeCount: number;
    treeAgeYears: number;
    climateScenario: string;
    horizonYears: number;
    totalCo2Kg: number;
    totalCo2Tonnes: number;
    ci95LowKg: number;
    ci95HighKg: number;
    annualMortalityRate: number;
    dataPoints: ProjectionDataPoint[];
  }
  ```
  - Missing: `ledgerSequence: number` — Anchor to specific ledger
  - Missing: `calculatedAt: string` — ISO 8601 timestamp
  - Missing: `checksum?: string` — For drift detection

**Projection Input**
- **Line 65-85**: `Co2ProjectionInput` interface
  - Current: Accepts species, tree count, age, horizon, climate scenario
  - Missing: `ledgerSequence?: number` — Allow pinning to specific ledger

**Data Points**
- **Line 87-95**: `ProjectionDataPoint` interface
  - Includes annual and cumulative CO2, confidence intervals
  - Missing: Reference to ledger or projection ID for audit trail

#### `/workspaces/stellar_client_os/packages/sdk/src/__tests__/bindings-drift.test.ts` (113 lines)

**Drift Detection (for WASM bindings, not applicable to projections)**
- **Line 12-113**: Tests for `detectBindingsDrift()`
  - Compares contract source mtime to generated bindings mtime
  - Different use case from projection comparison
  - **Not applicable**: This is for contract bindings, not state projections

#### `/workspaces/stellar_client_os/apps/web/src/services/campaign-verification-audit.service.ts`

**Campaign Verification Audit** (location inferred, file name suggests it exists)
- Likely tracks verification events (submission, review, approval)
- Missing: Integration with projection drift detection
- Missing: Cross-reference to projection audits

#### `/workspaces/stellar_client_os/packages/sdk/src/audit.ts` (continued)

**Audit Action Types**
- **Line 24-30**: `AuditAction` enum
  ```typescript
  export type AuditAction =
    | "deploy.contract"
    | "initialize.contract"
    | "rotate.credential"
    | "delete.personal_record"
    | "export.personal_data"
    | "modify.retention_policy";
  ```
  - Missing: Projection-specific actions like "recalculate.projection", "repair.drift"

#### `/workspaces/stellar_client_os/apps/web/src/services/campaign-impact-leaderboard.service.ts`

**Campaign Impact Service** (location inferred)
- Likely calculates and caches impact data
- Missing: Ledger snapshot logic
- Missing: Drift detection on impact recalculation

### Supporting Files

#### `/workspaces/stellar_client_os/packages/sdk/src/retention.ts` (continued)

**Retention Policy**
- **Line 142-178**: `RetentionPolicy` class
  - Could be adapted for projection snapshot retention
  - Missing: Integration with projection drift audit

---

## Database Schema Locations

### Existing Schemas

#### `/workspaces/stellar_client_os/scripts/cdc-indexer.ts`

**Stream Events** (Line 45-68)
```sql
CREATE TABLE IF NOT EXISTS stream_events (
  id BIGSERIAL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  ledger_timestamp TIMESTAMPTZ NOT NULL,
  tx_hash TEXT NOT NULL,
  sender TEXT,
  recipient TEXT,
  asset TEXT,
  amount NUMERIC,
  stream_id TEXT,
  raw_xdr TEXT NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**CDC Cursors** (Line 72-82)
```sql
CREATE TABLE IF NOT EXISTS cdc_cursors (
  indexer_id TEXT PRIMARY KEY,
  last_ledger BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Needed Schemas

**Failed Events** (for Objective 2)
- Not currently in codebase
- Recommended location: `scripts/cdc-indexer.ts` (ensureSchema function)

**Projection Audits** (for Objective 4)
- Not currently in codebase
- Recommended location: Database migrations directory or web app initialization

**Ledger Snapshots** (for Objective 4)
- Not currently in codebase
- Recommended location: Database migrations directory

---

## Test Coverage by Objective

### Tests Exist
- ✅ Cursor operations: `cdc-indexer.test.ts` (getCursor, setCursor)
- ✅ Audit logging: `audit.test.ts` (access policy, record creation)
- ✅ Action queue: `actionQueue.test.ts` (enqueue, dequeue, mark failed)
- ✅ Storage: `encryptedStorage.test.ts` (key-value operations)
- ✅ Sync queue: `use-sync-queue.test.ts` (queue CRUD)
- ✅ Bindings drift: `bindings-drift.test.ts` (WASM binding staleness)

### Tests Missing
- ❌ Compound cursor stability across restarts
- ❌ Duplicate event prevention with concurrent indexing
- ❌ Failed event retention and replay with permission checks
- ❌ Partition isolation in action queue
- ❌ Draft persistence and offline confirmation
- ❌ Draft auto-save in campaign wizard
- ❌ Projection comparison and drift detection
- ❌ Ledger snapshot consistency
- ❌ Audit trail for projection repairs

---

## Environment Variables and Configuration

### CDC Indexer Configuration (`cdc-indexer.ts`)

**Required**
- `DATABASE_URL` — PostgreSQL connection string
- `CONTRACT_IDS` — Comma-separated Soroban contract IDs

**Optional (with defaults)**
- `STELLAR_RPC_URL` — Default: "https://soroban-testnet.stellar.org"
- `NETWORK_PASSPHRASE` — Default: "Test SDF Network ; September 2015"
- `POLL_INTERVAL_SECONDS` — Default: 5
- `LEDGER_LOOKBACK` — Default: 1000
- `MAX_EVENTS_PER_POLL` — Default: 200
- `INDEXER_ID` — Default: "fundable_stream_indexer"
- `DRY_RUN` — Default: false

### Offline Storage Configuration

**Mobile** (`apps/mobile/src/offline/storage.ts`)
- `configureOfflineStorage(storage)` — Must be called with AsyncStorage or equivalent

**Web** (`apps/web/src/hooks/use-sync-queue.ts`)
- `storageKey` — Default: "fundable_sync_queue" (localStorage key)

---

## Quick Navigation

### By Objective
- **Objective 1**: `scripts/cdc-indexer.ts` (lines 420-428, 237-256)
- **Objective 2**: `packages/sdk/src/audit.ts` (lines 42-86), `apps/mobile/src/offline/actionQueue.ts` (lines 45-321)
- **Objective 3**: `apps/web/src/hooks/use-sync-queue.ts` (lines 41-74, 380-420), `apps/mobile/src/offline/storage.ts` (lines 14-55)
- **Objective 4**: `apps/web/src/lib/co2-sequestration-projection.ts` (lines 65-115), `packages/sdk/src/audit.ts` (lines 24-30)

### By File
- **CDC Indexer**: `scripts/cdc-indexer.ts`, `scripts/cdc-indexer.test.ts`
- **Audit Layer**: `packages/sdk/src/audit.ts`, `packages/sdk/src/__tests__/audit.test.ts`
- **Offline Storage**: `apps/mobile/src/offline/storage.ts`, `apps/mobile/src/offline/actionQueue.ts`
- **Sync Queue**: `apps/web/src/hooks/use-sync-queue.ts`, `apps/web/src/hooks/use-sync-queue.test.ts`
- **Projections**: `apps/web/src/lib/co2-sequestration-projection.ts`
- **Deployment**: `apps/web/src/services/contract.deployer.ts`

---

## Related Documentation

- `/workspaces/stellar_client_os/docs/privileged-action-audit.md` — Audit logging design
- `/workspaces/stellar_client_os/docs/campaign-verification.md` — Campaign verification audit trail
- `/workspaces/stellar_client_os/docs/sdk/waitForTransaction.md` — Transaction handling and errors
- `/workspaces/stellar_client_os/apps/mobile/OFFLINE.md` — Mobile offline strategy
- `/workspaces/stellar_client_os/apps/mobile/ACCESSIBILITY.md` — Mobile accessibility (related to draft UX)

---

## Key Takeaways

1. **Objective 1 (Cursors)**: Modify event ID format and extend cursor schema in `cdc-indexer.ts`
2. **Objective 2 (Retention)**: Add failure categorization to audit, permission checks to action queue, failed_events table to indexer
3. **Objective 3 (Drafts)**: Implement online confirmation gate, draft lifecycle, and auto-save in wizard
4. **Objective 4 (Projections)**: Add ledger anchor to projection schema, implement comparison logic, create audit tables

All four objectives require comprehensive test coverage and database schema updates.
