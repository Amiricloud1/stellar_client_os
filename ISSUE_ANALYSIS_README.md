# Stellar Client OS: Four Key Issues Analysis — Complete Documentation

This directory contains a comprehensive analysis of four critical issues in the Stellar Client OS repository that require implementation or fixes. The analysis includes current implementation status, gaps, recommended fixes, and implementation checklists.

## Document Structure

### 1. **ISSUE_ANALYSIS_FOUR_OBJECTIVES.md** (Primary Document)
   - High-level overview of all four objectives
   - Current implementation status (✅ / ⚠️ / ❌)
   - Detailed gap analysis for each objective
   - File locations and line numbers
   - Specific recommendations for fixes
   - Priority ranking and implementation timeline

   **Start here for:** Executive summary and understanding what needs to be fixed

### 2. **ISSUE_ANALYSIS_FILE_REFERENCE.md** (Navigation Guide)
   - Detailed file-by-file breakdown
   - Specific line numbers for every component
   - Code snippets showing current state
   - Database schema locations
   - Test coverage analysis
   - Quick navigation by objective or file

   **Start here for:** Finding code locations and understanding current implementation

### 3. **ISSUE_ANALYSIS_CHECKLIST.md** (Implementation Guide)
   - Phase-by-phase implementation checklist
   - Effort estimates for each phase
   - Detailed step-by-step tasks
   - Testing requirements
   - Acceptance criteria
   - Overall timeline and dependencies
   - Risk assessment and mitigation

   **Start here for:** Planning implementation work and tracking progress

## The Four Objectives

### Objective 1: Stable Compound Cursors
**Status**: 30% complete | **Severity**: HIGH | **Effort**: 2-3 weeks

Use stable compound cursors combining `timestamp`, `transaction hash`, and `event index` to avoid duplication or reordering.

**Key Files**: 
- `scripts/cdc-indexer.ts` — CDC indexer with cursor tracking
- `scripts/cdc-indexer.test.ts` — Tests

**Gap**: Event ID format too simple; cursor granularity insufficient

---

### Objective 2: Failed Event Retention with Replay
**Status**: 40% complete | **Severity**: HIGH | **Effort**: 3-4 weeks

Retain failed events with causes and attempts; replay under permissions without blocking unrelated partitions.

**Key Files**:
- `packages/sdk/src/audit.ts` — Audit logging framework
- `apps/mobile/src/offline/actionQueue.ts` — Offline action queue
- `scripts/cdc-indexer.ts` — Event indexing

**Gap**: No failed event persistence; no permission checks on replay; no partition isolation

---

### Objective 3: Draft Persistence with Offline Confirmation
**Status**: 35% complete | **Severity**: CRITICAL | **Effort**: 2-3 weeks

Persist drafts across restarts and prohibit deployment or financial actions until online state is confirmed.

**Key Files**:
- `apps/mobile/src/offline/storage.ts` — Offline storage layer
- `apps/web/src/hooks/use-sync-queue.ts` — Sync queue with drafts
- `apps/web/src/services/contract.deployer.ts` — Deployment logic
- `apps/web/src/components/modules/campaign/wizard/CampaignWizard.tsx` — Campaign creation

**Gap**: No online confirmation gate; no draft lifecycle; campaign wizard missing auto-save

---

### Objective 4: Projection Comparison and Audit
**Status**: 40% complete | **Severity**: HIGH | **Effort**: 3-4 weeks

Compare projections at a fixed ledger, record drift, and require auditable repair rather than silent overwrite.

**Key Files**:
- `apps/web/src/lib/co2-sequestration-projection.ts` — CO2 projection model
- `packages/sdk/src/audit.ts` — Audit logging framework
- `apps/web/src/services/campaign-impact-leaderboard.service.ts` — Impact calculations

**Gap**: No ledger anchoring; no comparison logic; no audit schema for drift

---

## Quick Reference: Implementation Priority

| Priority | Objective | Rationale | Timeline |
|----------|-----------|-----------|----------|
| 🔴 CRITICAL | Objective 3 | Prevents financial loss | Week 1-2 |
| 🟠 HIGH | Objective 1 | Enables reliable event processing | Week 3-4 |
| 🟠 HIGH | Objective 2 | Enables auditable recovery | Week 5-7 |
| 🟠 HIGH | Objective 4 | Enables state accountability | Week 8-10 |

