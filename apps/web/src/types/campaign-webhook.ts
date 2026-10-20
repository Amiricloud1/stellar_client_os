export const CAMPAIGN_WEBHOOK_EVENTS = [
  "tree_verified",
  "batch_verified",
  "campaign_milestone_reached",
  "campaign_completed",
] as const;

export type CampaignWebhookEvent = (typeof CAMPAIGN_WEBHOOK_EVENTS)[number];

/**
 * Persistence contract for campaign webhook records.
 *
 * Campaign state and webhook subscriptions are the durable source of truth for
 * the API. Records are persisted before any side effect (delivery attempt,
 * event emission) is acknowledged, and every mutation happens inside a single
 * transaction boundary so that a process restart never observes a partially
 * written record.
 *
 * Durability-relevant fields:
 * - `recordId`: stable primary key of the persisted record.
 * - `sequence`: monotonically increasing per-campaign ordering token used to
 *   detect gaps or replays after recovery.
 * - `persistedAt`: ISO timestamp of the durable write (not the event time).
 * - `schemaVersion`: version of the persisted shape, used for migrations.
 *
 * Migration implications: records written before these fields existed are
 * treated as `schemaVersion: 1` with no `sequence`. Readers must tolerate their
 * absence; writers must always populate them. Backfill assigns `sequence` in
 * `persistedAt` order and bumps `schemaVersion` to the current value.
 */
export const CAMPAIGN_WEBHOOK_SCHEMA_VERSION = 2;

export interface CampaignWebhookDurabilityFields {
  /** Stable primary key of the persisted record. */
  recordId?: string;
  /** Monotonic per-campaign ordering token; absent on legacy (v1) records. */
  sequence?: number;
  /** ISO timestamp of the durable write, distinct from the event time. */
  persistedAt?: string;
  /** Persisted shape version; legacy records are treated as version 1. */
  schemaVersion?: number;
}

export interface TreeVerifiedEvent extends CampaignWebhookDurabilityFields {
  verificationId: string;
  treeId: string;
  campaignId: string;
  verifiedAt: string;
  verifier?: string;
  nullifier?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface BatchVerifiedEvent extends CampaignWebhookDurabilityFields {
  batchId: string;
  campaignId: string;
  treeIds: string[];
  verifiedAt: string;
  verifier?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface CampaignMilestoneReachedEvent extends CampaignWebhookDurabilityFields {
  eventId: string;
  campaignId: string;
  campaignName?: string;
  /** Funding percentage milestone (25, 50, 75, 100) */
  milestone?: number;
  percentage?: number;
  raisedAmount?: string;
  goalAmount?: string;
  treeCount?: number;
}

/**
 * Impact milestone types: tree count thresholds and CO2 sequestration targets
 */
export type ImpactMilestone = "1000_trees" | "5000_trees" | "10_tons_co2";

export interface CampaignImpactMilestoneEvent extends CampaignWebhookDurabilityFields {
  eventId: string;
  campaignId: string;
  /** Milestone type: 1000_trees, 5000_trees, or 10_tons_co2 */
  milestone: ImpactMilestone;
  /** Total trees planted for this campaign */
  treeCount: number;
  /** Total CO2 sequestered in metric tonnes (decimal string), or null if unavailable */
  co2Sequestration: string | null;
}

export interface CampaignCompletedEvent extends CampaignWebhookDurabilityFields {
  completionId: string;
  campaignId: string;
  completedAt: string;
  treeCount?: number;
  raisedAmount?: string;
  goalAmount?: string;
  metadata?: Record<string, unknown>;
}
