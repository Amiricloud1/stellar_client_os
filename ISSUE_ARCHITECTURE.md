# Four Issues: Architecture & Implementation Map

## Visual Component Relationships

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          STELLAR CLIENT STACK                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  📱 UI Layer (apps/web/src)                                                  │
│  ├─ useTransactionGuard (MutationStatus)                    [Issue 4]       │
│  ├─ use-sync-queue (SyncItemStatus + Error Categories)      [Issue 4]       │
│  └─ Components receiving OnChainState                       [Issue 4]       │
│                                                                               │
│  ↓                                                                            │
│                                                                               │
│  🔗 API Layer (apps/web/src/app/api)                                         │
│  ├─ /api/campaigns/* (CampaignStatus enum)                  [Issue 4]       │
│  ├─ /api/offramp/* (PayoutStatus)                           [Issue 4]       │
│  ├─ [Missing: /api/capabilities]                            [Issue 2]       │
│  ├─ [Missing: /api/coverage/{network}]                      [Issue 1]       │
│  └─ [Need: standardized response envelope]                  [Issue 4]       │
│                                                                               │
│  ↓                                                                            │
│                                                                               │
│  📊 Services Layer (apps/web/src/services)                                   │
│  ├─ campaign-progress-cache.service                         [Issue 3]       │
│  │   └─ CampaignProgressMetrics (no ledger binding)                          │
│  ├─ event-aggregator.service (file-based, not atomic)       [Issue 3]       │
│  ├─ campaign-sponsorship-receipt.service (local state)      [Issue 4]       │
│  ├─ batch-verification.service (local state)                [Issue 4]       │
│  └─ [Missing: ProjectionService (cursor-atomic)]            [Issue 3]       │
│                                                                               │
│  ↓                                                                            │
│                                                                               │
│  🗄️  Persistence Layer (PostgreSQL)                                          │
│  ├─ campaigns (state, updated_at)                           [Issue 3]       │
│  ├─ webhook_subscriptions (idempotency_key)                 [Issue 3]       │
│  ├─ webhook_delivery_attempts (append-only)                 [Issue 3]       │
│  ├─ stream_events (event_id UNIQUE)                         [Issue 1]       │
│  ├─ cdc_cursors (last_ledger per indexer)                   [Issue 1]       │
│  ├─ [Missing: projection_ledger_state]                      [Issue 3]       │
│  ├─ [Missing: transaction_state_audit]                      [Issue 4]       │
│  └─ [Missing: network_coverage]                             [Issue 1]       │
│                                                                               │
│  ↓                                                                            │
│                                                                               │
│  🚀 SDK Layer (packages/sdk/src)                                             │
│  ├─ recipes/transactions.ts (TransactionOutcome)            [Issue 4]       │
│  │   └─ [Missing: executeWithCapabilityCheck]               [Issue 2]       │
│  ├─ recipes/events.ts (event consumption)                   [Issue 1]       │
│  ├─ utils/streamHistory.ts (cursor-based pagination)        [Issue 1]       │
│  ├─ utils/event-validator.ts (schema versioning)            [Issue 2]       │
│  ├─ utils/networkDetection.ts (protocol version)            [Issue 2]       │
│  ├─ index.ts (VERSION = "0.2.0")                            [Issue 2]       │
│  ├─ [Missing: CoverageService]                              [Issue 1]       │
│  ├─ [Missing: CapabilityChecker]                            [Issue 2]       │
│  └─ [Missing: ProjectionService]                            [Issue 3]       │
│                                                                               │
│  ↓                                                                            │
│                                                                               │
│  🔄 Indexing Layer (scripts/cdc-indexer.ts)                                  │
│  ├─ Polls Soroban RPC getEvents                             [Issue 1]       │
│  ├─ Idempotent INSERT via ON CONFLICT                       [Issue 3]       │
│  ├─ Cursor persistence (last_ledger)                        [Issue 1]       │
│  ├─ [Missing: per-network cursor tracking]                  [Issue 1]       │
│  ├─ [Missing: gap detection on resume]                      [Issue 1]       │
│  └─ [Missing: snapshot hash validation]                     [Issue 3]       │
│                                                                               │
│  ↓                                                                            │
│                                                                               │
│  ⛓️  Soroban Chain (Stellar Network)                                          │
│  └─ RPC Server (ledgers, events, network info)                               │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Issue 1: Coverage Tracking — Data Flow

```
   Soroban RPC                CDC Indexer              PostgreSQL              Coverage Query
   ┌──────────┐              ┌────────────┐            ┌─────────┐             ┌────────────┐
   │ Events   │              │ Poll       │            │ Events  │             │ Coverage   │
   │ Ledger N │──getEvents──→│ Interval   │─upsert→    │ Table   │             │ Service    │
   └──────────┘              │ (5s)       │            └─────────┘             └────────────┘
                             │            │                ↓
                             │            │            ┌─────────┐             ┌────────────┐
                             │            │            │ CDC     │   ←─query── │ "Is L100   │
                             │ Resume?    │            │ Cursors │             │ -L200      │
                             │ Get last   │────upsert→ │ Table   │             │ complete?" │
                             │ ledger     │            └─────────┘             └────────────┘
                             └────────────┘
                                 
   Current: Local cursor only
   ┌──────────────────────────────────┐
   │ cdc_cursors                      │
   ├─ indexer_id (KEY)               │  ← Only tracks last ledger
   ├─ last_ledger                    │    No network distinction
   └──────────────────────────────────┘

   Needed: Per-network coverage
   ┌────────────────────────────────────────────┐
   │ network_coverage                           │
   ├─ network (testnet/mainnet)        (KEY)   │
   ├─ indexer_id                      (KEY)   │
   ├─ ledger_range_start                       │  ← Enables gap detection
   ├─ ledger_range_end                         │
   ├─ has_gaps (boolean or JSON)               │
   ├─ last_verified_at                         │
   └────────────────────────────────────────────┘
```

---

## Issue 2: Capability Surface — Pre-Transaction Validation

```
   Client Code                    SDK                    Soroban RPC/Contract
   ┌──────────────┐              ┌──────────────┐        ┌────────────────┐
   │ const tx =   │              │              │        │ Contract       │
   │ await client │──build───→   │ Assert       │        │ supports       │
   │ .sendPayment │              │ capability   │        │ sendPayment    │
   │ (...)        │              │ available?   │        │ v2?            │
   │              │              │ NO  ↓        │        └────────────────┘
   └──────────────┘              │ THROW NOW ✓  │
                                 │ (not at RPC) │
                                 │              │
                                 │ YES ↓        │
                                 │ sendTx ──→  │ (RPC accepts or rejects)
                                 └──────────────┘

   Current: No pre-check
   ┌──────────────────────────────┐
   │ SDK Version = "0.2.0"        │
   │ (no operation manifest)      │
   └──────────────────────────────┘

   Needed: Capability Checker
   ┌───────────────────────────────────────────────────┐
   │ ClientCapabilities {                              │
   │   sdkVersion: "0.2.0"                             │
   │   supportedOperations: [                          │
   │     { name: "sendPayment", since: "0.1.0" }       │
   │     { name: "createStream", since: "0.2.0" }      │
   │   ]                                               │
   │   networkCapabilities: {                          │
   │     testnet: { protocolVersion: 21 },             │
   │     mainnet: { protocolVersion: 20 }              │
   │   }                                               │
   │ }                                                 │
   │                                                   │
   │ canExecute(op: string, network): boolean          │
   │   → checks supportedOperations + network version  │
   └───────────────────────────────────────────────────┘

   API Endpoint (needed)
   GET /api/capabilities
   ↓
   {
     "version": "1.0.0",
     "supportedOperations": ["sendPayment", "createStream"],
     "network": "testnet",
     "protocolVersion": 21
   }
```

---

## Issue 3: Atomic Projection + Cursor — Transaction Boundaries

```
   Before (Current): Not Atomic
   ┌────────────────────┐
   │ 1. Read events     │
   │    from RPC        │
   │    (ledger 1–100)  │
   └──────┬─────────────┘
          ↓
   ┌────────────────────┐
   │ 2. Update cache    │  ← TRANSACTION 1
   │ (campaign progress)│    (succeeds)
   └──────┬─────────────┘
          ↓
   ┌────────────────────┐
   │ 3. Update cursor   │  ← TRANSACTION 2
   │ (last_ledger=100)  │    (CRASH HERE!)
   └──────┬─────────────┘
          ↓
   RESTART
   ↓
   Ledger 1–100 projected again but cursor not advanced
   → Duplicate projections or stale cache


   After (Needed): Atomic
   ┌─────────────────────────────────────────────┐
   │ BEGIN TRANSACTION                           │
   ├─ 1. Read events (ledger 1–100)             │
   ├─ 2. Update projections (cache)             │
   ├─ 3. Write projection_ledger_state          │
   │    (last_applied = 100, hash = XXX)        │
   ├─ 4. Update cdc_cursors                     │
   │    (last_ledger = 100)                     │
   └─ COMMIT (all or nothing)                   │
      ↓
   Restart always finds consistent state


   Schema Additions:
   ┌────────────────────────────────────────────┐
   │ projection_ledger_state                    │
   ├─ projection_id (e.g., "campaign_progress") │
   ├─ last_applied_ledger                       │
   ├─ snapshot_hash (for verification)          │
   ├─ record_count                              │
   ├─ updated_at                                │
   └────────────────────────────────────────────┘
```

---

## Issue 4: Canonical Transaction States — Unification

```
   Current: Scattered State Enums
   ┌──────────────────────────────┐
   │ useTransactionGuard          │
   │ "idle" | "pending" |         │
   │ "success" | "error"          │
   └──────────────────────────────┘

   ┌──────────────────────────────┐
   │ use-sync-queue               │
   │ "pending" | "syncing" |      │
   │ "synced" | "failed" |        │
   │ "conflict"                   │
   └──────────────────────────────┘

   ┌──────────────────────────────┐
   │ offramp.ts PayoutStatus      │
   │ "pending" | "processing" |   │
   │ "confirmed" | "completed" |  │
   │ "failed" | "expired" |       │
   │ "timeout" | "delayed"        │
   └──────────────────────────────┘

   And 7+ more in verification, sponsorship, batch, stretch goals...


   After: Canonical Model
   ┌────────────────────────────────────────────────────────────┐
   │ TransactionStateModel (Source of Truth)                    │
   ├─ state: "pending" | "confirmed" | "failed"                │
   ├─ onChain?: {                                              │
   │    ledger: number         ← Binding to finality            │
   │    confirmationTime: ISO  ← When confirmed                 │
   │    txHash: string                                          │
   │  }                                                         │
   ├─ error?: {                                                │
   │    code: string                                           │
   │    category: ErrorCategory (see below)                    │
   │    suggestion: string                                      │
   │  }                                                         │
   └────────────────────────────────────────────────────────────┘

   ┌────────────────────────────────────────────────────────────┐
   │ ErrorCategory (Taxonomy)                                   │
   ├─ "transient"        (retry likely helps)                  │
   ├─ "permanent"        (never retry)                          │
   ├─ "user_error"       (user input problem)                  │
   ├─ "compliance_hold"  (risk/KYC issue)                      │
   ├─ "rate_limit"       (backoff needed)                      │
   └────────────────────────────────────────────────────────────┘

   API Response (Unified Envelope)
   {
     "data": { /* operation-specific */ },
     "state": "confirmed",
     "ledger": 12345,
     "timestamp": "2024-01-15T10:30:00Z",
     "error": null
   }

   UI Layer (Receives Both)
   TransactionStateView = {
     state: "confirmed",
     onChain: { ledger: 12345, ... },
     uiState: "synced",
     errorCategory: null
   }
