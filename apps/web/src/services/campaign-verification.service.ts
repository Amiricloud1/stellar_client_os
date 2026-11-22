import { createHash } from "node:crypto";
import {
  VERIFICATION_EVENT_TYPES,
  type AppendVerificationEventInput,
  type VerificationAuditEntry,
  type VerificationEventType,
} from "@/types/campaign-verification";
import type { CampaignEvidenceVersion } from "@/types/campaign";
import {
  getCampaign,
  getCampaignDataSource,
  type CampaignDataSource,
} from "./campaign.service";

export { VERIFICATION_EVENT_TYPES };

/**
 * Coarse verification states surfaced to the UI and E2E specs. They are derived
 * from the audit trail so the same derivation is used in production and in
 * deterministic fixtures (no live chain or funds required).
 */
export const VERIFICATION_STATES = [
  "unverified",
  "pending",
  "verified",
  "rejected",
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

const STATE_BY_EVENT_TYPE: Record<VerificationEventType, VerificationState> = {
  "verification.requested": "pending",
  "verification.approved": "verified",
  "verification.rejected": "rejected",
  "verification.revoked": "unverified",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateInput(input: AppendVerificationEventInput): void {
  if (!VERIFICATION_EVENT_TYPES.includes(input.eventType)) {
    throw new Error(`Unsupported verification event type: ${input.eventType}`);
  }
  if (!input.actorId?.trim()) throw new Error("actorId is required");
  if (input.comment && input.comment.length > 2_000) throw new Error("comment is too long");
}

/**
 * A reviewer comment attached to a specific evidence version. Comments are
 * stored as audit-trail entries so attribution, timestamps, and resolution
 * status are preserved and tamper-evident via the hash chain.
 */
export interface ReviewerComment {
  /** Audit entry id of the comment event. */
  id: string;
  campaignId: string;
  evidenceId: string;
  evidenceVersion: number;
  /** Reviewer identity (actorId of the comment event). */
  reviewerId: string;
  body: string;
  createdAt: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;
  entryHash: string;
}

export interface AppendReviewerCommentInput {
  evidenceId: string;
  /** Evidence version the comment refers to; must exist on the campaign. */
  evidenceVersion: number;
  reviewerId: string;
  body: string;
  occurredAt?: number;
  blockchainTxHash?: string;
  ledgerSequence?: number;
}

export interface ResolveReviewerCommentInput {
  commentId: string;
  resolverId: string;
  occurredAt?: number;
  blockchainTxHash?: string;
  ledgerSequence?: number;
}

const COMMENT_EVENT_TYPE = "verification.comment" as const;
const COMMENT_RESOLVED_EVENT_TYPE = "verification.comment.resolved" as const;

function findEvidenceVersion(
  campaign: { evidence?: readonly CampaignEvidenceVersion[] },
  evidenceId: string,
  evidenceVersion: number,
): CampaignEvidenceVersion | undefined {
  return (campaign.evidence ?? []).find(
    (version) => version.evidenceId === evidenceId && version.version === evidenceVersion,
  );
}

function parseCommentEntry(entry: VerificationAuditEntry): ReviewerComment | null {
  if (entry.eventType !== COMMENT_EVENT_TYPE) return null;
  if (!entry.evidenceId || entry.evidenceVersion === undefined) return null;
  return {
    id: entry.id,
    campaignId: entry.campaignId,
    evidenceId: entry.evidenceId,
    evidenceVersion: entry.evidenceVersion,
    reviewerId: entry.actorId,
    body: entry.comment ?? "",
    createdAt: entry.occurredAt,
    resolved: false,
    entryHash: entry.entryHash,
  };
}

/**
 * Lists reviewer comments for a campaign, optionally filtered to a single
 * evidence version. Resolution status is derived from subsequent
 * `verification.comment.resolved` events that reference the comment id.
 */
export async function listReviewerComments(
  campaignId: string,
  filter: { evidenceId?: string; evidenceVersion?: number } = {},
  dataSource: CampaignDataSource = getCampaignDataSource(),
): Promise<ReviewerComment[] | null> {
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) return null;
  const trail = campaign.verificationAuditTrail ?? [];
  const resolutions = new Map<string, { resolvedBy: string; resolvedAt: number }>();
  for (const entry of trail) {
    if (entry.eventType === COMMENT_RESOLVED_EVENT_TYPE && entry.commentId) {
      resolutions.set(entry.commentId, {
        resolvedBy: entry.actorId,
        resolvedAt: entry.occurredAt,
      });
    }
  }
  const comments: ReviewerComment[] = [];
  for (const entry of trail) {
    const comment = parseCommentEntry(entry);
    if (!comment) continue;
    if (filter.evidenceId && comment.evidenceId !== filter.evidenceId) continue;
    if (filter.evidenceVersion !== undefined && comment.evidenceVersion !== filter.evidenceVersion) {
      continue;
    }
    const resolution = resolutions.get(comment.id);
    comments.push(
      resolution
        ? {
            ...comment,
            resolved: true,
            resolvedBy: resolution.resolvedBy,
            resolvedAt: resolution.resolvedAt,
          }
        : comment,
    );
  }
  return comments;
}

/**
 * Appends a reviewer comment to a specific evidence version. The evidence
 * version must already exist on the campaign; stale or unknown versions are
 * rejected so comments cannot drift from the evidence they discuss.
 */
export async function appendReviewerComment(
  campaignId: string,
  input: AppendReviewerCommentInput,
  dataSource: CampaignDataSource = getCampaignDataSource(),
): Promise<ReviewerComment> {
  if (!input.evidenceId?.trim()) throw new Error("evidenceId is required");
  if (!Number.isInteger(input.evidenceVersion) || input.evidenceVersion < 1) {
    throw new Error("evidenceVersion must be a positive integer");
  }
  if (!input.reviewerId?.trim()) throw new Error("reviewerId is required");
  if (!input.body?.trim()) throw new Error("body is required");
  if (input.body.length > 2_000) throw new Error("body is too long");
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) throw new Error("Campaign not found");
  if (!findEvidenceVersion(campaign, input.evidenceId, input.evidenceVersion)) {
    throw new Error(
      `Evidence version ${input.evidenceId}@${input.evidenceVersion} not found; comment rejected as stale`,
    );
  }
  const entry = await appendVerificationEvent(
    campaignId,
    {
      eventType: COMMENT_EVENT_TYPE,
      actorId: input.reviewerId,
      comment: input.body,
      evidenceId: input.evidenceId,
      evidenceVersion: input.evidenceVersion,
      occurredAt: input.occurredAt,
      blockchainTxHash: input.blockchainTxHash,
      ledgerSequence: input.ledgerSequence,
    },
    dataSource,
  );
  return {
    id: entry.id,
    campaignId: entry.campaignId,
    evidenceId: input.evidenceId,
    evidenceVersion: input.evidenceVersion,
    reviewerId: entry.actorId,
    body: entry.comment ?? input.body.trim(),
    createdAt: entry.occurredAt,
    resolved: false,
    entryHash: entry.entryHash,
  };
}