---

## Key Statistics

```
Total Files Affected:        15-20 files
Total New Database Tables:   3 tables (failed_events, projection_audits, ledger_snapshots)
Total Database Columns:      ~15 new columns
Total New Functions:         20+ functions
Estimated Total Effort:      3-3.5 months (12-14 weeks)
Lines of Code to Write:      ~3,000-4,000 LOC
Test Cases Needed:          50+ tests
```

---

## How to Use These Documents

### For Project Managers
1. Read **ISSUE_ANALYSIS_FOUR_OBJECTIVES.md** for executive summary
2. Use **ISSUE_ANALYSIS_CHECKLIST.md** to track implementation progress
3. Check timeline and dependencies to plan sprints

### For Developers
1. Read **ISSUE_ANALYSIS_FILE_REFERENCE.md** to find code locations
2. Use **ISSUE_ANALYSIS_CHECKLIST.md** for implementation tasks
3. Reference **ISSUE_ANALYSIS_FOUR_OBJECTIVES.md** for context and recommendations

### For Code Reviewers
1. Check **ISSUE_ANALYSIS_CHECKLIST.md** for acceptance criteria
2. Use **ISSUE_ANALYSIS_FILE_REFERENCE.md** to verify completeness
3. Reference **ISSUE_ANALYSIS_FOUR_OBJECTIVES.md** for context

---

## Document Navigation Map

```
START HERE
    ↓
ISSUE_ANALYSIS_FOUR_OBJECTIVES.md
    ├─ Executive Summary
    ├─ Need details? → ISSUE_ANALYSIS_FILE_REFERENCE.md
    └─ Ready to implement? → ISSUE_ANALYSIS_CHECKLIST.md

ISSUE_ANALYSIS_FILE_REFERENCE.md
    ├─ Find file locations
    ├─ See code snippets
    ├─ Check line numbers
    └─ Review database schemas

ISSUE_ANALYSIS_CHECKLIST.md
    ├─ Phase-by-phase tasks
    ├─ Effort estimates
    ├─ Acceptance criteria
    └─ Track progress
```

---

## Key Findings Summary

### What's Already Done ✅
- CDC indexer infrastructure exists
- Audit logging framework implemented
- Offline storage layer in place
- Action queue with retry support
- CO2 projection model
- Bindings drift detection

### What's Missing ❌
- Compound cursor implementation
- Failed event persistence
- Permission checks on replay
- Partition isolation
- Online confirmation for drafts
- Draft auto-save in UI
- Projection comparison logic
- Ledger snapshot schema
- Drift audit trail

### Critical Gaps 🔴
1. **Draft deployment without online confirmation** — Can lead to financial loss
2. **Event duplication possible** — Impacts data integrity
3. **No replay permission checks** — Security risk
4. **Silent projection overwrites** — Audit trail missing

---

## Related Issues in Repository

- Issue #531: Soroban Stream Event CDC Indexer
- Issue #109: Privileged administrative action audit logging
- Issue #873: Event deduplication wiring
- Issue #78: Bounded LRU cache size
- Issue #90-#94: Mobile offline features
- Issue #528, #73: Offline-first PWA sync queue
- Issue #617: Soroban SDK upgrade

---

## Questions?

Each document includes:
- **File locations** with full paths
- **Line numbers** for specific code
- **Code snippets** showing current state
- **Specific recommendations** for fixes
- **Acceptance criteria** for validation

Refer to the appropriate document for:
- **What/Why**: ISSUE_ANALYSIS_FOUR_OBJECTIVES.md
- **Where/How**: ISSUE_ANALYSIS_FILE_REFERENCE.md
- **When/Steps**: ISSUE_ANALYSIS_CHECKLIST.md

---

## Next Steps

1. ✅ Review the four objectives with team
2. ✅ Validate gaps and recommendations
3. ⬜ Create implementation tickets (one per phase)
4. ⬜ Prioritize based on business impact
5. ⬜ Begin with Objective 3 (draft persistence) — critical path
6. ⬜ Implement in parallel: Objectives 1 & 4 (no dependencies)
7. ⬜ Implement after Objective 1: Objective 2 (depends on cursors)

---

**Analysis Date**: November 2024
**Repository**: Stellar Client OS
**Analyst**: System Analysis Tool
**Status**: Complete — Ready for Implementation Planning
