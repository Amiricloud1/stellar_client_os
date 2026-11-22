# Implementation Fixes for Four Critical Objectives

This document outlines the fixes being implemented for the four critical issues in Stellar Client OS.

## Issue 1: Stable Compound Cursors

### Problem
Event deduplication relies on simple `<ledger>-<txIndex>-<eventIndex>` identifiers, which don't account for transaction hashes. This creates duplicate or reordering risk for events with equal timestamps and concurrent ingestion.

### Solution
- Upgrade `eventId` format to include transaction hash: `<ledger>-<txHash>-<eventIndex>`
- Extend cursor schema to capture compound position with (ledger, txHash, eventIndex, timestamp)
- Add composite unique constraint on (ledger_sequence, tx_hash, event_index)
- Implement stable ordering by (timestamp, tx_hash, event_index) tiebreaker

### Files Modified
- `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` - Event ID generation, cursor schema, database operations
- `/workspaces/stellar_client_os/scripts/cdc-indexer.test.ts` - Tests for compound cursor stability

---

## Issue 2: Failed Event Retention with Replay

### Problem
- Failed events are not persisted; they're only logged
- No permission checks before replaying offline actions  
- No partition isolation to prevent cascading failures
- No categorization of failure types (network, permission, validation, etc.)

### Solution
- Create `failed_events` table to persist failed events with retry count and cause
- Add permission validation in mobile action queue before replay
- Implement partition-aware error handling
- Add `failureCategory` field to audit records

### Files Modified
- `/workspaces/stellar_client_os/scripts/cdc-indexer.ts` - Add failed events persistence
- `/workspaces/stellar_client_os/apps/mobile/src/offline/actionQueue.ts` - Add permission checks
- `/workspaces/stellar_client_os/packages/sdk/src/audit.ts` - Add failure categorization

---

## Issue 3: Draft Persistence with Offline Confirmation

### Problem (CRITICAL)
- Drafts are stored but no guard prevents deployment while offline
- No distinction between "draft saved" vs "draft ready for deployment"
- Campaign wizard doesn't auto-save drafts
- No atomic draft-to-deployment transition

### Solution
- Extend draft schema with status: editing | offline_saved | online_confirmed | deployed
- Implement online confirmation dialog before deployment
- Add pre-deployment guard: draft.status must be "online_confirmed"
- Implement draft auto-save in campaign wizard  
- Unify draft semantics across mobile and web

### Files Modified
- `/workspaces/stellar_client_os/apps/web/src/hooks/use-sync-queue.ts` - Add online gate
- `/workspaces/stellar_client_os/apps/mobile/src/offline/storage.ts` - Add draft lifecycle
- `/workspaces/stellar_client_os/apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx` - Auto-save drafts
- `/workspaces/stellar_client_os/apps/web/src/services/contract.deployer.ts` - Pre-deployment guard

---

## Issue 4: Projection Comparison and Audit

### Problem
- CO2 projections not anchored to specific ledger sequence
- No mechanism to compare projections calculated at different ledgers
- No audit trail when projections drift or are recalculated
- Silent overwrite of projections without operator oversight

### Solution
- Add `ledgerSequence` and `checksum` to projection results
- Implement `compareProjections()` function to detect drift
- Create `projection_audits` table with drift details
- Mandate audit logging before projection recalculation
- Create `ledger_snapshots` table for state rollback capability

### Files Modified
- `/workspaces/stellar_client_os/apps/web/src/lib/co2-sequestration-projection.ts` - Add ledger anchoring
- `/workspaces/stellar_client_os/packages/sdk/src/audit.ts` - Add projection audit actions
- Database migrations - Create projection_audits and ledger_snapshots tables

---

## Implementation Status

✅ = Complete
🔄 = In Progress  
⏳ = Queued

- [🔄] Issue 1: Event ID format upgrade
- [🔄] Issue 1: Cursor schema extension
- [⏳] Issue 2: Failed events table
- [⏳] Issue 2: Permission checks
- [🔄] Issue 3: Draft lifecycle schema
- [⏳] Issue 3: Campaign wizard auto-save
- [⏳] Issue 4: Projection ledger anchoring
- [⏳] Issue 4: Projection comparison logic
- [⏳] Issue 4: Audit tables and logging