/**
 * Marks a reviewer comment as resolved. Only the comment's original reviewer
 * or an explicit resolver may resolve it; the resolution is itself an audit
 * event so attribution and timestamps are preserved.
 */
export async function resolveReviewerComment(
  campaignId: string,
  input: ResolveReviewerCommentInput,
  dataSource: CampaignDataSource = getCampaignDataSource(),
): Promise<ReviewerComment> {
  if (!input.commentId?.trim()) throw new Error("commentId is required");
  if (!input.resolverId?.trim()) throw new Error("resolverId is required");
  const comments = await listReviewerComments(campaignId, {}, dataSource);
  if (!comments) throw new Error("Campaign not found");
  const target = comments.find((comment) => comment.id === input.commentId);
  if (!target) throw new Error("Comment not found");
  if (target.resolved) throw new Error("Comment already resolved");
  await appendVerificationEvent(
    campaignId,
    {
      eventType: COMMENT_RESOLVED_EVENT_TYPE,
      actorId: input.resolverId,
      commentId: input.commentId,
      occurredAt: input.occurredAt,
      blockchainTxHash: input.blockchainTxHash,
      ledgerSequence: input.ledgerSequence,
    },
    dataSource,
  );
  const refreshed = await listReviewerComments(campaignId, {}, dataSource);
  const resolved = refreshed?.find((comment) => comment.id === input.commentId);
  if (!resolved) throw new Error("Comment not found after resolution");
  return resolved;
}

