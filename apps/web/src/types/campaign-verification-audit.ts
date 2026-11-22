export type VerificationActivityType =
  | 'submitted_for_review'
  | 'verifier_comments'
  | 'photo_uploaded'
  | 'approved'
  | 'rejected';

export type VerificationStatus =
  | 'unsubmitted'
  | 'under_review'
  | 'approved'
  | 'rejected';

export interface VerificationAuditEntry {
  id: number;
  campaignId: string;
  activityType: VerificationActivityType;
  actor: string;
  details: string;
  timestamp: number; // Unix timestamp in seconds
  txHash?: string; // On-chain transaction hash if committed to blockchain
}

export interface VerificationAuditTrail {
  campaignId: string;
  status: VerificationStatus;
  totalActivities: number;
  activities: VerificationAuditEntry[];
  lastUpdated: string;
}

/**
 * A specific, immutable version of evidence attached to a campaign.
 * Reviewers comment against a particular evidence version so that
 * discussion remains anchored even as evidence is updated.
 */
export interface VerificationEvidence {
  id: string;
  campaignId: string;
  version: number; // Monotonically increasing per evidence id
  uri: string; // Location of the evidence artifact
  submittedBy: string;
  submittedAt: number; // Unix timestamp in seconds
  txHash?: string; // On-chain transaction hash if committed to blockchain
}

/**
 * Resolution lifecycle for a reviewer comment.
 * - `open`: newly created, awaiting action
 * - `acknowledged`: author/owner has seen it but not yet addressed
 * - `resolved`: addressed; `resolvedBy`/`resolvedAt` are set
 * - `dismissed`: intentionally closed without action; `resolvedBy`/`resolvedAt` are set
 */
export type ReviewerCommentResolutionStatus =
  | 'open'
  | 'acknowledged'
  | 'resolved'
  | 'dismissed';

/**
 * A reviewer comment discussing a specific evidence version.
 * Attribution (`author`), timestamps, and resolution status are preserved
 * so that discussion history is auditable.
 */
export interface ReviewerComment {
  id: string;
  campaignId: string;
  evidenceId: string;
  evidenceVersion: number;
  author: string;
  body: string;
  createdAt: number; // Unix timestamp in seconds
  updatedAt: number; // Unix timestamp in seconds
  resolutionStatus: ReviewerCommentResolutionStatus;
  resolvedBy?: string;
  resolvedAt?: number; // Unix timestamp in seconds
}

/**
 * Input for creating a reviewer comment against a specific evidence version.
 */
export interface CreateReviewerCommentInput {
  campaignId: string;
  evidenceId: string;
  evidenceVersion: number;
  author: string;
  body: string;
}

/**
 * Input for updating the body of an existing reviewer comment.
 */
export interface UpdateReviewerCommentInput {
  body: string;
}

/**
 * Input for changing the resolution status of a reviewer comment.
 * `resolvedBy` is required for terminal statuses (`resolved`, `dismissed`).
 */
export interface ResolveReviewerCommentInput {
  resolutionStatus: ReviewerCommentResolutionStatus;
  resolvedBy?: string;
}

/**
 * Evidence with its associated reviewer comments grouped by version.
 */
export interface VerificationEvidenceWithComments {
  evidence: VerificationEvidence;
  comments: ReviewerComment[];
}