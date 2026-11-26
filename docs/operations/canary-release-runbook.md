# Canary Releases & Rollback Signals (Issue #282)

This runbook defines how Fundable stages a release, which signals decide whether
traffic advances, and how operators rehearse and execute rollback.

The implementation lives in `apps/web/src/lib/canary/canary-release.ts`. The
privileged HTTP boundary is `GET|POST /api/admin/canary`.

---

## 1. Rollout Stages

Traffic advances only through the ordered stages below. There is no stage
skipping: an operator promotes one stage at a time.

| # | Stage | Production traffic |
|---|-------|--------------------|
| 1 | `internal` | 1% |
| 2 | `early` | 5% |
| 3 | `partial` | 25% |
| 4 | `majority` | 50% |
| 5 | `full` | 100% (release becomes `stable`) |

A stage is observed for at least **10 minutes** (configurable) before it can be
promoted. Promotion always runs a fresh evaluation; a cached healthy result is
never reused.

---

## 2. Health Signals

The gate evaluates **every** critical journey for **every** promotion and for
rollback decisions. Journey metrics come from the SLO tracker
(`apps/web/src/lib/slo`); the default window is 15 minutes.

| Signal | Promotion | Rollback | Notes |
|--------|-----------|----------|-------|
| Journey samples | ≥ 20 per flow in the window | — | Fewer samples **block** promotion but never trigger rollback. |
| Error-budget burn rate | < 2.0x | ≥ 14.4x | Matches the ELEVATED (2.0x) and CRITICAL (14.4x) SLO alerts. |
| p95 latency | ≤ SLO target | > 1.5× SLO target | Per-flow targets come from `SLO_DEFINITIONS`. |
| Data-integrity check | must pass | any **critical** check failure | Non-critical failures only block promotion. |
| Integrity freshness | observation ≤ 5 min old | — | Stale observations block promotion. |
| Integrity wiring | ≥ 1 check registered | — | With no checks registered, **all** promotion is blocked (fail closed). |

Critical journeys: `reads`, `submission`, `webhooks`, `sync`.

A **blocking** signal holds traffic at the current stage. A **critical** signal
stops the rollout, sets `state = "rolled_back"`, sets traffic to 0%, and invokes
the rollback handler automatically.

---

## 3. Rollback Rehearsal (Required Before Start)

A release cannot start until rollback has been rehearsed for the exact
`(release, previousRelease)` pair. The rehearsal is a dry run and checks:

| Rehearsal check | Why it matters |
|-----------------|----------------|
| `rollback-target` | `release` and `previousRelease` must differ. |
| `rollback-handler` | Without a handler, traffic stops but the previous build is not restored. |
| `journey-signals` | Reads/submission/webhooks/sync SLO definitions must be registered. |
| `data-integrity-signals` | At least one integrity check must be wired; otherwise the gate can never pass. |
| `handler-dry-run` | The handler is invoked with `dryRun: true` within the timeout budget. |

Changing the rollback handler or the integrity-check set **invalidates** the
rehearsal, so a passing rehearsal always describes the criteria actually
enforced.

---

## 4. Operator API

All requests require `Authorization: Bearer <ADMIN_API_KEY>`. The route is
registered as `privileged` in `apps/web/src/lib/api-policy.ts`. When
`ADMIN_API_KEY` is unset the route fails closed with `503`.

### Read state

```bash
curl -sS -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://app.example.com/api/admin/canary
```

Response (`data`) includes `state`, `release`, `previousRelease`, `stage`,
`lastEvaluation` (journeys, integrity, signals), `rehearsal`, `rollback`
(`status`, `signals`, `failure`) and `nextActions`.

### Rehearse rollback

```bash
curl -sS -X POST -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"action":"rehearse","release":"web-2026.11.25","previousRelease":"web-2026.11.18","actor":"oncall@example.com"}' \
  https://app.example.com/api/admin/canary
```

`409 ROLLBACK_REHEARSAL_FAILED` returns the failed checks. Fix the wiring and
rehearse again; do not start the release.

### Start, evaluate, promote

