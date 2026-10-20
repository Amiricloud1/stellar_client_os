import { describe, it, expect, beforeEach } from 'vitest';
import {
  verifySignerRevocation,
  DualSecretWebhookManager,
  EmergencyCircuitBreaker,
  generateEvidenceSnapshot,
  AccountSigner,
} from './key-rotation.service';
import { createHmac } from 'crypto';

describe('Incident Response & Key-Compromise Programmatic Service', () => {
  const compromisedKey = 'GBCOMPROMISED00000000000000000000000000000000000000000001';
  const healthySigner1 = 'GBHEALTHY000000000000000000000000000000000000000000000001';
  const healthySigner2 = 'GBHEALTHY000000000000000000000000000000000000000000000002';
  const newSignerKey   = 'GBNEWKEY00000000000000000000000000000000000000000000000001';

  describe('Signer Revocation & Quorum Verification', () => {
    it('verifies successful revocation when compromised key weight is 0 and threshold is met', () => {
      const signers: AccountSigner[] = [
        { key: compromisedKey, weight: 0 },
        { key: healthySigner1, weight: 1 },
        { key: newSignerKey, weight: 1 },
      ];

      const result = verifySignerRevocation(signers, compromisedKey, 2);

      expect(result.isRevoked).toBe(true);
      expect(result.totalActiveWeight).toBe(2);
      expect(result.thresholdMet).toBe(true);
      expect(result.compromisedKeyWeight).toBe(0);
      expect(result.details).toContain('Signer successfully revoked');
    });

    it('rejects verification if the compromised key still possesses non-zero weight', () => {
      const signers: AccountSigner[] = [
        { key: compromisedKey, weight: 1 },
        { key: healthySigner1, weight: 1 },
      ];

      const result = verifySignerRevocation(signers, compromisedKey, 1);

      expect(result.isRevoked).toBe(false);
      expect(result.compromisedKeyWeight).toBe(1);
      expect(result.details).toContain('Security violation');
    });

    it('flags insufficient quorum if remaining signers fail to meet threshold', () => {
      const signers: AccountSigner[] = [
        { key: compromisedKey, weight: 0 },
        { key: healthySigner1, weight: 1 },
      ];

      // Requires 2 signers, but only 1 remains active
      const result = verifySignerRevocation(signers, compromisedKey, 2);

      expect(result.isRevoked).toBe(true);
      expect(result.thresholdMet).toBe(false);
      expect(result.details).toContain('Insufficient quorum');
    });
  });

  describe('Dual-Secret Webhook HMAC Rotation (Zero-Downtime)', () => {
    const initialSecret = 'initial_whsec_secret_12345';
    const newSecret = 'rotated_whsec_secret_67890';
    const payload = JSON.stringify({ event: 'stream.created', id: 'str_1' });
    const timestamp = 1770000000000;

    let manager: DualSecretWebhookManager;

    beforeEach(() => {
      manager = new DualSecretWebhookManager(initialSecret);
    });

    it('validates signatures using primary secret prior to rotation', () => {
      const sig = createHmac('sha256', initialSecret).update(`${timestamp}.${payload}`).digest('hex');
      const res = manager.verifySignature(payload, sig, timestamp, timestamp);

      expect(res.valid).toBe(true);
      expect(res.usedSecondary).toBe(false);
    });

    it('supports seamless migration during grace period for both old and new secrets', () => {
      const gracePeriodMs = 3600000; // 1 hour
      manager.rotateSecret(newSecret, gracePeriodMs, timestamp);

      // Verify old secret still works during grace period
      const oldSig = createHmac('sha256', initialSecret).update(`${timestamp}.${payload}`).digest('hex');
      const oldRes = manager.verifySignature(payload, oldSig, timestamp, timestamp + 1800000); // 30 mins in

      expect(oldRes.valid).toBe(true);
      expect(oldRes.usedSecondary).toBe(true);

      // Verify new secret works immediately
      const newSig = createHmac('sha256', newSecret).update(`${timestamp}.${payload}`).digest('hex');
      const newRes = manager.verifySignature(payload, newSig, timestamp, timestamp + 1800000);

      expect(newRes.valid).toBe(true);
      expect(newRes.usedSecondary).toBe(false);
    });

    it('rejects retired secret after grace period has expired and prunes it', () => {
      const gracePeriodMs = 3600000; // 1 hour
      manager.rotateSecret(newSecret, gracePeriodMs, timestamp);

      const afterExpiry = timestamp + 3600001; // 1ms after grace period
      const oldSig = createHmac('sha256', initialSecret).update(`${timestamp}.${payload}`).digest('hex');
      const res = manager.verifySignature(payload, oldSig, timestamp, afterExpiry);

      expect(res.valid).toBe(false);
      expect(res.expiredSecondary).toBe(true);

      const pruned = manager.pruneExpiredSecondary(afterExpiry);
      expect(pruned).toBe(true);
      expect(manager.getSecondarySecret()).toBeUndefined();
    });

    it('throws error when rotating to an empty or identical secret', () => {
      expect(() => manager.rotateSecret('', 3600)).toThrow();
      expect(() => manager.rotateSecret(initialSecret, 3600)).toThrow();
    });
  });

  describe('Emergency Containment Circuit Breaker', () => {
    it('activates and lifts containment with audit metadata', () => {
      const breaker = new EmergencyCircuitBreaker();
      expect(breaker.isContained()).toBe(false);

      const record = breaker.triggerContainment(
        'Suspected signer compromise detected on horizon node',
        'op_sec_42',
        ['campaign_pool_1', 'distributor_contract']
      );

      expect(breaker.isContained()).toBe(true);
      expect(record.operatorId).toBe('op_sec_42');
      expect(record.impactedEntities).toContain('distributor_contract');

      breaker.liftContainment('op_sec_42', 'Key rotation confirmed on-chain');
      expect(breaker.isContained()).toBe(false);
    });

    it('throws when attempting to lift containment without an active record', () => {
      const breaker = new EmergencyCircuitBreaker();
      expect(() => breaker.liftContainment('op_1', 'unjustified')).toThrow();
    });
  });

  describe('Forensic Evidence Snapshot Generation', () => {
    it('creates deterministic SHA-256 evidence package', () => {
      const details = {
        compromisedKey,
        detectedLedger: 5432100,
        anomalousTx: 'c1f9342790abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      };

      const snap1 = generateEvidenceSnapshot('INC-2026-001', details, 1770000000000);
      const snap2 = generateEvidenceSnapshot('INC-2026-001', details, 1770000000000);

      expect(snap1.dataHash).toBe(snap2.dataHash);
      expect(snap1.snapshotId).toContain('ev_INC-2026-001');
    });
  });

  describe('Tabletop Exercise (TTX-2026-01) Simulation', () => {
    it('executes full incident response & key compromise drill sequentially', () => {
      // Step 1: Anomaly detected on key
      const breaker = new EmergencyCircuitBreaker();
      const webhookManager = new DualSecretWebhookManager('old_webhook_secret_123');

      // Step 2: Containment triggered
      breaker.triggerContainment('TTX Scenario: Key leak detected on public forum', 'ttx_facilitator', [
        'distributor_wallet',
      ]);
      expect(breaker.isContained()).toBe(true);

      // Step 3: Evidence captured
      const evidence = generateEvidenceSnapshot('TTX-DRILL-01', {
        step: 'containment_active',
        compromisedKey,
      });
      expect(evidence.dataHash).toHaveLength(64);

      // Step 4: Signer rotation execution (demote compromised to 0, promote new key to 1)
      const postRotationSigners: AccountSigner[] = [
        { key: compromisedKey, weight: 0 },
        { key: newSignerKey, weight: 1 },
      ];
      const rotationResult = verifySignerRevocation(postRotationSigners, compromisedKey, 1);
      expect(rotationResult.isRevoked).toBe(true);
      expect(rotationResult.thresholdMet).toBe(true);

      // Step 5: Webhook secret rotation with grace period
      webhookManager.rotateSecret('new_secure_whsec_456', 3600000);
      expect(webhookManager.getPrimarySecret()).toBe('new_secure_whsec_456');

      // Step 6: Recovery verification and containment lift
      breaker.liftContainment('ttx_facilitator', 'All keys rotated and verified');
      expect(breaker.isContained()).toBe(false);
    });
  });
});
