import { createHmac, createHash } from 'crypto';

export interface AccountSigner {
  key: string;
  weight: number;
}

export interface SignerRevocationResult {
  isRevoked: boolean;
  totalActiveWeight: number;
  thresholdMet: boolean;
  compromisedKeyWeight: number;
  details: string;
}

export interface ContainmentRecord {
  containmentId: string;
  active: boolean;
  reason: string;
  operatorId: string;
  impactedEntities: string[];
  triggeredAt: number;
  liftedAt?: number;
  liftJustification?: string;
}

export interface EvidenceSnapshot {
  snapshotId: string;
  incidentId: string;
  timestamp: number;
  dataHash: string;
  payload: Record<string, unknown>;
}

/**
 * Validates that a compromised Stellar signer key has been properly revoked on-chain
 * (weight reduced to 0 or removed from signer list) while maintaining required quorum threshold.
 */
export function verifySignerRevocation(
  signers: AccountSigner[],
  compromisedKey: string,
  requiredThreshold: number = 1
): SignerRevocationResult {
  const compromised = signers.find((s) => s.key === compromisedKey);
  const compromisedKeyWeight = compromised ? compromised.weight : 0;
  const isRevoked = compromisedKeyWeight === 0;

  const totalActiveWeight = signers
    .filter((s) => s.key !== compromisedKey)
    .reduce((sum, s) => sum + s.weight, 0);

  const thresholdMet = totalActiveWeight >= requiredThreshold;

  let details = '';
  if (!isRevoked) {
    details = `Security violation: Compromised key ${compromisedKey} still holds signing weight ${compromisedKeyWeight}.`;
  } else if (!thresholdMet) {
    details = `Insufficient quorum: Remaining active signer weight (${totalActiveWeight}) is below required threshold (${requiredThreshold}).`;
  } else {
    details = `Signer successfully revoked. Active signing weight (${totalActiveWeight}) satisfies quorum threshold (${requiredThreshold}).`;
  }

  return {
    isRevoked,
    totalActiveWeight,
    thresholdMet,
    compromisedKeyWeight,
    details,
  };
}

/**
 * Manages zero-downtime webhook HMAC secret rotation with dual-secret grace periods.
 */
export class DualSecretWebhookManager {
  private primarySecret: string;
  private secondarySecret?: string;
  private secondaryExpiresAt?: number;

  constructor(initialSecret: string) {
    this.primarySecret = initialSecret;
  }

  getPrimarySecret(): string {
    return this.primarySecret;
  }

  getSecondarySecret(): string | undefined {
    return this.secondarySecret;
  }

  /**
   * Rotates to a new primary secret, retaining the current secret as secondary during a grace period.
   */
  rotateSecret(newSecret: string, gracePeriodMs: number, now: number = Date.now()): void {
    if (!newSecret || newSecret === this.primarySecret) {
      throw new Error('New secret must be distinct and non-empty');
    }
    this.secondarySecret = this.primarySecret;
    this.secondaryExpiresAt = now + gracePeriodMs;
    this.primarySecret = newSecret;
  }

  /**
   * Verifies an incoming webhook HMAC signature against active secrets.
   */
  verifySignature(
    payload: string,
    signature: string,
    timestamp: number | string,
    now: number = Date.now()
  ): { valid: boolean; usedSecondary: boolean; expiredSecondary: boolean } {
    const stringToSign = `${timestamp}.${payload}`;

    // 1. Verify against primary secret
    const expectedPrimary = createHmac('sha256', this.primarySecret)
      .update(stringToSign)
      .digest('hex');

    if (expectedPrimary === signature) {
      return { valid: true, usedSecondary: false, expiredSecondary: false };
    }

    // 2. Fallback to secondary secret if present
    if (this.secondarySecret && this.secondaryExpiresAt) {
      if (now > this.secondaryExpiresAt) {
        return { valid: false, usedSecondary: false, expiredSecondary: true };
      }

      const expectedSecondary = createHmac('sha256', this.secondarySecret)
        .update(stringToSign)
        .digest('hex');

      if (expectedSecondary === signature) {
        return { valid: true, usedSecondary: true, expiredSecondary: false };
      }
    }

    return { valid: false, usedSecondary: false, expiredSecondary: false };
  }

  /**
   * Prunes the secondary secret once its grace period has elapsed.
   */
  pruneExpiredSecondary(now: number = Date.now()): boolean {
    if (this.secondarySecret && this.secondaryExpiresAt && now > this.secondaryExpiresAt) {
      this.secondarySecret = undefined;
      this.secondaryExpiresAt = undefined;
      return true;
    }
    return false;
  }
}

/**
 * Emergency Circuit Breaker for containing active security incidents.
 */
export class EmergencyCircuitBreaker {
  private record?: ContainmentRecord;

  triggerContainment(
    reason: string,
    operatorId: string,
    impactedEntities: string[],
    now: number = Date.now()
  ): ContainmentRecord {
    this.record = {
      containmentId: `contain_${now}_${Math.random().toString(36).slice(2, 8)}`,
      active: true,
      reason,
      operatorId,
      impactedEntities,
      triggeredAt: now,
    };
    return { ...this.record };
  }

  isContained(): boolean {
    return Boolean(this.record?.active);
  }

  getRecord(): ContainmentRecord | undefined {
    return this.record ? { ...this.record } : undefined;
  }

  liftContainment(operatorId: string, justification: string, now: number = Date.now()): void {
    if (!this.record || !this.record.active) {
      throw new Error('No active containment to lift');
    }
    this.record.active = false;
    this.record.liftedAt = now;
    this.record.liftJustification = justification;
  }
}

/**
 * Generates an immutable, cryptographically verifiable evidence snapshot for forensics.
 */
export function generateEvidenceSnapshot(
  incidentId: string,
  payload: Record<string, unknown>,
  timestamp: number = Date.now()
): EvidenceSnapshot {
  const serialized = JSON.stringify(payload, Object.keys(payload).sort());
  const dataHash = createHash('sha256').update(serialized).digest('hex');

  return {
    snapshotId: `ev_${incidentId}_${dataHash.slice(0, 12)}`,
    incidentId,
    timestamp,
    dataHash,
    payload,
  };
}