```bash
# Start at 1% (requires a passing matching rehearsal)
-d '{"action":"start","release":"web-2026.11.25","previousRelease":"web-2026.11.18","actor":"oncall@example.com"}'

# Refresh signals (critical signals roll back automatically)
-d '{"action":"evaluate"}'

# Promote one stage after the observation window and a healthy evaluation
-d '{"action":"advance","actor":"oncall@example.com"}'
```

`409 OBSERVATION_WINDOW_NOT_MET` includes `details.retryAfterMs`.
`409 HEALTH_GATE_BLOCKED` includes the blocking `details.signals`.
`409 ROLLBACK_TRIGGERED` means critical signals already rolled the release back.

### Manual rollback

```bash
-d '{"action":"rollback","actor":"oncall@example.com","reason":"duplicate webhook deliveries"}'
```

Manual rollback is allowed even when signals look healthy.

---

## 5. Explicit Failure & Recovery States

| State / field | Meaning | Operator action |
|---------------|---------|-----------------|
| `state: "canary"` + blocking signals | Released but held at the current stage. | Fix the signal; re-evaluate; promote after the observation window. |
| `state: "rolled_back"`, `rollback.status: "completed"` | Automatic or manual rollback restored the previous release. | Verify the previous release is healthy; triage signals. |
| `state: "rolled_back"`, `rollback.status: "failed"` | **Traffic is stopped but the previous release was not restored.** | Restore the previous build manually, verify data integrity, record the failure. |
| `502 ROLLBACK_HANDLER_FAILED` | The handler threw or timed out (`data.rollback.failure`). | Treat as an incident; manual recovery is required. |
| `409 REHEARSAL_REQUIRED` | No matching passing rehearsal. | Run `rehearse` for this exact release pair. |
| `409 HEALTH_GATE_BLOCKED` | At least one blocking journey/integrity signal. | Hold traffic; resolve; re-evaluate. |

---

## 6. Wiring Signals

The default controller uses the process-wide `SLOTracker` singleton and has no
integrity checks registered (so promotion is blocked until one is added).
Deployments should configure the controller at startup:

```ts
import {
  getCanaryReleaseController,
  type IntegrityCheck,
} from "@/lib/canary";

const controller = getCanaryReleaseController();

controller.registerIntegrityCheck({
  name: "ledger-continuity",
  description: "Indexed ledgers have no gaps against Horizon/Soroban.",
  critical: true,
  run: async ({ now }) => {
    const snapshot = await loadIndexerHealth(); // your source of truth
    return snapshot.gapCount === 0
      ? { status: "pass", observedAt: now }
      : {
          status: "fail",
          observedAt: now,
          message: `${snapshot.gapCount} ledger gap(s) detected`,
        };
  },
});

controller.setRollbackHandler(async ({ previousRelease, dryRun }) => {
  if (dryRun) return; // rehearsal
  await promoteDeployment(previousRelease); // restore the previous build
});
```

Guidance:

- Keep integrity checks bounded (< 5s) and idempotent; a timeout is treated as a
  critical failure.
- Return `observedAt` when the observation is not produced at check time; stale
  observations block promotion.
- The rollback handler must be idempotent and must tolerate being called during a
  dry run.

---

## 7. Compatibility & Operational Constraints

- **No schema or API migration is required.** The feature is additive: a new
  privileged route and a new library module. Existing health, SLO, and admin
  endpoints are unchanged.
- **Process-local control state.** The controller singleton lives in the
  application process. In a multi-instance deployment, route operator actions to
  the control-plane instance (or inject a shared store before enabling
  automated promotion). The audit history in `data.history` is bounded to the
  most recent 100 events in that process.
- **Audit.** Every rehearsal, start, promotion, block, evaluation, rollback, and
  rollback failure is recorded in `history` with the operator-supplied `actor`.
  Pair this route with `docs/privileged-action-audit.md` for durable audit
  records.
- **Pausing on purpose.** No new traffic is promoted while signals are unknown.
  This is intentional: an unobservable canary is treated as unsafe.
