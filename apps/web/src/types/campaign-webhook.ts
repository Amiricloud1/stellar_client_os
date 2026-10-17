export const CAMPAIGN_WEBHOOK_EVENTS = [
  "tree_verified",
  "batch_verified",
  "campaign_milestone_reached",
  "campaign_completed",
] as const;

export type CampaignWebhookEvent = (typeof CAMPAIGN_WEBHOOK_EVENTS)[number];

export interface TreeVerifiedEvent {
  verificationId: string;
  treeId: string;
  campaignId: string;
  verifiedAt: string;
  verifier?: string;
  nullifier?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface BatchVerifiedEvent {
  batchId: string;
  campaignId: string;
  treeIds: string[];
  verifiedAt: string;
  verifier?: string;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface CampaignMilestoneReachedEvent {
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

export interface CampaignImpactMilestoneEvent {
  eventId: string;
  campaignId: string;
  /** Milestone type: 1000_trees, 5000_trees, or 10_tons_co2 */
  milestone: ImpactMilestone;
  /** Total trees planted for this campaign */
  treeCount: number;
  /** Total CO2 sequestered in metric tonnes (decimal string), or null if unavailable */
  co2Sequestration: string | null;
}

export interface CampaignCompletedEvent {
  completionId: string;
  campaignId: string;
  completedAt: string;
  treeCount?: number;
  raisedAmount?: string;
  goalAmount?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A campaign webhook subscription as stored server-side.
 *
 * `accountId` scopes the subscription to its owning account so that reads,
 * updates, rotations and revocations can be authorized against the caller.
 * `secret` is the HMAC signing secret and must never be returned by read
 * endpoints — use {@link CampaignWebhookSubscriptionPublic} for responses.
 */
export interface CampaignWebhookSubscription {
  id: string;
  /** Owning account; used to enforce cross-account isolation. */
  accountId: string;
  campaignId: string;
  url: string;
  events: CampaignWebhookEvent[];
  /** HMAC signing secret. Only revealed once, at creation or rotation. */
  secret: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  /** Timestamp of the most recent secret rotation, if any. */
  secretRotatedAt?: string;
}

/**
 * Public projection of a campaign webhook subscription. Omits `secret` so
 * that read endpoints can never leak the signing secret.
 */
export type CampaignWebhookSubscriptionPublic = Omit<
  CampaignWebhookSubscription,
  "secret"
>;

/**
 * Response returned when a subscription is created or its secret is rotated.
 * This is the only place the plaintext secret is exposed.
 */
export interface CampaignWebhookSubscriptionWithSecret
  extends CampaignWebhookSubscriptionPublic {
  secret: string;
}
