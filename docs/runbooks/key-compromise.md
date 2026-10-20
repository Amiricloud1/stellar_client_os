# Key Compromise & Role Rotation Runbook

This playbook provides actionable, step-by-step procedures for containing, rotating, and verifying compromised cryptographic keys and administrative roles across Fundable Protocol.

---

## 🎯 Threat Model & Key Categories

| Key Category | Example Role | Blast Radius | Rotation Mechanism |
| :--- | :--- | :--- | :--- |
| **Stellar Hot Signer** | Relayer / Backend transaction submitter | Unauthorized payment streams, drained relayer XLM fee pool | Multi-sig signer weight demotion (weight -> 0) |
| **Contract Admin Key** | PaymentStream / Distributor contract admin | Unauthorized parameter changes, fund redistribution | Soroban contract admin transfer method |
| **Webhook HMAC Secret** | Shared secret for event verification (`whsec_...`) | Webhook spoofing, unauthorized notification replay | Zero-downtime dual-secret rotation |
| **Infrastructure Secrets** | S3 access keys, Redis credentials, JWT secret | Unauthorized storage writes, cache tampering | Secret Manager rotation & rolling redeployment |

---

## 1. Detection

Key compromise may be detected via:
1. **On-Chain Anomaly:** Unexpected transaction submitted by hot signer (e.g., unauthorized transfer or parameter update).
2. **Credential Exposure:** Secret key detected in public repository, CI log, or telemetry error report (even if masked).
3. **Webhook Verification Spikes:** Surge in invalid HMAC verification attempts on partner endpoints.
4. **Third-Party Report:** Notification from security researchers or automated secret scanning bots (e.g. GitHub Secret Scanning).

---

## 2. Immediate Containment

1. **Activate Emergency Containment:**
   ```ts
   import { EmergencyCircuitBreaker } from '@/services/key-rotation.service';
   const breaker = new EmergencyCircuitBreaker();
   breaker.triggerContainment(
     'Hot signer key exposed in public log',
     'operator_sec_1',
     ['hot_signer_account', 'relayer_service']
   );
   ```
2. **Pause or Suspend Affected Campaigns / Streams:**
   If the compromised key has distributor or stream permissions, invoke the suspension endpoint:
   ```bash
   curl -X POST https://app.fundable.org/api/campaigns/{id}/suspend \
     -H "Authorization: Bearer $SECURITY_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"reason": "Security hold pending key rotation"}'
   ```

---

## 3. Step-by-Step Rotation Procedures

### A. Stellar Multi-Sig Signer Demotion & Rotation
To revoke a compromised signer key, update the account signers on the Stellar network:
1. **Generate New Signer Keypair:**
   ```bash
   stellar keys generate new-hot-signer --network testnet
   ```
2. **Execute Signer Update Transaction:**
   Using the remaining healthy signers (meeting threshold quorum), submit a transaction that:
   - Sets the weight of `COMPROMISED_PUBLIC_KEY` to `0`.
   - Adds `NEW_PUBLIC_KEY` with weight `1`.
   ```typescript
   import { Account, Keypair, Operation, TransactionBuilder, Networks } from '@stellar/stellar-sdk';

   const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase })
     // Demote compromised key to weight 0 (removes signing capability)
     .addOperation(Operation.setOptions({
       signer: { ed25519PublicKey: COMPROMISED_PUBLIC_KEY, weight: 0 },
     }))
     // Add replacement signer
     .addOperation(Operation.setOptions({
       signer: { ed25519PublicKey: NEW_PUBLIC_KEY, weight: 1 },
     }))
     .setTimeout(30)
     .build();
   ```
3. **Verify On-Chain Signer State:**
   ```ts
   import { verifySignerRevocation } from '@/services/key-rotation.service';

   const account = await horizonServer.loadAccount(ACCOUNT_ID);
   const result = verifySignerRevocation(account.signers, COMPROMISED_PUBLIC_KEY, 1);
   if (!result.isRevoked || !result.thresholdMet) {
     throw new Error(`Signer revocation incomplete: ${result.details}`);
   }
   ```

### B. Smart Contract Admin Role Transfer
If a Soroban smart contract administrator key is compromised:
1. Invoke the contract's admin rotation method signed by current multi-sig admin threshold:
   ```bash
   soroban contract invoke \
     --id $PAYMENT_STREAM_CONTRACT_ID \
     --source $ADMIN_SIGNER \
     --network testnet \
     -- \
     set_admin --new_admin $NEW_ADMIN_ADDRESS
   ```
2. Query the contract storage to verify that `admin` equals `NEW_ADMIN_ADDRESS`.

### C. Webhook HMAC Secret Rotation (Zero-Downtime)
To rotate a compromised webhook secret without disrupting event delivery:
1. **Initialize Rotation with Grace Period (e.g., 24 hours):**
   ```ts
   import { DualSecretWebhookManager } from '@/services/key-rotation.service';

   const manager = new DualSecretWebhookManager(currentSecret);
   // Moves currentSecret to secondary (active for 24h) and sets new primary
   manager.rotateSecret(newSecret, 24 * 60 * 60 * 1000);
   ```
2. **Notify Subscriber:** Instruct partner to update their endpoint secret to the new primary within 24 hours.
3. **Automated Pruning:** After 24 hours, the expired secondary secret is automatically rejected and pruned.

---

## 4. Evidence Collection & Chain of Custody

Before restoring normal operations, assemble a cryptographic evidence bundle for post-incident review and potential legal audit:
1. **Collect Forensic Data:**
   - On-chain transaction hash of the unauthorized activity.
   - Stellar ledger sequence numbers.
   - Horizon transaction archive XDR.
   - Signer state before and after rotation.
2. **Generate Cryptographic Evidence Package:**
   ```ts
   import { generateEvidenceSnapshot } from '@/services/key-rotation.service';

   const evidence = generateEvidenceSnapshot('INC-2026-KEYCOMP', {
     incidentId: 'INC-2026-KEYCOMP',
     compromisedKey: COMPROMISED_PUBLIC_KEY,
     unauthorizedTxHash: 'abc...123',
     revocationTxHash: 'def...456',
     postRotationSigners: account.signers,
     operator: 'operator_sec_1',
   });

   console.log('Evidence snapshot generated with SHA-256:', evidence.dataHash);
   ```

---

## 5. Recovery Verification Checklist

- [ ] Compromised public key has weight `0` on Horizon.
- [ ] Active signers meet required threshold quorum.
- [ ] Contract admin address updated to verified cold/multisig key.
- [ ] Webhook HMAC secrets rotated with dual-secret grace period active.
- [ ] Smoke tests for stream creation, withdrawals, and deliveries succeed with new keys.
- [ ] Containment lifted via `EmergencyCircuitBreaker.liftContainment()`.
- [ ] Forensic evidence package archived with cryptographic SHA-256 manifest.
