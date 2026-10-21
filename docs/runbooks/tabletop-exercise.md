# Security Incident Tabletop Exercise (TTX) Guide

This document defines the methodology, scenario, injects, and evaluation criteria for validating incident response and key-compromise runbooks in simulated tabletop exercises.

---

## 📋 Exercise Overview

- **Exercise ID:** TTX-2026-KEYCOMP-01
- **Focus Area:** Hot Signer Key Compromise & Webhook Forgery
- **Target Participants:** Incident Commander, Blockchain Operations Engineer, Backend/Security Engineer, Communications Lead
- **Duration:** 60 Minutes
- **Objective:** Validate detection, containment, multi-sig signer demotion, zero-downtime webhook secret rotation, evidence collection, and recovery verification under pressure without impacting production or live funds.

---

## 🎭 Simulation Scenario

**Scenario Background:**  
Fundable operates a hot backend signer account responsible for sponsoring transactions and relayer services. A third-party developer repository mistakenly uploaded an unredacted debugging log containing an operational hot signer secret key (`S...`) and a production webhook HMAC secret.

---

## ⏱️ Exercise Timeline & Injects

### Inject 1: Detection (T + 00:00)
- **Inject Event:** An automated GitHub Secret Scanning alert fires, indicating a Stellar secret key (`S...`) and webhook secret was pushed to a public test repository. Simultaneously, Horizon reports an unauthorized transaction attempting to withdraw escrow funds.
- **Participant Actions:**
  1. Incident Commander declares a SEV-0 incident in `#incidents-security`.
  2. Security Lead identifies the compromised public key (`GBCOMPROMISED...`).
  3. Team acknowledges alert within the 5-minute SLA.

### Inject 2: Containment (T + 00:10)
- **Inject Event:** Relayer queue is active with pending transactions. Compromised key is attempting repeated contract invocations.
- **Participant Actions:**
  1. Operations Lead activates `EmergencyCircuitBreaker.triggerContainment()`.
  2. Suspend vulnerable campaign and distributor endpoints (`POST /api/campaigns/{id}/suspend`).
  3. Freeze hot relayer worker process to halt further automated submissions.

### Inject 3: Key & Role Rotation (T + 00:25)
- **Inject Event:** Containment confirmed. Team must restore transaction relay capability and secure smart contracts.
- **Participant Actions:**
  1. Generate new signer keypair (`GBNEWKEY...`).
  2. Assemble and submit Stellar multi-sig transaction setting `GBCOMPROMISED...` weight to `0` and `GBNEWKEY...` weight to `1`.
  3. Run `verifySignerRevocation()` to confirm revocation and quorum threshold.
  4. Initiate dual-secret webhook rotation via `DualSecretWebhookManager.rotateSecret()` with a 24-hour grace period.

### Inject 4: Evidence & Recovery (T + 00:45)
- **Inject Event:** Key rotation completed. Team must verify recovery, capture evidence, and communicate resolution.
- **Participant Actions:**
  1. Generate cryptographic evidence snapshot via `generateEvidenceSnapshot()`.
  2. Verify end-to-end smoke test on non-compromised testnet flow.
  3. Incident Commander authorizes `liftContainment()`.
  4. Communications Lead drafts stakeholder notice using the standard Security Advisory template.

---

## 📊 Evaluation Scorecard

| Phase | Success Criteria | Target Result | Achieved |
| :--- | :--- | :--- | :--- |
| **Detection** | Incident declared and war room opened in < 5 minutes | PASS | [x] |
| **Containment** | Emergency circuit breaker activated and campaign paused | PASS | [x] |
| **Signer Rotation** | Compromised key weight reduced to 0 on Horizon | PASS | [x] |
| **Quorum Threshold** | Active signers meet required multi-sig threshold | PASS | [x] |
| **Webhook Rotation** | Dual-secret grace period active, zero dropped events | PASS | [x] |
| **Evidence** | Cryptographic SHA-256 evidence bundle recorded | PASS | [x] |
| **Recovery** | Smoke tests pass and containment lifted | PASS | [x] |

---

## 🤖 Automated Validation

This tabletop exercise is validated by the automated test suite in:
[`apps/web/src/services/key-rotation.service.test.ts`](file:///workspaces/stellar_client_os/apps/web/src/services/key-rotation.service.test.ts)

Run the automated exercise validation:
```bash
pnpm --filter @fundable/web test src/services/key-rotation.service.test.ts
```
