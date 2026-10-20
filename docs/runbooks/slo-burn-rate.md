# SLO Burn-Rate Alerting Runbook

This operational runbook provides step-by-step triage, diagnostic procedures, and mitigation workflows for Service Level Objective (SLO) burn-rate alerts across Fundable's four critical flows.

---

## 🧭 Overview & Alerting Tiers

Fundable utilizes **multi-window multi-burn-rate alerting** (Google SRE Standard) to identify reliable service degradation before the entire 30-day error budget is exhausted.

| Alert Tier | Burn Rate | Window | Budget Consumed | Notification | Response SLA |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **CRITICAL (P1)** | >= 14.4x | 1 Hour | 2% in 1 hr | PagerDuty (on-call page) | **< 15 minutes** |
| **WARNING (P2)** | >= 6.0x | 6 Hours | 5% in 6 hrs | Slack (`#incidents-p2`) | **< 1 hour** |
| **ELEVATED (P3)** | >= 2.0x | 24 Hours | 10% in 24 hrs | Daily Operations Digest | **Next business day** |

---

## 1. Reads Flow Degradation

**SLO Target:** 99.9% Availability \| Latency: p95 <= 250ms, p99 <= 500ms  
**Owning Team:** Core Platform Team (`@fundable/platform-core` / `platform-eng@fundable.org`)  
**Escalation Pager:** `pager-platform-core`

### Symptoms & Trigger Criteria
- `ReadsCriticalBurnRate1h` or `ReadsWarningBurnRate6h` fired.
- High error rates on `GET /api/campaigns/*`, `/api/healthz`, or GraphQL queries.
- High p95/p99 query latencies exceeding 250ms.

### Diagnostic Steps
1. **Inspect Cache Layers:**
   - Check Redis connectivity and hit/miss ratio:
     ```bash
     redis-cli info stats | grep -E "keyspace_hits|keyspace_misses"
     ```
   - Check if Redis memory is full (`maxmemory` eviction policy).
2. **Inspect Upstream Horizon API Status:**
   - Query Horizon root endpoint:
     ```bash
     curl -s https://horizon-testnet.stellar.org | jq .
     ```
   - Check Horizon rate limits (`X-Ratelimit-Remaining` response header).
3. **Inspect Application Error Spans:**
   - Search distributed trace spans with `api.campaigns` or `stellar.horizon` where `status=error`.

### Immediate Mitigations
- **Enable Circuit Breaker / Read Cache Fallback:** If upstream Horizon is lagging or rate-limited, switch read endpoints to cached snapshot mode.
- **Scale Redis Cluster:** If memory or CPU on Redis is saturated, trigger autoscaling or provision additional read replicas.
- **Failover Horizon Endpoint:** Switch `NEXT_PUBLIC_STELLAR_HORIZON_URL` to the secondary redundant Horizon cluster in `.env.local`.

---

## 2. Submission Flow Degradation

**SLO Target:** 99.5% Availability \| Latency: p95 <= 1500ms, p99 <= 3000ms  
**Owning Team:** Blockchain Operations Team (`@fundable/blockchain-ops` / `blockchain-ops@fundable.org`)  
**Escalation Pager:** `pager-blockchain-ops`

### Symptoms & Trigger Criteria
- `SubmissionCriticalBurnRate1h` or `SubmissionWarningBurnRate6h` fired.
- Failures on stream creation, token distribution, or withdrawal transactions.
- Excessive Soroban RPC timeouts or transaction reverts (`TransactionError`, `SimulationError`).

### Diagnostic Steps
1. **Check Stellar RPC Health:**
   - Verify Soroban RPC responsiveness:
     ```bash
     curl -s -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' https://soroban-testnet.stellar.org
     ```
2. **Analyze Stellar Transaction Error Codes:**
   - Filter logs for `TransactionError` and check `resultCodes` (`tx_bad_seq`, `tx_insufficient_fee`, `tx_failed`).
