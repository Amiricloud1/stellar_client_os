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
