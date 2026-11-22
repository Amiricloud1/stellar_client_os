import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  VerificationActivityType,
  VerificationAuditEntry,
  VerificationAuditTrail,
} from '../types/campaign-verification-audit';
import { CampaignPushNotificationService } from './campaign-push-notification.service';

export interface VerificationAuditServiceOptions {
  dataDir?: string;
  pushService?: CampaignPushNotificationService;
}

export type ReviewerCommentResolutionStatus = 'open' | 'resolved';

export interface ReviewerComment {
  id: string;
  campaignId: string;
  evidenceId: string;
  /** Immutable snapshot of the evidence version the comment was written against. */
  evidenceVersion: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolutionStatus: ReviewerCommentResolutionStatus;
  resolvedBy?: string;
  resolvedAt?: string;
  resolutionNote?: string;
  /** Client-supplied idempotency key, unique per campaign. */
  idempotencyKey?: string;
}

export interface ReviewerCommentActor {
  id: string;
  role: 'reviewer' | 'admin' | 'submitter' | 'viewer';
}

export interface EvidenceVersionSnapshot {
  evidenceId: string;
  campaignId: string;
  version: number;
  /** Reviewers explicitly assigned to this evidence version. */
  assignedReviewerIds: string[];
}

export interface CreateReviewerCommentInput {
  campaignId: string;
  evidenceId: string;
  /** Version the reviewer observed; must match the current evidence version. */
  evidenceVersion: number;
  body: string;
  actor: ReviewerCommentActor;
  idempotencyKey?: string;
}

export interface ResolveReviewerCommentInput {
  campaignId: string;
  commentId: string;
  actor: ReviewerCommentActor;
  resolutionNote?: string;
  idempotencyKey?: string;
}

export class ReviewerCommentAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerCommentAuthorizationError';
  }
}

export class ReviewerCommentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerCommentConflictError';
  }
}

export class ReviewerCommentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerCommentValidationError';
  }
}

export class ReviewerCommentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerCommentNotFoundError';
  }
}

export interface ReviewerCommentServiceOptions extends VerificationAuditServiceOptions {
  /**
   * Resolves the current evidence version snapshot. In production this is
   * backed by the evidence store; tests can inject a deterministic resolver.
   */
  resolveEvidence?: (
    campaignId: string,
    evidenceId: string
  ) => Promise<EvidenceVersionSnapshot | null>;
}

export class CampaignVerificationAuditService {
  private readonly auditPath: string;
  private readonly commentsPath: string;
  private readonly pushService?: CampaignPushNotificationService;
  private readonly resolveEvidence?: ReviewerCommentServiceOptions['resolveEvidence'];

