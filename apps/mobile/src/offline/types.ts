/**
 * Campaign shapes used by the offline cache. They are intentionally
 * structural: the mobile screens can extend them, and the cache stays generic
 * over the exact detail payload returned by the API.
 */

export interface Sponsor {
  id: string;
  address: string;
  amount: string;
  token: string;
  sponsoredAt: number;
}

/** Lightweight campaign row shown in offline browse lists. */
export interface CampaignSummary {
  id: string;
  name: string;
  description?: string;
  status: string;
  goalAmount: string;
  raisedAmount: string;
  treeCount: number;
  sponsorCount: number;
  location?: string;
}

/** Full campaign payload cached for offline detail browsing. */
export interface CampaignDetail extends CampaignSummary {
  sponsors: Sponsor[];
  verificationProgress?: number;
  treeSpeciesDiversity?: number;
  regionClimateImpact?: number;
  soilHealthImprovement?: number;
  biodiversityPotential?: number;
}

/** A persisted value together with the timestamp it was written. */
export interface CachedValue<T> {
  data: T;
  cachedAt: number;
}

/**
 * Outcome of a privacy export or deletion request. Mirrors the authoritative
 * API response so the offline cache can surface explicit failure and recovery
 * states instead of silently dropping records.
 */
export type PrivacyRequestStatus =
  | 'completed'
  | 'partial'
  | 'retained'
  | 'failed';

/** A record excluded from an export or deletion because of a legal hold. */
export interface PrivacyRetentionException {
  /** Stable identifier of the retained record. */
  recordId: string;
  /** Record category, e.g. `donation`, `consent`, `audit_log`. */
  recordType: string;
  /** Human-readable reason the record is retained. */
  reason: string;
  /** ISO timestamp until which the record must be retained, if bounded. */
  retainUntil?: string;
}

/** A linked record that was cascaded or blocked by linked-data rules. */
export interface PrivacyLinkedRecord {
  recordId: string;
  recordType: string;
  /** `deleted` when cascaded, `blocked` when a linked-data rule prevented it. */
  outcome: 'deleted' | 'blocked';
  reason?: string;
}

/** Verified result of a privacy export or deletion request. */
export interface PrivacyRequestResult {
  requestId: string;
  status: PrivacyRequestStatus;
  /** ISO timestamp when the request was processed. */
  processedAt: string;
  /** Records successfully exported or erased. */
  affectedRecordIds: string[];
  /** Records kept under explicit legal-retention exceptions. */
  retentionExceptions: PrivacyRetentionException[];
  /** Linked records cascaded or blocked by linked-data rules. */
  linkedRecords: PrivacyLinkedRecord[];
  /** Operator-facing message describing a failure or recovery step. */
  message?: string;
  /** Whether the request can be safely retried. */
  retryable: boolean;
}

/**
 * Content digest recorded for an uploaded evidence file. The digest is a
 * tamper-evidence signal only: it lets operators detect that stored bytes no
 * longer match what was uploaded. It does NOT prove the evidence is truthful
 * or authentic, and must never be presented as such.
 */
export interface EvidenceDigest {
  /** Digest algorithm, e.g. `sha256`. */
  algorithm: string;
  /** Lowercase hex-encoded content digest of the uploaded bytes. */
  value: string;
  /** Size in bytes of the digested content. */
  byteLength: number;
  /** ISO timestamp when the digest was recorded at the upload boundary. */
  recordedAt: string;
}

/**
 * One entry in an evidence file's replacement history. Every re-upload or
 * replacement appends an entry so the prior content digest is never lost.
 */
export interface EvidenceReplacement {
  /** Monotonic revision number, starting at 1 for the original upload. */
  revision: number;
  /** Digest of the content at this revision. */
  digest: EvidenceDigest;
  /** ISO timestamp when this revision replaced the previous content. */
  replacedAt: string;
  /** Actor (user or service id) that performed the replacement. */
  replacedBy: string;
  /** Optional operator-facing reason for the replacement. */
  reason?: string;
}

/**
 * Integrity state of an uploaded evidence file as reported by the
 * authoritative upload/persistence boundary.
 *
 * - `verified`: stored bytes match the recorded digest.
 * - `mismatch`: stored bytes no longer match the recorded digest (tampering or
 *   corruption detected); operators must review before relying on the file.
 * - `unverified`: no digest has been recorded yet (e.g. legacy uploads); the
 *   file can be re-verified by re-uploading or running a backfill.
 */
export type EvidenceIntegrityStatus = 'verified' | 'mismatch' | 'unverified';

/**
 * Integrity record for an uploaded evidence file. Mirrors the authoritative
 * API response so the offline cache can surface explicit failure and recovery
 * states instead of silently trusting cached bytes.
 */
export interface EvidenceIntegrity {
  /** Stable identifier of the evidence file. */
  evidenceId: string;
  status: EvidenceIntegrityStatus;
  /** Digest of the current content, absent for `unverified` legacy uploads. */
  currentDigest?: EvidenceDigest;
  /** Full replacement history, oldest first. */
  replacements: EvidenceReplacement[];
  /** ISO timestamp of the most recent integrity verification. */
  verifiedAt?: string;
  /** Operator-facing message describing a failure or recovery step. */
  message?: string;
  /** Whether the integrity check can be safely retried. */
  retryable: boolean;
}

/**
 * Independent donor consent purposes. Recognition (public acknowledgement),
 * receipt (transactional donation receipts) and communications (marketing and
 * updates) are granted and revoked separately so a donor can opt into one
 * without the others.
 */
export type ConsentPurpose = 'recognition' | 'receipt' | 'communications';

/**
 * State of a single consent purpose. `revoked` is terminal for the current
 * version: a new grant must be recorded as a new version so downstream
 * consumers can detect the change.
 */
export type ConsentPurposeState = 'granted' | 'revoked';

/**
 * A versioned consent decision for one purpose. Every grant or revocation
 * appends a new record with a monotonically increasing `version`, so the
 * history is auditable and downstream consumers can detect stale consent by
 * comparing the version they last observed.
 */
export interface ConsentRecord {
  /** Stable identifier of the donor the consent belongs to. */
  donorId: string;
  purpose: ConsentPurpose;
  state: ConsentPurposeState;
  /** Monotonic version, starting at 1 for the first decision per purpose. */
  version: number;
  /** ISO timestamp when this version was recorded at the authoritative boundary. */
  recordedAt: string;
  /** Actor (user or service id) that recorded this version. */
  recordedBy: string;
  /** Optional operator/donor-facing reason for the change. */
  reason?: string;
}

/**
 * Authoritative consent snapshot for a donor, keyed by purpose. Mirrors the
 * API response so the offline cache can enforce consent at the boundary and
 * surface explicit revocation state instead of trusting stale UI state.
 */
export interface DonorConsent {
  donorId: string;
  /** Latest version per purpose; a missing purpose means no decision yet. */
  purposes: Partial<Record<ConsentPurpose, ConsentRecord>>;
  /** ISO timestamp of the most recent consent change. */
  updatedAt: string;
}