```

---

## Dependency Graph (What to Fix First)

```
Issue 3 (Atomicity)
├─ Foundational for data consistency
├─ Unblocks Issues 1 & 4
└─ Low risk: mostly schema additions

  ↓ depends on

Issue 4 (Canonical States)
├─ Consolidates scattered enums
├─ Provides foundation for UI/API standardization
└─ Medium risk: coordination across services

  ↓ depends on

Issue 1 (Coverage Tracking)
├─ Monitoring & observability
├─ Uses atomic patterns from Issue 3
└─ Medium risk: adds new queries/endpoints

  ↓ depends on

Issue 2 (Capability Surface)
├─ Polish/validation layer
├─ Uses versioning from event-validator.ts
└─ Low risk: additive, no breaking changes
```

---

## Key Patterns to Adopt

### 1. Idempotency (Proven ✓)
```sql
INSERT INTO events (id, ...) 
  VALUES ($1, ...)
  ON CONFLICT (id) DO NOTHING;
```
**Status**: Already in CDC indexer and webhooks
**Action**: Apply to all upserts

### 2. Monotonic Timestamps (Proven ✓)
```sql
NEW.updated_at := GREATEST(
  clock_timestamp(), 
  OLD.updated_at + INTERVAL '1 microsecond'
);
```
**Status**: Already in campaign state
**Action**: Apply to all state transitions

### 3. Atomic Multi-Table Updates (Missing)
```sql
BEGIN;
  UPDATE projections SET ...;
  UPDATE cursors SET ... WHERE id = ...;
