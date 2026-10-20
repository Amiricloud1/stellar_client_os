# API and Wallet Contracts

This document is the contributor and operator reference for the API and wallet
integration contracts. It covers:

- durable source-of-truth and transaction boundaries for campaign state and
  webhook subscriptions (#64),
- the standardized API error envelope and request-ID correlation contract,
  including migration notes for clients (#67),
- how to run the end-to-end (E2E) fundraising journeys locally and in CI with
  deterministic fixtures (#72),
- the wallet transaction error recovery contract and safe actions (#74).

All automated suites described here are deterministic and never touch live
funds. They use mocked wallets, mocked RPC, and seeded fixtures.

---

## 1. Durable source of truth and transaction boundaries (#64)

### 1.1 Source of truth

The API's database is the **single durable source of truth** for:

- **Campaign state** — campaign records, their lifecycle status, and the
  contribution/verification state derived from them.
- **Webhook subscriptions** — registered endpoints, their secrets, and their
  enabled/disabled status.

No in-memory cache, process-local map, or client-side store is authoritative.
Caches are read-through only and must be safe to discard at any time. If a
cached value disagrees with the database, the database wins.

### 1.2 Transaction boundaries

Each mutating API operation is a single logical transaction:

- **Campaign writes** (create, status transition, contribution/verification
  updates) commit atomically. A campaign is never observable in a partially
  applied state. Status transitions and their derived fields are written in the
  same transaction.
- **Webhook subscription writes** (create, update, enable/disable, delete)
  commit atomically. A subscription and its secret are persisted together; a
  subscription is never active without a persisted secret.
- **Webhook delivery bookkeeping** is recorded separately from the subscription
  record. Delivery attempts do not mutate the subscription's durable identity.

Reads are consistent with the last committed transaction. There is no
requirement that reads observe uncommitted writes.

### 1.3 Durability and restart behavior

Records written through the API survive process restart. The automated suite
verifies this by:

1. writing campaign state and webhook subscriptions through the API,
2. tearing down and recreating the application/process boundary,
3. reading the records back and asserting they are intact.

Operators should treat the database as the recovery point. Backups and
restores must include both campaign and webhook subscription tables. There is
no separate recovery path for webhook subscriptions; they are recovered with
the same database restore as campaign state.

### 1.4 Compatibility and migration implications

- Any code that previously treated an in-memory structure as authoritative must
  be migrated to read from the database.
- Schema changes to campaign or webhook subscription tables are migrations and
  must be applied before deploying code that depends on them.
- Because writes are transactional, clients must not assume partial success.
  A failed write leaves no partial record.

---

## 2. API error envelope and request-ID correlation (#67)

### 2.1 Error envelope

All API errors return a structured JSON envelope. Stack traces and internal
implementation details are never included in responses.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable summary.",
    "requestId": "req_01H...",
    "fields": [
      { "field": "amount", "code": "INVALID", "message": "Must be positive." }
    ]
  }
}
```

Fields:

- `error.code` — stable, machine-readable error code (see below).
- `error.message` — safe, human-readable summary. Never contains stack traces.
- `error.requestId` — the correlation ID for this request.
- `error.fields` — optional array of field-level errors, each with `field`,
  `code`, and `message`. Present for validation failures; omitted otherwise.

### 2.2 Error codes

Error codes are stable identifiers. Clients should branch on `code`, not on
`message`. Representative codes:

- `VALIDATION_ERROR` — request failed field validation; see `fields`.
- `NOT_FOUND` — the addressed resource does not exist.
- `CONFLICT` — the request conflicts with current state.
- `UNAUTHORIZED` — authentication is missing or invalid.
- `FORBIDDEN` — authenticated but not permitted.
- `RATE_LIMITED` — too many requests.
- `INTERNAL_ERROR` — unexpected server failure; details are logged, not
  returned.

New codes may be added. Clients must handle unknown codes gracefully by falling
back to `message`.

### 2.3 Request IDs and log correlation

Every request has a request ID:

- If the client supplies a request ID header, it is used (subject to format
  validation).
- Otherwise the server generates one.

The same request ID is:

- returned in the response (both success and error responses) and in
  `error.requestId`,
- attached to every server log line emitted while handling the request.

This lets operators take a request ID from a client report and find the exact
server logs for that request.

### 2.4 Migration notes for clients

- **Before:** clients may have parsed free-form error strings or HTTP status
  codes only.
- **After:** clients must read `error.code` for branching and `error.fields`
  for field-level validation display. `error.message` is for display only.
- Clients should capture and surface `error.requestId` (or the response request
  ID header) in support flows.
- Clients must not depend on the presence of stack traces or internal detail;
  these are intentionally excluded.
- Clients that send their own request IDs must use a valid format; invalid IDs
  are replaced by a server-generated one.

---

## 3. End-to-end fundraising journeys (#72)

### 3.1 What is covered

The E2E suite automates the critical fundraising journeys:

- **Campaign discovery** — browsing and finding campaigns.
- **Mocked wallet connect** — connecting a wallet using a deterministic mock;
  no real wallet or funds are involved.
- **Contribution preparation** — preparing a contribution through the UI with
  mocked RPC/simulation.
- **Verification state** — observing the verification state transition.
- **Receipt display** — rendering the receipt after a prepared/confirmed
  contribution.

### 3.2 Deterministic fixtures

E2E tests use seeded fixtures for campaigns, contributions, and wallet state.
Fixtures are reset before each run so results are reproducible. The suite never
depends on live funds, live RPC, or external network state. Wallet and RPC
interactions are mocked.

### 3.3 Running locally

1. Install dependencies and build the workspace.
2. Start the API and web app against the test database.
3. Seed fixtures.
4. Run the E2E suite.

The exact commands are defined by the workspace scripts. Run the E2E script
documented in the repository's package scripts; it seeds fixtures, runs the
journeys, and tears down the environment.

### 3.4 Running in CI

CI runs the E2E suite on every pull request. The CI job:

- provisions the test database,
- seeds deterministic fixtures,
- runs the E2E journeys headlessly,
- fails the build on any journey failure.

E2E results are required checks; a failing journey blocks merge.

### 3.5 Compatibility and migration implications

- Changes to campaign discovery, wallet connect, contribution preparation,
  verification, or receipt UI must keep the E2E journeys passing or update the
  fixtures and journeys together.
- Fixtures are part of the contract; changing seed data requires updating the
  affected journeys.

---

## 4. Wallet transaction error recovery (#74)

### 4.1 Failure classes and safe actions

Wallet flows map failures to safe, user-recoverable actions. The contract:

| Failure class | Examples | Safe action |
| --- | --- | --- |
| Wallet not connected | No account available | Prompt reconnect; preserve form values. |
| Wrong network | Chain mismatch | Prompt network switch; preserve form values. |
| User rejection | User declined in wallet | Show cancellation; allow retry; preserve form values. |
| Simulation failure | Pre-flight simulation reverts | Show reason; allow retry after correction; preserve form values. |
| RPC failure | Timeout, unavailable node | Show transient error; allow retry; preserve form values. |
| Contract revert | On-chain revert | Show revert reason; do not auto-retry; preserve form values. |

### 4.2 Guarantees

- **Form values are preserved** across all recoverable failures. Users never
  have to re-enter inputs after a retry, network switch, or reconnect.
- **Retry** is offered for transient failures (RPC, simulation, user
  rejection).
- **Network switch** is offered when the failure is a chain mismatch; after a
  successful switch the flow resumes with preserved values.
- **Reconnect** is offered when the wallet is disconnected; after reconnect the
  flow resumes with preserved values.
- **No silent retries** of contract reverts; these require user action.

### 4.3 Testing

The suite covers, deterministically and without live funds:

- retry after transient failure,
- network switch and resume,
- reconnect and resume,
- preservation of form values in each case,
- contract revert handling (no auto-retry).

Wallet and RPC are mocked; tests assert both the safe action offered and the
preserved form state.

### 4.4 Compatibility and migration implications

- New wallet failure modes must be mapped to one of the failure classes above
  and given a safe action; unmapped failures must fall back to a generic
  recoverable error that preserves form values.
- UI changes to wallet flows must keep the recovery tests passing.

---

## 5. CI validation

CI validates all suites described in this document:

- API unit and integration tests, including durability/restart tests for
  campaign state and webhook subscriptions (#64),
- API error envelope and request-ID correlation tests (#67),
- E2E fundraising journeys with deterministic fixtures (#72),
- wallet transaction error recovery tests (#74).

All suites are deterministic and independent of live funds. A failing suite
blocks merge. Contributors should run the relevant suites locally before
opening a pull request.