  constructor(options: ReviewerCommentServiceOptions = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
    this.auditPath = path.join(dataDir, 'campaign_verification_audit.json');
    this.commentsPath = path.join(dataDir, 'campaign_reviewer_comments.json');
    this.pushService = options.pushService;
    this.resolveEvidence = options.resolveEvidence;
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }
  }

  async getAllAuditTrails(): Promise<Record<string, VerificationAuditTrail>> {
    try {
      const data = await fs.readFile(this.auditPath, 'utf-8');
      return JSON.parse(data) as Record<string, VerificationAuditTrail>;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return {};
      throw err;
    }
  }

  async getAuditTrail(campaignId: string): Promise<VerificationAuditTrail> {
    const trails = await this.getAllAuditTrails();
    return (
      trails[campaignId] ?? {
        campaignId,
        status: 'unsubmitted',
        totalActivities: 0,
        activities: [],
        lastUpdated: new Date().toISOString(),
      }
    );
  }

  async logActivity(input: {
    campaignId: string;
    activityType: VerificationActivityType;
    actor: string;
    details: string;
    txHash?: string;
    campaignTitle?: string;
  }): Promise<VerificationAuditEntry> {
    const { campaignId, activityType, actor, details, txHash, campaignTitle } = input;
    if (!campaignId || !activityType || !actor) {
      throw new Error('campaignId, activityType, and actor are required');
    }

    const trails = await this.getAllAuditTrails();
    const trail = trails[campaignId] ?? {
      campaignId,
      status: 'unsubmitted',
      totalActivities: 0,
      activities: [],
      lastUpdated: new Date().toISOString(),
    };

    const nextId = trail.totalActivities + 1;
    const timestamp = Math.floor(Date.now() / 1000);

    const newEntry: VerificationAuditEntry = {
      id: nextId,
      campaignId,
      activityType,
      actor,
      details,
      timestamp,
      txHash: txHash ?? `0x${randomUUID().replace(/-/g, '')}`,
    };

    // Update status based on activity
    if (activityType === 'submitted_for_review') {
      trail.status = 'under_review';
    } else if (activityType === 'approved') {
      trail.status = 'approved';
    } else if (activityType === 'rejected') {
      trail.status = 'rejected';
    }

    // Append to immutable log
    trail.activities.push(newEntry);
    trail.totalActivities = nextId;
    trail.lastUpdated = new Date().toISOString();

    trails[campaignId] = trail;
    await this.writeJsonAtomic(this.auditPath, trails);

    // If verification was approved, dispatch milestone push notification
    if (activityType === 'approved' && this.pushService) {
      await this.pushService.sendMilestonePushNotification({
        campaignId,
        campaignTitle: campaignTitle || `Campaign #${campaignId}`,
        milestone: 'verification_complete',
        details: {
          verifierAddress: actor,
          completionTimestamp: timestamp,
          approvalNotes: details,
        },
      });
    }

    return newEntry;
  }

  async logSubmittedForReview(
    campaignId: string,
    submitter: string,
    notes: string,
    txHash?: string
  ): Promise<VerificationAuditEntry> {
    return this.logActivity({
      campaignId,
      activityType: 'submitted_for_review',
      actor: submitter,
      details: notes,
      txHash,
    });
  }

  async logVerifierComments(
    campaignId: string,
    verifier: string,
    comments: string,
    txHash?: string
  ): Promise<VerificationAuditEntry> {
    return this.logActivity({
      campaignId,
      activityType: 'verifier_comments',
      actor: verifier,
      details: comments,
      txHash,
    });
  }

  async logPhotoUploaded(
    campaignId: string,
    uploader: string,
    photoHash: string,
    txHash?: string
  ): Promise<VerificationAuditEntry> {
    return this.logActivity({
      campaignId,
      activityType: 'photo_uploaded',
      actor: uploader,
      details: photoHash,
      txHash,
    });
  }

  async logApproved(
    campaignId: string,
    verifier: string,
    comments: string,
    campaignTitle?: string,
    txHash?: string
  ): Promise<VerificationAuditEntry> {
    return this.logActivity({
      campaignId,
      activityType: 'approved',
      actor: verifier,
      details: comments,
      campaignTitle,
      txHash,
    });
  }

  async logRejected(
    campaignId: string,
    verifier: string,
    reason: string,
    txHash?: string
  ): Promise<VerificationAuditEntry> {
    return this.logActivity({
      campaignId,
      activityType: 'rejected',
      actor: verifier,
      details: reason,
      txHash,
    });
  }

  private async getAllReviewerComments(): Promise<Record<string, ReviewerComment[]>> {
    try {
      const data = await fs.readFile(this.commentsPath, 'utf-8');
      return JSON.parse(data) as Record<string, ReviewerComment[]>;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return {};
      throw err;
    }
  }

  private async loadEvidenceSnapshot(
    campaignId: string,
    evidenceId: string
  ): Promise<EvidenceVersionSnapshot | null> {
    if (!this.resolveEvidence) {
      throw new ReviewerCommentValidationError(
        'Evidence resolver is not configured; cannot validate evidence version'
      );
    }
    return this.resolveEvidence(campaignId, evidenceId);
  }

  private assertCanComment(
    snapshot: EvidenceVersionSnapshot,
    actor: ReviewerCommentActor
  ): void {
    if (actor.role === 'admin') return;
    if (actor.role !== 'reviewer') {
      throw new ReviewerCommentAuthorizationError(
        'Only assigned reviewers or admins may comment on evidence'
      );
    }
    if (!snapshot.assignedReviewerIds.includes(actor.id)) {
      throw new ReviewerCommentAuthorizationError(
        'Reviewer is not assigned to this evidence version'
      );
    }
  }

  async listReviewerComments(
    campaignId: string,
    evidenceId?: string
  ): Promise<ReviewerComment[]> {
    const all = await this.getAllReviewerComments();
    const comments = all[campaignId] ?? [];
    return evidenceId ? comments.filter((c) => c.evidenceId === evidenceId) : comments;
  }

  /**
   * Creates a reviewer comment pinned to an immutable evidence version.
   *
   * Authorization: only reviewers assigned to the evidence version or admins.
   * Correctness: the supplied `evidenceVersion` must match the current evidence
   * version, otherwise a `ReviewerCommentConflictError` is raised so the
   * reviewer can refresh before commenting.
   * Idempotency: when `idempotencyKey` is supplied, retries return the
   * previously created comment instead of duplicating it.
   */
  async createReviewerComment(input: CreateReviewerCommentInput): Promise<ReviewerComment> {
    const { campaignId, evidenceId, evidenceVersion, body, actor, idempotencyKey } = input;
    if (!campaignId || !evidenceId || !actor?.id) {
      throw new ReviewerCommentValidationError(
        'campaignId, evidenceId, and actor are required'
      );
    }
    if (!body || !body.trim()) {
      throw new ReviewerCommentValidationError('Comment body must not be empty');
    }
    if (!Number.isInteger(evidenceVersion) || evidenceVersion < 1) {
      throw new ReviewerCommentValidationError('evidenceVersion must be a positive integer');
    }

    const snapshot = await this.loadEvidenceSnapshot(campaignId, evidenceId);
    if (!snapshot || snapshot.campaignId !== campaignId) {
      throw new ReviewerCommentNotFoundError('Evidence not found for this campaign');
    }

    this.assertCanComment(snapshot, actor);

    if (snapshot.version !== evidenceVersion) {
      throw new ReviewerCommentConflictError(
        `Stale evidence version: expected ${snapshot.version}, received ${evidenceVersion}`
      );
    }

    const all = await this.getAllReviewerComments();
    const existing = all[campaignId] ?? [];

    if (idempotencyKey) {
      const replay = existing.find((c) => c.idempotencyKey === idempotencyKey);
      if (replay) return replay;
    }

    const now = new Date().toISOString();
    const comment: ReviewerComment = {
      id: randomUUID(),
      campaignId,
      evidenceId,
      evidenceVersion,
      author: actor.id,
      body: body.trim(),
      createdAt: now,
      updatedAt: now,
      resolutionStatus: 'open',
      idempotencyKey,
    };

    existing.push(comment);
    all[campaignId] = existing;
    await this.writeJsonAtomic(this.commentsPath, all);

    return comment;
  }

  /**
   * Marks a reviewer comment as resolved. Only the original author or an admin
   * may resolve. Idempotent: resolving an already-resolved comment returns the
   * existing record unchanged.
   */
  async resolveReviewerComment(input: ResolveReviewerCommentInput): Promise<ReviewerComment> {
    const { campaignId, commentId, actor, resolutionNote } = input;
    if (!campaignId || !commentId || !actor?.id) {
      throw new ReviewerCommentValidationError(
        'campaignId, commentId, and actor are required'
      );
    }

    const all = await this.getAllReviewerComments();
    const comments = all[campaignId] ?? [];
    const comment = comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new ReviewerCommentNotFoundError('Reviewer comment not found');
    }

    if (actor.role !== 'admin' && actor.id !== comment.author) {
      throw new ReviewerCommentAuthorizationError(
        'Only the comment author or an admin may resolve this comment'
      );
    }

    if (comment.resolutionStatus === 'resolved') {
      return comment;
    }

    const now = new Date().toISOString();
    comment.resolutionStatus = 'resolved';
    comment.resolvedBy = actor.id;
    comment.resolvedAt = now;
    comment.resolutionNote = resolutionNote;
    comment.updatedAt = now;

    await this.writeJsonAtomic(this.commentsPath, all);
    return comment;
  }
}
﻿import { createHash } from "node:crypto";
import {
  VERIFICATION_EVENT_TYPES,
  type AppendVerificationEventInput,
  type VerificationAuditEntry,
  type VerificationEventType,
} from "@/types/campaign-verification";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPageInfo,
  normalizePagination,
  type PageInfo,
  type PaginationParams,
} from "@/types/pagination";
import {
  getCampaign,
  getCampaignDataSource,
  type CampaignDataSource,
} from "./campaign.service";
import {
  appendVerificationEvent,
  getVerificationAuditTrail,
  verifyVerificationAuditTrail,
} from "./campaign-verification.service";

