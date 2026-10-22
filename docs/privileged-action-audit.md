# Privileged Administrative Action Audit — issue #109

This document describes how privileged administrative actions are audited,
how access is enforced, how long audit entries are retained, and how the
behavior is tested.

## What is recorded

Every privileged operation is recorded with:

- `actor` — public actor identifier (wallet address or service account)
- `actorRole` — `admin` | `operator` | `auditor` | `viewer`
- `action` — e.g. `deploy.contract`, `initialize.contract`,
  `rotate.credential`, `delete.personal_record`, `export.personal_data`,
  `modify.retention_policy`
- `target` — the thing acted upon (contract id, record id, credential id)
- `timestamp` — ISO 8601 UTC
- `requestId` — caller-supplied correlation id
- `outcome` — `ALLOWED` | `DENIED`
- `metadata` — additional context, sanitized so secrets are never stored

Secrets (secret keys, tokens, passwords, passphrases, and Stellar secret-key
values) are redacted to `[REDACTED]` by `sanitizeMetadata` before storage.

The implementation lives in `packages/sdk/src/audit.ts`:

- `AuditLogger` — append-only log (`record`, `list`, `findByActor`,
  `findByAction`, `findByTarget`, `findByRequestId`, `count`,
  `purgeOlderThan`).
- `AccessController` — least-privilege enforcement (`isAllowed`, `enforce`).
- `PrivilegedActionRecorder` — wraps an operation: enforce access, run it, and
  audit `ALLOWED`/`DENIED` with actor, action, target, timestamp, request ID.

## Access model (least privilege)

- `admin`: every privileged action.
- `operator`: `deploy.contract`, `initialize.contract`, `rotate.credential`,
  `delete.personal_record`. Operators may **not** export personal data or
  modify the retention policy.
- `auditor` / `viewer`: read-only; all privileged write actions are denied.

Denials throw `AuditError` (`ACCESS_DENIED`) and are still audited so failed
attempts are visible.

## Retention

Audit entries are retained until explicitly purged via
`AuditLogger.purgeOlderThan(cutoff, actor, requestId)`. The purge itself is
recorded as a `modify.retention_policy` entry so retention enforcement is
auditable. Operators should align the purge cutoff with statutory and
organizational requirements (e.g. keep privileged-action evidence for as long
as tax/verification records are retained — see
`docs/data-retention-deletion.md`).

## Negative tests

`packages/sdk/src/__tests__/audit.test.ts` includes negative coverage:

- unauthorized roles (`viewer`, `auditor`) are denied and the denial is
  audited;
- operation failures are audited as `DENIED` and rethrown;
- secrets placed in metadata are redacted;
- invalid purge cutoffs raise `INVALID_CUTOFF`.

All tests are deterministic (fixed clocks and id generators) and use no
network or live funds. CI validates via the SDK coverage job.
