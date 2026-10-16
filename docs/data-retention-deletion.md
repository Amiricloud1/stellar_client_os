# Data Retention and Auditable Deletion — issue #106

This document describes how the Fundable Protocol inventories personal-data
categories, applies retention periods, and performs auditable deletion. It is
the operator and contributor reference for the retention schedule, deletion
workflow, compatibility/migration guidance, and tests.

## Personal-data inventory

| Category | Contents | Default retention | Rationale |
|----------|----------|-------------------|-----------|
| `tax` | Annual earnings / 1099-style records derived from the sponsorship ledger | 2555 days (7 years) | Statutory tax-filing and audit windows |
| `verification` | Nonprofit-partner verification status, sponsor/partner identifiers, onboarding artifacts | 1095 days (3 years) | Verification lifecycle and dispute handling |
| `upload_metadata` | Milestone-upload metadata (object keys, content types, presigned-URL logs) | 90 days | Operational troubleshooting only |

Retention rules live in `packages/sdk/src/retention.ts`:

- `DEFAULT_RETENTION_RULES` — the schedule above.
- `RetentionPolicy.getRule(category)` / `setRule(rule)` — resolve or override
  per-deployment retention periods.
- `RetentionPolicy.isPastRetention(record, now)` — pure eligibility check.

Records never contain secrets. The `subjectId` is a public identifier
(wallet address); no secret keys, tokens, or passphrases are stored.

## Deletion workflow

`RetentionManager` holds personal records and performs deletion:

1. `addRecord(record)` — ingest a personal record.
2. `eligibleForDeletion(now)` — list records past retention (no mutation).
3. `scheduleDeletion(recordId, request)` — delete a record.
4. `listDeletions()` / `purgeDeletionRecordsOlderThan(cutoff, …)` — inspect and
   retire deletion records.

`scheduleDeletion` enforces retention by default:

- Records past retention are deleted and an auditable `DeletionRecord` is
  created (`recordId`, `category`, `subjectId`, `action: "DELETE"`, `reason`,
  `actor`, `requestId`, `timestamp`, `emergencyOverride`).
- Records not past retention raise `RetentionError` (`NOT_PAST_RETENTION`) and
  the record is preserved — unless the caller sets `emergencyOverride: true`,
  in which case the deletion proceeds and is flagged as an override.
- Missing records raise `RetentionError` (`RECORD_NOT_FOUND`).

Every deletion is also written to the audit log (`delete.personal_record`,
see `docs/privileged-action-audit.md` for the access model) with actor, action,
target, timestamp, and request ID. Metadata is sanitized so no secrets are
stored.

## Compatibility / migration implications

- Adopting retention makes existing personal records older than a category's
  period immediately eligible for deletion. Operators must run a one-time
  `eligibleForDeletion` backfill against existing tax, verification, and
  upload stores before enabling automated deletion.
- Deletion is irreversible. Confirm legal, contractual, and tax obligations
  before deleting statutory records.
- Changing a retention period via `setRule` only affects future eligibility;
  stored records are not migrated.

## Automated coverage (deterministic, independent of live funds)

`packages/sdk/src/__tests__/retention.test.ts` covers success, failure, and
boundary cases with a fixed clock — no network, no live funds:

- Success: deletes a past-retention record, audits it, removes it from the
  store, preserves a no-secrets audit entry.
- Failure: rejects premature deletion (`NOT_PAST_RETENTION`, record preserved),
  rejects unknown records (`RECORD_NOT_FOUND`), rejects unknown categories.
- Boundary: a record exactly at the retention limit is not eligible;
  rate/expiry edges, rule overrides, and deletion-record purges are asserted.

CI validates this via the SDK coverage job (`pnpm test:sdk:coverage`).
