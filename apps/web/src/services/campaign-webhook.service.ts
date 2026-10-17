import { WebhookService } from "@/services/webhook.service";
import type {
  BatchVerifiedEvent,
  CampaignCompletedEvent,
  CampaignImpactMilestoneEvent,
  CampaignMilestoneReachedEvent,
  ImpactMilestone,
  TreeVerifiedEvent,
} from "@/types/campaign-webhook";

/**
 * Persistence contract for campaign webhook subscriptions.
 *
 * Durable source of truth: the `webhook_subscriptions` table (owned by the
 * API package) is the single source of truth for which campaigns receive
 * lifecycle events. In-memory caches are derived state only and MUST be
 * rebuildable from the table after a process restart.
 *
 * Transaction boundaries:
 * - A subscription write (create/update/delete) is a single transaction that
 *   commits the subscription row together with its delivery bookkeeping. A
 *   partial write (e.g. row inserted but bookkeeping missing) is rolled back
 *   so readers never observe a half-registered subscription.
 * - Event dispatch is NOT part of the subscription transaction. Dispatch
 *   happens after commit and is idempotent via the caller-supplied eventId,
 *   so a crash between commit and dispatch is recovered by replaying the
 *   event without duplicating deliveries.
 *
 * Recovery: on startup the service reloads subscriptions from the durable
 * store; any dispatch that was committed but not delivered is retried using
 * the same eventId and therefore deduplicated by WebhookService.
 */
export interface CampaignWebhookSubscriptionStore {
  /**
   * Persists a subscription atomically. Implementations MUST either commit
   * the full record or throw without leaving partial state behind.
   */
  saveSubscription(subscription: CampaignWebhookSubscription): Promise<void>;
  /** Loads all durable subscriptions; used to rebuild state after restart. */
  loadSubscriptions(): Promise<CampaignWebhookSubscription[]>;
}

export interface CampaignWebhookSubscription {
  campaignId: string;
  url: string;
  active: boolean;
}

/**
 * Publishes the campaign lifecycle events consumed by external integrations.
 * The event identifiers are intentionally supplied by the caller so replayed
 * indexer notifications are deduplicated by WebhookService.
 */
export class CampaignWebhookService {
  constructor(
    private readonly webhookService = new WebhookService(),
    private readonly subscriptionStore?: CampaignWebhookSubscriptionStore
  ) {}

  async treeVerified(event: TreeVerifiedEvent): Promise<void> {
    this.assertRequired(event.verificationId, "verificationId");
    this.assertRequired(event.treeId, "treeId");
    this.assertRequired(event.campaignId, "campaignId");

    await this.webhookService.dispatchEvent("tree_verified", {
      ...event,
      eventId: event.verificationId,
    });
  }

  async batchVerified(event: BatchVerifiedEvent): Promise<void> {
    this.assertRequired(event.batchId, "batchId");
    this.assertRequired(event.campaignId, "campaignId");
    if (event.treeIds.length < 10) {
      throw new Error("batch_verified requires at least 10 verified trees");
    }

    await this.webhookService.dispatchEvent("batch_verified", {
      ...event,
      eventId: event.batchId,
      treeCount: event.treeIds.length,
    });
  }

  async campaignMilestoneReached(event: CampaignMilestoneReachedEvent): Promise<void> {
    this.assertRequired(event.eventId, "eventId");
    this.assertRequired(event.campaignId, "campaignId");

    await this.webhookService.dispatchEvent("campaign_milestone_reached", { ...event });
  }

  async campaignImpactMilestoneReached(event: CampaignImpactMilestoneEvent): Promise<void> {
    this.assertRequired(event.eventId, "eventId");
    this.assertRequired(event.campaignId, "campaignId");
    this.assertRequired(event.milestone, "milestone");

    await this.webhookService.dispatchEvent("campaign_milestone_reached", { ...event });
  }

  async checkAndDispatchImpactMilestones(
    campaignId: string,
    treeCount: number,
    co2Sequestration?: number | string | null,
    previouslyTriggered: ImpactMilestone[] = []
  ): Promise<ImpactMilestone[]> {
    this.assertRequired(campaignId, "campaignId");
    const triggered: ImpactMilestone[] = [];
    const co2Num =
      co2Sequestration !== null && co2Sequestration !== undefined
        ? Number(co2Sequestration)
        : 0;
    const co2Str =
      co2Sequestration !== null && co2Sequestration !== undefined
        ? String(co2Sequestration)
        : null;

    if (treeCount >= 1000 && !previouslyTriggered.includes("1000_trees")) {
      await this.campaignImpactMilestoneReached({
        eventId: `${campaignId}:impact:1000_trees`,
        campaignId,
        milestone: "1000_trees",
        treeCount,
        co2Sequestration: co2Str,
      });
      triggered.push("1000_trees");
    }

    if (treeCount >= 5000 && !previouslyTriggered.includes("5000_trees")) {
      await this.campaignImpactMilestoneReached({
        eventId: `${campaignId}:impact:5000_trees`,
        campaignId,
        milestone: "5000_trees",
        treeCount,
        co2Sequestration: co2Str,
      });
      triggered.push("5000_trees");
    }

    if (!isNaN(co2Num) && co2Num >= 10 && !previouslyTriggered.includes("10_tons_co2")) {
      await this.campaignImpactMilestoneReached({
        eventId: `${campaignId}:impact:10_tons_co2`,
        campaignId,
        milestone: "10_tons_co2",
        treeCount,
        co2Sequestration: co2Str,
      });
      triggered.push("10_tons_co2");
    }

    return triggered;
  }

  async campaignCompleted(event: CampaignCompletedEvent): Promise<void> {
    this.assertRequired(event.completionId, "completionId");
    this.assertRequired(event.campaignId, "campaignId");

    await this.webhookService.dispatchEvent("campaign_completed", {
      ...event,
      eventId: event.completionId,
    });
  }

  /**
   * Persists a campaign webhook subscription within a single transaction
   * boundary. If the durable write fails, no in-memory state is mutated and
   * the error propagates so the caller can retry the whole operation.
   */
  async registerSubscription(subscription: CampaignWebhookSubscription): Promise<void> {
    this.assertRequired(subscription.campaignId, "campaignId");
    this.assertRequired(subscription.url, "url");
    if (!this.subscriptionStore) {
      throw new Error("subscriptionStore is required to persist subscriptions");
    }

    await this.subscriptionStore.saveSubscription({ ...subscription });
  }

  /**
   * Rebuilds derived subscription state from the durable store. Safe to call
   * on every process start; returns the durable records so callers can verify
   * that state survived a restart.
   */
  async recoverSubscriptions(): Promise<CampaignWebhookSubscription[]> {
    if (!this.subscriptionStore) {
      throw new Error("subscriptionStore is required to recover subscriptions");
    }
    return this.subscriptionStore.loadSubscriptions();
  }

  private assertRequired(value: string, field: string): void {
    if (!value.trim()) throw new Error(`${field} is required`);
  }
}

export const campaignWebhookService = new CampaignWebhookService();
