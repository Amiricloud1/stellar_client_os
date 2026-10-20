# Liveness & Readiness Dependency Health Probes (Issue #101)

This document describes the architecture, timeout budgets, orchestrator response contracts, and migration guidance for Fundable's separated liveness and readiness health check endpoints.

---

## 1. Why Separate Liveness and Readiness?

Container orchestrators (Kubernetes, ECS, Nomad, Fly.io) use two distinct probe types:

1. **Liveness Probe (`GET /api/livez` or `GET /api/healthz?check=app`):**
   - Verifies that the Node.js / Next.js application process and event loop are alive and serving HTTP requests.
   - **Never** performs network I/O to external dependencies (Stellar Horizon, Soroban RPC, Redis, or S3).
   - Prevents cascading container restart loops during transient upstream RPC or cache outages.

2. **Readiness Probe (`GET /api/readyz` or `GET /api/healthz?probe=readiness`):**
   - Concurrently probes critical external dependencies (`horizon`, `sorobanRpc`, `redis`, `storage`) with strict bounded timeouts.
   - Signals load balancers to temporarily remove an instance from rotation (`HTTP 503`) if critical dependencies are unreachable, without killing the container.

---

## 2. Dependency Probes & Bounded Timeout Budgets

All dependency probes are wrapped in `withBoundedTimeout` (`[50ms, 15000ms]`) in `apps/web/src/lib/dependency-health.ts`:

| Dependency | Probe Key | Default Timeout | Critical by Default | Probe Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **Stellar Horizon** | `horizon` | `5000 ms` | Yes | `GET {HORIZON_URL}/` expecting HTTP 2xx and `horizon_version` |
| **Soroban RPC** | `sorobanRpc` | `3000 ms` | Yes | `POST {SOROBAN_RPC_URL}` JSON-RPC `getHealth` expecting `result.status === "healthy"` |
| **Redis Cache** | `redis` | `1500 ms` | Configurable (`REDIS_REQUIRED=true`) | `PING` command expecting `PONG` |
| **S3 Evidence Storage** | `storage` | `2000 ms` | Configurable (`STORAGE_REQUIRED=true`) | Zod credential/bucket schema validation + optional storage reachability probe |

---

## 3. Orchestrator-Compatible Response States

Both `/api/readyz` and `/api/healthz` include `Cache-Control: no-store`.

| Aggregate Status | Default HTTP Code | Strict Mode (`?strict=true`) | Condition |
| :--- | :--- | :--- | :--- |
| `"ok"` | `200 OK` | `200 OK` | All critical and configured optional dependencies are healthy. |
| `"degraded"` | `200 OK` | `503 Service Unavailable` | Core dependencies (`horizon`, `sorobanRpc`) are up, but an optional fail-safe dependency (`redis` or `storage` when `REQUIRED=false`) is degraded. |
| `"unhealthy"` | `503 Service Unavailable` | `503 Service Unavailable` | Any critical dependency (`horizon`, `sorobanRpc`, or required `redis`/`storage`) is unreachable or timed out. |

---

## 4. Compatibility & Migration Implications

- **Existing `/api/healthz` Callers:** `GET /api/healthz` and `GET /api/healthz?check=app` retain 100% backward compatibility with the original response payload (`{ status, checks: { app, horizon }, timestamp }`).
- **Kubernetes / Orchestrator Migration:**
  - Point `livenessProbe.httpGet.path` to `/api/livez`.
  - Point `readinessProbe.httpGet.path` to `/api/readyz` (or `/api/readyz?strict=true` for zero-degradation routing).
