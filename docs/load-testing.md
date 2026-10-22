# Load-Testing Public APIs and Indexing Workloads — issue #107

This document describes the repeatable burst and soak load profiles, the
latency/error/resource thresholds, and the recovery checks used to validate
public API and indexing workloads.

## Profiles

All load runs use `packages/sdk/src/load-test.ts`:

- **Soak** (`SoakProfile`): sustained `concurrency` for `durationMs`.
  Models long-lived indexing load (e.g. the CDC indexer poll cycle,
  webhook fan-out) and steady public-API traffic.
- **Burst** (`BurstProfile`): concurrency ramps from 1 to `concurrency` over
  `rampUpMs`, then holds for the remainder of `durationMs`. Models deploy-time
  spikes, backlog catch-up, and traffic surges against RPC/indexing
  endpoints.

`runLoadProfile(target, spec, thresholds)` returns a `LoadTestResult` with
operation counts, success/failure totals, average/p95/max latency, error rate,
peak memory, duration, the breached thresholds, and an overall `passed` flag.

## Thresholds

`Thresholds`:

- `maxAvgLatencyMs` — average end-to-end operation latency must stay under
  this bound.
- `maxP95LatencyMs` — tail latency guard; p95 above this fails the run.
- `maxErrorRate` — fraction of failed operations (strictly greater than the
  bound fails).
- `maxMemoryMb` (optional) — peak heap use must stay under this bound.

## Recovery checks

`recoveryCheck(target, { checks, delayMs, maxAttempts })` probes the target
after a load burst until it answers successfully `checks` times in a row.
It returns `true` when the service is observed to have recovered, `false`
when it stays unhealthy — the standard gate before re-enabling traffic after
a burst, an RPC failover, or an indexer restart.

## Isolated infrastructure

Load runs execute against a `LoadTarget` implemented by a local mock in
tests — never against live networks, production RPC, or live funds. Target a
staging/testnet mirror only from a dedicated load job, and never let load
traffic touch mainnet wallets or production databases.

## Automated coverage (deterministic)

`packages/sdk/src/__tests__/load-test.test.ts`:

- Success: soak and burst pass against a healthy mock; metrics are reported.
- Failure: high error rates and latency breaches fail with named breaches.
- Boundary: an error rate exactly at `maxErrorRate` passes; just above fails;
  zero-operation runs are handled.
- Recovery: a target that fails then recovers returns `true`; a permanently
  broken target returns `false`.

CI validates via the SDK coverage job. Runs are time-bounded (100ms-scale
mock delays) so the suite stays fast and repeatable.