export interface AuditTrailSummary {
  campaignId: string;
  totalActivities: number;
  isImmutableAndValid: boolean;
  latestEntryHash: string | null;
  blockchainAnchorStatus: "anchored" | "pending";
  activityCounts: Record<VerificationEventType, number>;
  entries: VerificationAuditEntry[];
}

export interface VerificationActivityFilter {
  eventType?: VerificationEventType;
  actorId?: string;
  since?: number;
}

export type VerificationActivitySortField = "occurredAt" | "id";
export type SortDirection = "asc" | "desc";

export interface VerificationActivitySort {
  field?: VerificationActivitySortField;
  direction?: SortDirection;
}

export interface VerificationActivityListParams extends PaginationParams {
  filter?: VerificationActivityFilter;
  sort?: VerificationActivitySort;
}

export interface PaginatedVerificationActivities {
  items: VerificationAuditEntry[];
  pageInfo: PageInfo;
}

export class CampaignVerificationAuditService {
  constructor(private dataSource: CampaignDataSource = getCampaignDataSource()) {}

  /**
   * Records a verification activity with immutable SHA-256 hash chaining
   * and simulated/anchor on-chain transaction identification.
   */
  async logActivity(
    campaignId: string,
    input: AppendVerificationEventInput
  ): Promise<VerificationAuditEntry> {
    return appendVerificationEvent(campaignId, input, this.dataSource);
  }