/**
 * Appends a verification event. Existing entries are copied and never edited;
 * each new entry commits to the previous hash so consumers can verify the
 * complete audit trail independently. blockchainTxHash is the Soroban/Horizon
 * anchor supplied by the indexer; the local fallback is explicitly marked as
 * pending for development environments without a chain writer.
 */
export async function appendVerificationEvent(
  campaignId: string,
  input: AppendVerificationEventInput,
  dataSource: CampaignDataSource = getCampaignDataSource(),
): Promise<VerificationAuditEntry> {
  validateInput(input);
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) throw new Error("Campaign not found");
  const auditTrail = campaign.verificationAuditTrail ?? [];
  const previousHash = auditTrail.at(-1)?.entryHash ?? null;
  const occurredAt = input.occurredAt ?? Date.now();
  const id = `${campaignId}:verification:${occurredAt}:${auditTrail.length}`;
  const canonical = JSON.stringify({
    id,
    campaignId,
    eventType: input.eventType,
    actorId: input.actorId.trim(),
    occurredAt,
    comment: input.comment?.trim() || undefined,
    evidenceId: input.evidenceId,
    evidenceUrl: input.evidenceUrl,
    evidenceVersion: input.evidenceVersion,
    commentId: input.commentId,
    previousHash,
  });
  const entryHash = sha256(canonical);
  const entry: VerificationAuditEntry = {
    id,
    campaignId,
    eventType: input.eventType,
    actorId: input.actorId.trim(),
    occurredAt,
    ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
    ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    ...(input.evidenceUrl ? { evidenceUrl: input.evidenceUrl } : {}),
    ...(input.evidenceVersion !== undefined ? { evidenceVersion: input.evidenceVersion } : {}),
    ...(input.commentId ? { commentId: input.commentId } : {}),
    previousHash,
    entryHash,
    blockchainTxHash: input.blockchainTxHash ?? `pending:${entryHash}`,
    ...(input.ledgerSequence !== undefined ? { ledgerSequence: input.ledgerSequence } : {}),
  };
  await dataSource.saveCampaign({
    ...campaign,
    verificationAuditTrail: [...auditTrail, entry],
    updatedAt: occurredAt,
  });
  return entry;
}

export async function getVerificationAuditTrail(
  campaignId: string,
  dataSource: CampaignDataSource = getCampaignDataSource(),
): Promise<VerificationAuditEntry[] | null> {
  const campaign = await getCampaign(campaignId, dataSource);
  return campaign ? (campaign.verificationAuditTrail ?? []).map((entry) => ({ ...entry })) : null;
}

export function verifyVerificationAuditTrail(entries: readonly VerificationAuditEntry[]): boolean {
  let previousHash: string | null = null;
  for (const entry of entries) {
    const canonical = JSON.stringify({
      id: entry.id,
      campaignId: entry.campaignId,
      eventType: entry.eventType,
      actorId: entry.actorId,
      occurredAt: entry.occurredAt,
      comment: entry.comment,
      evidenceId: entry.evidenceId,
      evidenceUrl: entry.evidenceUrl,
      evidenceVersion: entry.evidenceVersion,
      commentId: entry.commentId,
      previousHash,
    });
    if (entry.previousHash !== previousHash || sha256(canonical) !== entry.entryHash) return false;
    previousHash = entry.entryHash;
  }
  return true;
}

export function isVerificationEventType(value: unknown): value is VerificationEventType {
  return typeof value === "string" && (VERIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

export function isVerificationState(value: unknown): value is VerificationState {
  return typeof value === "string" && (VERIFICATION_STATES as readonly string[]).includes(value);
}

/**
 * Derives the current verification state from an audit trail. The latest
 * recognized event wins; an empty or unrecognized trail is "unverified".
 */
export function deriveVerificationState(
  entries: readonly VerificationAuditEntry[] | null | undefined,
): VerificationState {
  if (!entries || entries.length === 0) return "unverified";
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const eventType = entries[index]?.eventType;
    if (eventType && isVerificationEventType(eventType)) {
      return STATE_BY_EVENT_TYPE[eventType];
    }
  }
  return "unverified";
}

/**
 * Resolves the verification state for a campaign. Returns null when the
 * campaign does not exist so callers can distinguish "missing" from
 * "unverified".
 */
export async function getCampaignVerificationState(
  campaignId: string,
  dataSource: CampaignDataSource = getCampaignDataSource(),
): Promise<VerificationState | null> {
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) return null;
  return deriveVerificationState(campaign.verificationAuditTrail);
}
