# Investigation Findings: Four Core Issues

## Quick Summary

**Status**: All four issues are **PARTIALLY IMPLEMENTED**. Core infrastructure exists but critical pieces are missing.

---

## Issue 1: Track Contiguous Coverage Per Network & Bounded Replay

### ✓ What Works
- CDC indexer polls RPC and persists events to PostgreSQL idempotently
- Cursor-based pagination in `streamHistory.ts` avoids duplicates
- `cdc_cursors` table tracks last indexed ledger
- Event deduplication via `ON CONFLICT (event_id) DO NOTHING`

### ✗ What's Missing
- **No per-network coverage tracking** — can't answer "what ledger ranges are indexed on testnet vs mainnet?"
- **No gap detection** — indexer resumes from cursor but doesn't validate contiguity
- **No coverage API** — no way to query coverage status or holes
- **No authoritative source designation** — no validation that replayed events are from canonical source

### 📍 Key Files
- `scripts/cdc-indexer.ts` (lines 1–450): CDC implementation
- `packages/sdk/src/utils/streamHistory.ts`: Pagination logic
- `migrations/004_durable_campaign_state_and_webhooks.sql`: Idempotency pattern reference

---

## Issue 2: Expose Typed Capability/Version Surface

### ✓ What Works
- SDK exports `VERSION = "0.2.0"`
- Event schema versioning with `EventSchemaDefinition` and backward compatibility checks
- Network protocol version detection via RPC
- OpenAPI spec has `info.version` and `x-api-version` with deprecation policy

### ✗ What's Missing
- **No client capability declaration** — clients can't declare "I support X operations"
- **No pre-transaction capability validation** — unsupported operations fail at RPC, not during preparation
- **No versioned operation support matrix** — no way to check "is operation Y available in SDK v0.2.0?"
- **No HTTP `/api/capabilities` endpoint** — API doesn't expose capabilities for discovery

### 📍 Key Files
- `packages/sdk/src/index.ts` (line 1): bare VERSION export
- `packages/sdk/src/utils/event-validator.ts` (lines 1–250): schema versioning (good model)
- `packages/sdk/src/recipes/transactions.ts`: Where capability checks should go

---

## Issue 3: Persist Ledger Cursors with Projections Atomically

### ✓ What Works
- `idempotency_key` pattern prevents duplicate writes after crash
- Webhook delivery uses `ON CONFLICT ... DO NOTHING` for idempotency
- Monotonic `updated_at` timestamps enforced via trigger
- Campaign progress cache tracks TTL and invalidation reasons
- Append-only event tables with DELETE/UPDATE prevention

### ✗ What's Missing
- **No atomic cursor + projection writes** — cache invalidation and cursor advancement not in same transaction
- **No projection ledger state table** — can't link derived state to specific ledger sequence
- **No gap detection on resume** — after crash, no validation that no ledgers were skipped
- **No snapshot/checksum mechanism** — no way to detect if projections got corrupted

### 📍 Key Files
- `apps/web/src/services/campaign-progress-cache.service.ts`: Cache without cursor binding
- `migrations/004_durable_campaign_state_and_webhooks.sql` (entire file): idempotency reference
- `scripts/cdc-indexer.ts` (lines 200–350): Cursor persistence logic

---

## Issue 4: Use Consistent Pending, Confirmed, Failed States Across API and UI

### ✓ What Works
- Offramp module defines clear states: `"pending" | "processing" | "confirmed" | "completed" | "failed" | "expired"`
- SDK `TransactionOutcome` uses discriminated union for success/error
- Multiple services track state independently (verification, sponsorship, batch, stretch goals)
- State transitions tracked in offramp reconciliation

### ✗ What's Missing
- **No global canonical state enum** — 10+ different state enums defined locally
- **No ledger finality binding** — states don't track which ledger confirmed a transaction
- **No unified API response format** — state names vary across endpoints
- **No error categorization taxonomy** — different services use different error categories
- **No UI-to-ledger mapping** — components can't coordinate local state with on-chain state

### 📍 Key Files
- `apps/web/src/types/offramp.ts` (entire file): Most mature state machine (template)
- `apps/web/src/hooks/useTransactionGuard.ts`: Local mutation state
- `apps/web/src/hooks/use-sync-queue.ts`: Sync state + error classification
- `packages/sdk/src/recipes/transactions.ts`: SDK transaction outcome
- `migrations/004_durable_campaign_state_and_webhooks.sql` (lines 1–50): Campaign state enum pattern

---

## Root Cause Analysis

All four issues suffer from the same root problem:

> **Infrastructure exists for individual concerns but lacks binding / coordination mechanisms.**

- Issue 1: Event indexing works, but coverage tracking is decoupled
- Issue 2: Versioning exists, but capability *checking* is missing
- Issue 3: Idempotency patterns exist, but atomicity across services is missing
- Issue 4: State machines exist locally, but global canonical model is missing

**Pattern**: Each subsystem works independently but can't reliably coordinate state transitions or query aggregate status.

---

## High-Level Fixes (Priorities)

### 1️⃣ Issue 3 (Projection + Cursor Atomicity)
- **Why first**: Blocks reliable recovery after process crashes; data integrity risk
- **Scope**: 2–3 migration files + 1 service class
- **Effort**: Medium

### 2️⃣ Issue 4 (Canonical Transaction States)
- **Why second**: Unifies scattered state logic; foundation for UI consistency
- **Scope**: 1 new enum + consolidation of existing states + API response standardization
- **Effort**: Medium

### 3️⃣ Issue 1 (Coverage Tracking)
- **Why third**: Enables monitoring indexer health; non-blocking
- **Scope**: Schema extensions + 1 service class + API endpoint
- **Effort**: Medium–High

### 4️⃣ Issue 2 (Capability Surface)
- **Why last**: Polish layer; current soft failures acceptable
- **Scope**: 1 service class + pre-transaction checks
- **Effort**: Low–Medium

---

## Estimated Implementation

| Issue | New Files | Modified Files | LOC | Est. Days |
|-------|-----------|----------------|-----|-----------|
| 1 | 2 | 4 | 800–1200 | 3–4 |
| 2 | 1 | 3 | 400–600 | 2–3 |
| 3 | 3 | 5 | 1000–1500 | 3–4 |
| 4 | 2 | 6 | 600–900 | 2–3 |
| **Total** | **8** | **18** | **2800–4200** | **10–14** |

---

## Next Steps

1. **Review** this summary with team for priorities
2. **Create detailed design specs** for each issue (see `INVESTIGATION_SUMMARY.md` for file-by-file breakdown)
3. **Prototype** Issue 3 (atomicity) as proof-of-concept for pattern
4. **Implement** in priority order: 3 → 4 → 1 → 2

See `INVESTIGATION_SUMMARY.md` for detailed findings, file locations, and specific recommended changes.
