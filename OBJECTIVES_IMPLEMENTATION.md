# Campaign Funding Objectives Implementation

This document describes the implementation of 4 major campaign funding objectives for the Stellar Client OS project.

## Summary

All 4 objectives have been fully implemented with 57 comprehensive tests, following TypeScript best practices and maintaining consistency with the existing codebase.

- **Commit**: `8cb24d3` - feat(objectives): implement 4 campaign funding objectives with comprehensive testing

## Objective 1: Refund Eligibility & State

### Problem
Previously, the refund system did not clearly distinguish between:
- Whether a sponsor is *eligible* for a refund
- Whether a sponsor has *requested* a refund
- Whether a refund has been *confirmed* on-chain

The absence of these distinctions implied that unclaimed refunds were automatic, which was misleading.

### Solution

**New Types** (`campaign-insurance.service.ts`):
- `RefundEligibility` - Determines if sponsor qualifies for a refund based on campaign state and contribution history
- `RefundSubmissionState` - Tracks: `NOT_REQUESTED`, `PENDING`, `CONFIRMED`, `FAILED`, `REJECTED`
- `ConfirmedRefundTransaction` - Records on-chain transaction hash, ledger, amount, and timestamp
- `RefundState` - Complete refund status including eligibility, submission state, and confirmed transaction

**Key Methods**:
```typescript
evaluateRefundEligibility(campaignFailed, sponsorContribution, alreadyRefunded): RefundEligibility
```
Checks:
- Campaign failed (no refunds for successful campaigns)
- Sponsor has a contribution > 0
- Not already refunded

```typescript
buildRefundState(...): RefundState
```
Creates complete refund state with:
- Explicit eligibility determination
- Submission state (NOT_REQUESTED by default — no automatic implications)
- Optional confirmed transaction reference
- Timestamps for audit

**Impact**:
- UI can now clearly show: "You are eligible but haven't requested yet" vs. "Your refund was confirmed on X"
- Prevents misleading "unclaimed refund" messaging
- Supports compliance audits via timestamps

**Tests**: 9 tests covering eligibility evaluation and state building

---

## Objective 2: Schedule Review Before Launch

### Problem
Campaign schedules could be modified at any time, even after:
- Campaign went ACTIVE
- Sponsors had contributed with expectations based on schedule
- Milestones (e.g., planting dates, verification windows) were locked in

This created fairness and compliance issues.

### Solution

**New Types & Service** (`campaign-schedule.service.ts`):
- `CampaignSchedule` - Bounded schedule with start/end dates, milestones, state tracking
- `CampaignMilestone` - Individual milestone with `isLocked` flag and reason
- `ScheduleEditAuditEntry` - Audit trail for all schedule changes
- `ScheduleEditResult` - Result of edit attempt with success/warning/error

**Key Methods**:
```typescript
validateScheduleForReview(schedule): { valid: boolean; errors: string[] }
```
Validates before launch:
- Start date not in past
- End date after start date
- Duration within min/max bounds
- Milestones within date range
- At least one milestone defined

```typescript
attemptMilestoneEdit(schedule, milestoneId, newDate): ScheduleEditResult
```
Edit enforcement:
- Rejects edits if campaign is ACTIVE → schedule immutable
- Rejects edits if milestone is LOCKED → contributions accepted
- Checks new date is within schedule bounds
- Tracks if edit affects accepted contributions (audit warning)

```typescript
lockMilestoneForContributions(milestone, acceptanceCount): CampaignMilestone
```
Prevents future edits once contributions are accepted.

```typescript
identifyAffectedMilestones(schedule, newEndDate): { affected, locked }
```
Detects which milestones would be affected by schedule shortening/extension.

**Impact**:
- Schedule becomes immutable once campaign goes ACTIVE
- Locked milestones prevent date changes after contributions accepted
- Complete audit trail for compliance
- Fairness guaranteed: sponsors can review schedule before contributing

**Tests**: 14 tests covering validation, editing constraints, locking, and impact analysis

---

## Objective 3: Submission Status & Retry Logic

