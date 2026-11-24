export const VERIFICATION_EVENT_TYPES = [
  "submitted_for_review",
  "verifier_comment",
  "photo_uploaded",
  "approved",
  "rejected",
] as const;

export type VerificationEventType = (typeof VERIFICATION_EVENT_TYPES)[number];

export const REVIEWER_COMMENT_RESOLUTION_STATUSES = [
  "open",
  "resolved",
  "dismissed",
] as const;

export type ResolutionStatus =
  (typeof REVIEWER_COMMENT_RESOLUTION_STATUSES)[number];

export type EvidenceLocationPrecision =
  | "redacted"
  | "region"
  | "district"
  | "exact";

export interface VerificationEvidence {
  id: string;
  campaignId: string;
  type: "photo" | "video";
  url: string;
  capturedAt: number;
  uploadedAt: number;
  latitude?: number;
  longitude?: number;
  /** Precision tier applied to stored coordinates for privacy minimization. */
  locationPrecision?: EvidenceLocationPrecision;
  /** Quarantine record ID verifying the upload passed security scanning. */
  quarantineId?: string;
  /** Published scan state for quarantined evidence. */
  scanStatus?: "clean" | "published";
  /** Published storage key promoted from quarantine after clean scan. */
  publishedKey?: string;
  verifierId?: string;
  caption?: string;
  contentHash?: string;
  underwriterId?: string;
  insurancePolicyId?: string;
  /**
   * Monotonic version of this evidence record. Comments are anchored to a
   * specific evidence version so discussions remain attributable even after
   * the evidence is re-uploaded or amended.
   */
  version?: number;
}

export interface ReviewerComment {
  id: string;
  campaignId: string;
  evidenceId: string;
  /** Evidence version this comment was made against. */
  evidenceVersion: number;
  authorId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  resolutionStatus: ResolutionStatus;
  resolvedAt?: number;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface CreateReviewerCommentInput {
  campaignId: string;
  evidenceId: string;
  /**
   * Evidence version the reviewer is commenting on. Defaults to the current
   * version.
   */
  evidenceVersion?: number;
  authorId: string;
  body: string;
  createdAt?: number;
}

export interface ResolveReviewerCommentInput {
  commentId: string;
  actorId: string;
  resolutionStatus: Exclude<ResolutionStatus, "open">;
  resolutionNote?: string;
  resolvedAt?: number;
}

export interface VerificationAuditEntry {
  id: string;
  campaignId: string;
  eventType: VerificationEventType;
  actorId: string;
  occurredAt: number;
  comment?: string;
  evidenceId?: string;
  evidenceUrl?: string;
  previousHash: string | null;
  entryHash: string;
  blockchainTxHash: string;
  ledgerSequence?: number;
}

export interface AppendVerificationEventInput {
  eventType: VerificationEventType;
  actorId: string;
  occurredAt?: number;
  comment?: string;
  evidenceId?: string;
  evidenceUrl?: string;
  blockchainTxHash?: string;
  ledgerSequence?: number;
}