3. **Check Base Fee Spikes:**
   - If network congestion is elevated, transactions may time out due to low `baseFee`. Inspect network fee recommendations from RPC `getFeeStats`.

### Immediate Mitigations
- **Dynamic Fee Bump:** Temporarily increase `DEFAULT_BASE_FEE` or invoke fee-bump transaction wrappers if network minimum resource fees surged.
- **Sequence Number Resynchronization:** If transactions fail with `tx_bad_seq`, clear pending in-flight queues and refresh the source account sequence number from Horizon.
- **Switch Primary RPC Node:** Update `NEXT_PUBLIC_STELLAR_RPC_URL` to failover to secondary enterprise RPC provider.

---

## 3. Webhooks Flow Degradation

**SLO Target:** 99.9% Delivery Availability \| Latency: p95 <= 1000ms, p99 <= 2500ms  
**Owning Team:** Integrations & Ecosystem Team (`@fundable/integrations` / `integrations-team@fundable.org`)  
**Escalation Pager:** `pager-integrations`

### Symptoms & Trigger Criteria
- `WebhooksCriticalBurnRate1h` or `WebhooksWarningBurnRate6h` fired.
- Surge in entries written to `apps/web/data/webhook_dead_letter.json`.
- Partner webhook deliveries consistently failing or timing out at the 10-second threshold.

### Diagnostic Steps
1. **Inspect Dead-Letter Queue (DLQ):**
   - Check the newest DLQ records:
     ```bash
     cat apps/web/data/webhook_dead_letter.json | jq '.[-5:]'
     ```
   - Identify if failures are concentrated on a specific `subscriptionId` or destination URL.
2. **Check Egress Network Connectivity:**
   - Ensure the server environment is not experiencing DNS resolution failures or outbound TLS handshake timeouts.
3. **Analyze Distributed Spans:**
   - Filter spans where `name="webhook.deliver"` and `status="error"`. Inspect `http.status_code` and `error.message`.

### Immediate Mitigations
- **Suspend Problematic Subscriber:** If a single subscriber's destination endpoint is down (returning 500s or timing out), temporarily deactivate that subscription to prevent retries from consuming resources:
  ```bash
  curl -X DELETE https://app.fundable.org/api/webhooks/subscriptions/<subscription_id>
  ```
- **Drain DLQ for Redelivery:** Once the partner confirms recovery, use the redelivery tool to replay dropped deliveries from `webhook_dead_letter.json`.

---

## 4. Sync Flow Degradation

**SLO Target:** 99.9% Freshness (Lag <= 2 ledgers / 10s) \| Latency: p95 <= 300ms, p99 <= 600ms  
**Owning Team:** Node & Sync Operations Team (`@fundable/node-sync` / `node-sync@fundable.org`)  
**Escalation Pager:** `pager-node-sync`

### Symptoms & Trigger Criteria
- `SyncCriticalBurnRate1h` or `SyncWarningBurnRate6h` fired.
- Event aggregation and campaign on-chain milestones drifting behind the latest network ledger.
- Ingestion poll errors or WebSocket disconnection storms.

### Diagnostic Steps
1. **Compare Ingested Ledger vs Latest Network Ledger:**
   ```bash
   LATEST=$(curl -s https://horizon-testnet.stellar.org/ledgers?order=desc&limit=1 | jq ._embedded.records[0].sequence)
   CURRENT=$(curl -s http://localhost:3000/api/healthz | jq .latestProcessedLedger)
   echo "Lag: $((LATEST - CURRENT)) ledgers"
   ```
2. **Check Redis Queue Depth:**
   - Verify if event processing queues are backed up:
     ```bash
     redis-cli llen fundable:event_sync_queue
     ```

### Immediate Mitigations
- **Fast-Forward Checkpoint:** If lag is caused by historical re-indexing, advance checkpoint cursor to recent finalized ledger and run background worker to fill historical gaps.
- **Restart Sync Worker:** If stream listener became detached:
  ```bash
  pm2 restart stellar-sync-worker
  ```