  /**
   * Retrieves full immutable audit trail with integrity status
   */
  async getAuditTrailSummary(campaignId: string): Promise<AuditTrailSummary | null> {
    const campaign = await getCampaign(campaignId, this.dataSource);
    if (!campaign) return null;

    const entries = (await getVerificationAuditTrail(campaignId, this.dataSource)) ?? [];
    const isImmutableAndValid = verifyVerificationAuditTrail(entries);
    const latestEntryHash = entries.length > 0 ? entries[entries.length - 1].entryHash : null;

    const activityCounts: Record<VerificationEventType, number> = {
      submitted_for_review: 0,
      verifier_comment: 0,
      photo_uploaded: 0,
      approved: 0,
      rejected: 0,
    };

    let allAnchored = entries.length > 0;
    for (const entry of entries) {
      if (entry.eventType in activityCounts) {
        activityCounts[entry.eventType]++;
      }
      if (!entry.blockchainTxHash || entry.blockchainTxHash.startsWith("pending:")) {
        allAnchored = false;
      }
    }

    return {
      campaignId,
      totalActivities: entries.length,
      isImmutableAndValid,
      latestEntryHash,
      blockchainAnchorStatus: allAnchored ? "anchored" : "pending",
      activityCounts,
      entries,
    };
  }

  /**
   * Filters verification activities by type, actor, or timestamp
   */
  async filterActivities(
    campaignId: string,
    filter: VerificationActivityFilter
  ): Promise<VerificationAuditEntry[]> {
    const entries = (await getVerificationAuditTrail(campaignId, this.dataSource)) ?? [];
    return entries.filter((e) => {
      if (filter.eventType && e.eventType !== filter.eventType) return false;
      if (filter.actorId && e.actorId !== filter.actorId) return false;
      if (filter.since && e.occurredAt < filter.since) return false;
      return true;
    });
  }

  /**
   * Lists verification activities with the shared pagination/sorting contract.
   *
   * Ordering is stable: entries are sorted by the requested field (default
   * `occurredAt` descending) with `id` as a deterministic tie-breaker so that
   * pages never overlap or skip entries. Page size is clamped to
   * `MAX_PAGE_SIZE` and the response carries shared `PageInfo` metadata.
   */
  async listActivities(
    campaignId: string,
    params: VerificationActivityListParams = {}
  ): Promise<PaginatedVerificationActivities> {
    const { page, pageSize } = normalizePagination(params, {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
    });

    const filter = params.filter ?? {};
    const sortField: VerificationActivitySortField = params.sort?.field ?? "occurredAt";
    const direction: SortDirection = params.sort?.direction ?? "desc";

    const entries = await this.filterActivities(campaignId, filter);

    const sorted = [...entries].sort((a, b) => {
      const primaryA = sortField === "id" ? a.id : a.occurredAt;
      const primaryB = sortField === "id" ? b.id : b.occurredAt;
      let cmp = 0;
      if (primaryA < primaryB) cmp = -1;
      else if (primaryA > primaryB) cmp = 1;
      if (cmp === 0) {
        // Stable tie-breaker on id, always ascending for determinism.
        if (a.id < b.id) cmp = -1;
        else if (a.id > b.id) cmp = 1;
      }
      return direction === "asc" ? cmp : -cmp;
    });

    const totalItems = sorted.length;
    const offset = (page - 1) * pageSize;
    const items = sorted.slice(offset, offset + pageSize);

    return {
      items,
      pageInfo: buildPageInfo({ page, pageSize, totalItems }),
    };
  }

  /**
   * Generates a cryptographic verification certificate for external audit
   */
  async generateAuditCertificate(campaignId: string) {
    const summary = await this.getAuditTrailSummary(campaignId);
    if (!summary) throw new Error("Campaign not found");

    const certificatePayload = {
      campaignId,
      verifiedAt: Date.now(),
      auditTrailLength: summary.totalActivities,
      rootHash: summary.latestEntryHash,
      cryptographicIntegrity: summary.isImmutableAndValid,
      signature: createHash("sha256")
        .update(`${campaignId}:${summary.latestEntryHash}:${summary.isImmutableAndValid}`)
        .digest("hex"),
    };

    return certificatePayload;
  }
}

export const campaignVerificationAuditService = new CampaignVerificationAuditService();
