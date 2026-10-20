# Service Level Objectives (SLOs) & Alert Thresholds

This document defines the production Service Level Objectives (SLOs), Service Level Indicators (SLIs), error budgets, and multi-window burn-rate alert thresholds for the Fundable Stellar Client platform.

---

## 🎯 Target Matrix

| Critical Flow | SLI Description | Availability Target | Error Budget (30-day) | Latency p95 | Latency p99 | Owning Team | Escalation Pager |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Reads** | Successful HTTP 2xx on campaign queries, account balances, leaderboard, analytics | **99.9%** | 0.1% (1 in 1,000) | <= 250ms | <= 500ms | Core Platform Team (`@fundable/platform-core`) | `pager-platform-core` |
| **Submission** | Successful smart contract invocations, stream creation, payouts, withdrawals | **99.5%** | 0.5% (1 in 200) | <= 1500ms | <= 3000ms | Blockchain Operations (`@fundable/blockchain-ops`) | `pager-blockchain-ops` |
| **Webhooks** | Successful HTTP 2xx acknowledgment within retry backoff window | **99.9%** | 0.1% (1 in 1,000) | <= 1000ms | <= 2500ms | Integrations & Ecosystem (`@fundable/integrations`) | `pager-integrations` |
| **Sync** | Ledger indexer freshness (lag <= 2 ledgers / 10s) and cache sync | **99.9%** | 0.1% (1 in 1,000) | <= 300ms | <= 600ms | Node & Sync Team (`@fundable/node-sync`) | `pager-node-sync` |

---

## 📐 Mathematical Formulation

### 1. Availability Ratio
$$\text{Availability} = \frac{\text{Successful Requests}}{\text{Total Valid Requests}}$$

### 2. Error Budget
$$\text{Error Budget} = 1.0 - \text{Target Availability}$$
For example, an availability target of $99.9\%$ yields an error budget of $0.1\%$ ($0.001$).

### 3. Burn Rate Multiplier
The **burn rate** measures how fast the service is consuming its error budget relative to the acceptable baseline consumption rate:
$$\text{Burn Rate} = \frac{\text{Observed Error Rate}}{\text{Allowed Error Budget}}$$
- A burn rate of **1.0x** means the service will consume exactly 100% of its 30-day error budget in 30 days.
- A burn rate of **14.4x** means the service will consume **2% of its entire 30-day budget in just 1 hour**.

---

## 🚨 Multi-Window Burn-Rate Alerting Rules

Following Google SRE best practices, alerts are evaluated over short and medium windows to detect acute outages immediately while catching chronic slower degradation.

| Severity | Window | Burn Rate | Budget Consumed | Primary Channel | Runbook Link |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **CRITICAL (P1)** | 1 Hour | **>= 14.4x** | 2.0% in 1 hr | PagerDuty | [`docs/runbooks/slo-burn-rate.md`](./runbooks/slo-burn-rate.md) |
| **WARNING (P2)** | 6 Hours | **>= 6.0x** | 5.0% in 6 hrs | Slack `#incidents-p2` | [`docs/runbooks/slo-burn-rate.md`](./runbooks/slo-burn-rate.md) |
| **ELEVATED (P3)** | 24 Hours | **>= 2.0x** | 10.0% in 24 hrs | Daily Digest Email | [`docs/runbooks/slo-burn-rate.md`](./runbooks/slo-burn-rate.md) |

---

## 🔧 Prometheus / Alertmanager Deployment

Alert rules are defined in [`monitoring/prometheus-slo-rules.yml`](../monitoring/prometheus-slo-rules.yml).
The application exposes SLO metrics in standard Prometheus gauge format via the internal health and monitoring endpoints.

### PromQL Verification
```promql
# Current 1-hour burn rate for submission flow
fundable_slo_burn_rate{flow="submission",window="1h"}

# 95th percentile latency for reads flow
fundable_slo_latency_p95_ms{flow="reads"}
```