COMMIT;
```
**Status**: Not yet coordinated
**Action**: Implement in ProjectionService

### 4. Discriminated Unions (Proven ✓)
```ts
type Outcome<T> = 
  | { success: true; result: T }
  | { success: false; error: Error };
```
**Status**: Already in SDK TransactionOutcome
**Action**: Standardize across all state types

### 5. Typed Event Schemas (Proven ✓)
```ts
interface EventSchema {
  version: number;
  topics: FieldDefinition[];
  payload: FieldDefinition[];
}
```
**Status**: Already in event-validator.ts
**Action**: Apply to all event types

---

## File Organization (Proposed)

```
packages/sdk/src/
├─ index.ts                          (export new services)
├─ CoverageService.ts                [NEW] Issue 1
├─ CapabilityChecker.ts              [NEW] Issue 2
├─ ProjectionService.ts              [NEW] Issue 3
├─ TransactionStateModel.ts          [NEW] Issue 4
├─ recipes/
│  └─ transactions.ts                [MODIFY] add capability checks
├─ utils/
│  ├─ event-validator.ts             [reference]
│  ├─ streamHistory.ts               [reference]
│  └─ networkDetection.ts            [reference]

apps/web/src/
├─ types/
│  ├─ transaction-state.ts           [NEW] canonical enum
│  └─ offramp.ts                     [reference]
├─ services/
│  └─ projection.service.ts          [NEW] atomic updates
├─ app/api/
│  ├─ capabilities/                  [NEW] GET /api/capabilities
│  ├─ coverage/                      [NEW] GET /api/coverage/{network}
│  └─ [existing routes]              [MODIFY] standardize responses

migrations/
├─ 007_projection_ledger_state.sql   [NEW] Issue 3
├─ 008_transaction_state_audit.sql   [NEW] Issue 4
└─ 009_network_coverage.sql          [NEW] Issue 1

docs/
├─ coverage-tracking.md              [NEW] Issue 1
├─ capability-versioning.md          [NEW] Issue 2
├─ projection-consistency.md         [NEW] Issue 3
└─ transaction-state-model.md        [NEW] Issue 4
```

