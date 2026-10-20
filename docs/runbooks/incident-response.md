# Security Incident Response Runbook

This runbook establishes standard operating procedures for detecting, triaging, containing, eradicating, and recovering from security incidents affecting Fundable Protocol services, smart contracts, and infrastructure.

---

## 🚨 Incident Severity Classification

| Severity | Definition | Target Triage | Target Containment | Escalation Path |
| :--- | :--- | :--- | :--- | :--- |
| **SEV-0 (Critical)** | Active smart contract exploit, private key compromise, unauthorized fund drain, or catastrophic data loss. | **< 5 min** | **< 15 min** | Immediate page to Executive & Security Leads |
| **SEV-1 (High)** | Impaired critical flow, unauthorized admin state changes, webhook signature forgery, or API authentication bypass. | **< 15 min** | **< 45 min** | On-call Security Lead & Blockchain Ops |
| **SEV-2 (Medium)** | Non-critical component disruption, single-tenant data leak, elevated burn rates, or unverified webhook failures. | **< 1 hour** | **< 4 hours** | Primary Service Owner & Security Triage |
| **SEV-3 (Low)** | Minor misconfiguration, non-exploitable anomaly, or dependency vulnerability with no active exploit vector. | **< 24 hours** | **< 3 days** | Standard ticketing queue |

---

## 👥 Incident Response Team Roles

- **Incident Commander (IC):** Directs the overall incident response, assigns roles, and maintains the incident timeline.
- **Operations Lead (Ops):** Executes tactical containment, key rotations, node failover, and infrastructure adjustments.
- **Security & Forensics Lead:** Conducts root-cause analysis, gathers cryptographic evidence, and validates remediation.
- **Communications Lead:** Manages internal updates and drafts external transparency disclosures / community notices.

---

## 🔄 Incident Response Lifecycle

### Phase 1: Detection & Triage
1. **Source of Alert:** Prometheus/Alertmanager alert, anomaly monitor, user report, or Sentry telemetry.
2. **Declaration:** The first responder declares an incident in `#incidents-security` via `/incident declare <SEV>`:
   - Sets up dedicated incident war room (voice bridge & shared document).
   - Assigns Incident Commander.
3. **Assessment:** Verify whether on-chain state or off-chain data stores are compromised. Check Horizon account signers, ledger transaction history, and contract balances.

### Phase 2: Containment & Isolation
1. **Trigger Emergency Circuit Breaker:**
   - For compromised campaign pools or distributors, activate emergency containment:
     ```bash
     POST /api/campaigns/{id}/suspend
     ```
   - In application runtime, invoke `EmergencyCircuitBreaker.triggerContainment()`.
2. **Network / Access Isolation:**
   - Revoke active API tokens and session keys for compromised accounts.
   - Restrict access to affected services via IP allowlisting or edge firewall rules.
3. **Protect Unaffected Assets:**
   - Move uncompromised funds from hot accounts to cold multi-sig vaults if hot signers are suspect.

### Phase 3: Eradication & Remediation
1. **Key & Role Rotation:** Execute the procedures in [`docs/runbooks/key-compromise.md`](./key-compromise.md):
   - Set compromised signer weight to `0` on-chain.
   - Rotate contract admin roles.
   - Rotate webhook HMAC secrets using dual-secret grace period.
2. **Patch Vulnerability:** Deploy tested code fixes addressing the root vulnerability.
3. **Database & State Sanitization:** Eliminate any backdoors, unauthorized webhook registrations, or injected entries.

### Phase 4: Recovery & Verification
1. **Verify Signer Quorum:** Confirm on-chain signers satisfy threshold and compromised key holds weight `0`.
2. **Execute Isolated Smoke Tests:** Verify read, submission, and webhook flows in test environments.
3. **Lift Containment:** Incident Commander and Security Lead authorize lifting containment:
   ```ts
   circuitBreaker.liftContainment(operatorId, 'All signers rotated and verified');
   ```
4. **Monitor Error Budgets:** Closely watch burn rates across critical flows for 48 hours post-recovery.

### Phase 5: Communication Protocol
1. **Internal Updates:** Hourly status reports posted to executive leadership.
2. **External Advisory (if SEV-0 / SEV-1):**
   - Publish advisory within 24 hours of containment.
   - Standard Security Advisory Format:
     - **Summary:** Scope and impact of the incident.
     - **Timeline:** Key events from detection to containment.
     - **Resolution:** Actions taken (keys rotated, contracts paused/updated).
     - **User Action Required:** Steps users or partners must take (e.g. updating webhook secrets).

### Phase 6: Post-Incident Review (PIR)
- Conduct a blameless postmortem within 5 business days.
- Produce postmortem document:
  - Root Cause Analysis (5 Whys).
  - Preventative action items with designated owners and target dates.
  - SLO error budget recalculation.