### Problem
Previous refund submission system didn't distinguish between:
- **REJECTED**: Server explicitly rejected (e.g., invalid state, not eligible) — no transfer initiated
- **TIMEOUT**: Ambiguous state (request may have succeeded but we don't know) — can't safely retry without idempotency

Retry UI could create duplicate transfers on-chain.

### Solution

**New Types & Service** (`campaign-refund-submission.service.ts`):
- `RefundSubmissionStatusType` - `PENDING`, `CONFIRMED`, `REJECTED`, `TIMEOUT`, `RETRY_ELIGIBLE`
- `RefundSubmissionAttempt` - Single submission attempt with idempotency key, status, transaction hash, error details
- `RefundSubmissionStatus` - Complete status including history, retry eligibility, and confirmed state
- `OnChainRefundState` - Result of on-chain idempotency check

**Key Methods**:
```typescript
initiateSubmission(campaignId, sponsorAddress): RefundSubmissionAttempt
```
Creates unique idempotency key to detect duplicate transfers:
- Format: `refund-{campaignId}-{sponsorAddress}-{timestamp}-{random}`
- Stored with submission for idempotent retry attempts

```typescript
confirmSubmission(idempotencyKey, transactionHash, ledgerNumber): void
confirmSubmission(idempotencyKey, errorCode, errorMessage): void
timeoutSubmission(idempotencyKey): void
```
Transitions submission through states with full tracking.

```typescript
canRetrySubmission(campaignId, sponsorAddress, onChainState?): { canRetry, reason }
```
Retry eligibility checks:
- ✗ Already confirmed — don't retry
- ✗ Explicitly rejected — don't retry
- ✗ Max retries exceeded — don't retry
- ✗ Timeout backoff not elapsed — don't retry
- ✗ Refund already exists on-chain — don't retry
- ✓ Otherwise eligible

```typescript
createRetryAttempt(campaignId, sponsorAddress): RefundSubmissionAttempt | null
```
Creates retry with:
- **Same idempotency key** — prevents duplicate on-chain transfers
- Incremented attempt number
- Exponential backoff (5s, 10s, 20s, ... capped at 60s)

**Impact**:
- REJECTED vs. TIMEOUT clearly distinguished
- Idempotency keys prevent duplicate transfers on retry
- Exponential backoff prevents hammering on timeouts
- Max retries prevents infinite retry loops
- On-chain state checking detects if transfer already succeeded

**Tests**: 16 tests covering submission lifecycle, timeout handling, backoff, and duplicate prevention

---

## Objective 4: Team Invitations & Access Control

### Problem
The collaboration system needed to support:
- Time-bounded invitations (expire after N days)
- Role-scoped access restrictions
- Revocation capability (invalidate unused invites)
- Complete audit history for compliance

### Solution

**Enhanced Types** (`collaboration.ts`):
- Extended `CoCreatorInvite` with:
  - `isRevoked`, `revokedAt`, `revokedBy` - Revocation tracking
  - Already had: `createdAt`, `expiresAt`, `isUsed` - Expiration tracking
- New `TeamAccessAuditEntry` - Records all access control events:
  - `INVITE_CREATED`, `INVITE_ACCEPTED`, `INVITE_EXPIRED`, `INVITE_REVOKED`
  - `MEMBER_ADDED`, `ROLE_CHANGED`, `MEMBER_REMOVED`
  - Includes actor, target, reason, and change details

**Enhanced Service** (`campaign-collaboration.service.ts`):

```typescript
createInviteToken(params): CoCreatorInvite
```
Creates time-bounded invitation:
- Generates unique token
- Sets expiration (default 7 days, customizable)
- Records audit entry: `INVITE_CREATED`

```typescript
getInviteByToken(token): CoCreatorInvite | null
```
Retrieves invite only if:
- ✓ Not revoked
- ✓ Not expired
- Returns `null` otherwise (records `INVITE_EXPIRED` audit entry if applicable)

```typescript
revokeInvite(token, revokedBy, reason): { success, error? }
```
Revokes active invitations:
- ✗ Prevents revokes of already-accepted invites
- ✗ Prevents revokes of already-revoked invites
- ✓ Records `INVITE_REVOKED` audit entry

```typescript
getAuditHistory(campaignId): TeamAccessAuditEntry[]
```
Complete audit trail of all team access events:
- Who invited whom and when
- Who accepted and when
- Who was removed and why
- Who changed whose role and to what
- When invites expired or were revoked

**Role-Scoped Access Control**:
- OWNER cannot be removed
- OWNER cannot have role changed
- Non-OWNER roles (CO_CREATOR, EDITOR, VIEWER) can be updated
- All changes audit-logged

**Impact**:
- Invitations automatically expire (time-bounded)
- Team leads can revoke unused invites
- Complete compliance audit trail
- Role-based access control enforced
- All changes trackable to specific actor

**Tests**: 18 tests covering invite lifecycle, expiration, revocation, acceptance, role changes, removals, and audit logging

---

## File Structure

```
apps/web/src/
├── services/
│   ├── campaign-insurance.service.ts          [98 LOC] - Objective 1
│   ├── campaign-insurance.service.test.ts     [68 LOC] - 9 tests
│   ├── campaign-schedule.service.ts           [234 LOC] - Objective 2
│   ├── campaign-schedule.service.test.ts      [282 LOC] - 14 tests
│   ├── campaign-refund-submission.service.ts  [202 LOC] - Objective 3
│   ├── campaign-refund-submission.service.test.ts [231 LOC] - 16 tests
│   ├── campaign-collaboration.service.ts      [246 LOC] - Objective 4 (enhanced)
│   └── campaign-collaboration.service.test.ts [341 LOC] - 18 tests
├── types/
│   └── collaboration.ts                       [102 LOC] - Objective 4 (types enhanced)
└── ../tests/
    └── setup.ts                               [20 LOC] - Vitest setup
```

**Total New/Modified Code**: ~1,800 LOC
**Total Tests**: 57 passing

---

## Testing

All tests run in Vitest with jsdom environment, following the project's testing conventions:

```bash
npm test -- \
  src/services/campaign-insurance.service.test.ts \
  src/services/campaign-schedule.service.test.ts \
  src/services/campaign-refund-submission.service.test.ts \
  src/services/campaign-collaboration.service.test.ts

# Result: 57 tests passed ✓
```

### Test Coverage by Objective

| Objective | Tests | Key Scenarios |
|-----------|-------|---|
| 1: Refund Eligibility | 9 | Eligibility eval, state building, confirmed txs |
| 2: Schedule Review | 14 | Validation, editing, locking, impact analysis |
| 3: Submission Status | 16 | Submission lifecycle, timeouts, retries, backoff, idempotency |
| 4: Team Access Control | 18 | Invites, expiration, revocation, roles, audit history |

---

## Design Decisions

### Idempotency Keys (Objective 3)
- Stored with each submission attempt
- Reused on retry to prevent duplicate on-chain transfers
- Format includes timestamp and random component for uniqueness
- On-chain contract should validate key uniqueness

### Schedule Immutability (Objective 2)
- Read-only once campaign is ACTIVE
- Milestone-level locking when contributions accepted
- Audit trail tracks all attempted changes
- Clear error messages distinguish between reasons (active, locked)

### Refund State Clarity (Objective 1)
- Three separate concepts: eligibility, submission state, confirmed transaction
- No automatic implication of unclaimed refunds
- UI can show: "Eligible but not requested" vs. "Requested but pending" vs. "Confirmed at [tx]"

### Audit Logging (Objective 4)
- Append-only audit entries (cannot be modified/deleted)
- Includes actor, target, reason, and change details
- Enables compliance audits and security investigations
- Timestamped for chronological ordering

---

## Integration Notes

### Database Schema Recommendations

**For Objective 1 (Refund State)**:
```sql
CREATE TABLE refund_submissions (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL,
  sponsor_address TEXT NOT NULL,
  contribution_amount NUMERIC NOT NULL,
  eligibility_status TEXT NOT NULL, -- NOT_ELIGIBLE, ELIGIBLE
  submission_state TEXT NOT NULL,   -- NOT_REQUESTED, PENDING, CONFIRMED, FAILED, REJECTED
  confirmed_tx_hash TEXT,
  confirmed_ledger INT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(campaign_id, sponsor_address)
);
```

**For Objective 2 (Schedule)**:
```sql
CREATE TABLE campaign_schedules (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL, -- DRAFT, SCHEDULED, ACTIVE, ...
  accepted_contributions_count INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(campaign_id)
);

CREATE TABLE campaign_milestones (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES campaign_schedules(id),
  name TEXT NOT NULL,
  scheduled_date TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL, -- PLANTING, VERIFICATION, REWARD_STREAM, CUSTOM
  is_locked BOOLEAN DEFAULT FALSE,
  locked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
```

**For Objective 3 (Refund Submission)**:
```sql
CREATE TABLE refund_submission_attempts (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL,
  sponsor_address TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL, -- INITIATED, IN_FLIGHT, CONFIRMED, REJECTED, TIMEOUT
  tx_hash TEXT,
  ledger_number INT,
  error_code TEXT,
  error_message TEXT,
  attempt_number INT NOT NULL,
  max_retries INT NOT NULL,
  next_retry_eligible_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  UNIQUE(idempotency_key)
);
```

**For Objective 4 (Team Access Audit)**:
```sql
CREATE TABLE team_access_audit (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL,
  event_type TEXT NOT NULL, -- INVITE_CREATED, INVITE_ACCEPTED, etc.
  actor TEXT NOT NULL,
  actor_role TEXT,
  target_member TEXT,
  target_role TEXT,
  reason TEXT,
  change_details JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  ip_address TEXT
);

CREATE INDEX idx_team_access_audit_campaign_timestamp
  ON team_access_audit(campaign_id, timestamp DESC);
```

---

## Future Enhancements

1. **API Endpoints**: RESTful endpoints for each objective's operations
2. **UI Components**: Hooks and components for displaying refund status, schedule review, etc.
3. **On-Chain Integration**: Contract methods for idempotency validation, schedule enforcement
4. **Compliance Reports**: Generate audit reports filtered by date range, actor, event type
5. **Notifications**: Email/SMS alerts for invite expiration, schedule changes, etc.

---

## Compliance & Security

- ✓ No automatic refund implications (Obj 1)
- ✓ Schedule immutable after contribution acceptance (Obj 2)
- ✓ Retry safety via idempotency keys (Obj 3)
- ✓ Complete audit trail for access control (Obj 4)
- ✓ Exponential backoff prevents DoS (Obj 3)
- ✓ Time-bounded invitations prevent stale access (Obj 4)
- ✓ Role-based access control enforced (Obj 4)
- ✓ All state transitions tracked and audited

---

## Commit Info

- **Commit Hash**: `8cb24d3`
- **Author**: Implementation for Objectives 1-4
- **Files Changed**: 12 (10 new, 2 modified)
- **Total Tests**: 57 passing
- **Test Coverage**: All 4 objectives with edge cases
