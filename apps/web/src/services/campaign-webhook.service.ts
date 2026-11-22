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
 * Persisted record of an authorized manual redelivery attempt.
 *
 * The original event payload and signature inputs (version/timestamp) are
 * copied verbatim from the stored delivery so operators can prove that a
 * redelivery did not mutate the signed content. One record is appended per
 * attempt, including failed attempts, so the audit trail is complete.
 */
export interface OperatorRedeliveryAuditRecord {
  subscriptionId: string;
  eventId: string;
  operatorId: string;
  reason: string;
  /** Outcome of the attempt: "delivered" or "failed". */
  outcome: "delivered" | "failed";
  /** Error message when outcome is "failed". */
  error?: string;
  /** Original signature version, preserved unchanged. */
  signatureVersion: string;
  /** Original signature timestamp, preserved unchanged. */
  signatureTimestamp: string;
  /** Original event payload, preserved unchanged. */
  payload: Record<string, unknown>;
  attemptedAt: string;
}

export interface OperatorRedeliveryRequest {
  subscriptionId: string;
  eventId: string;
  operatorId: string;
  reason: string;
}

/**
 * Caller identity used to authorize operator actions at the service boundary.
 * The owning API layer is responsible for authenticating the caller and
 * passing the resolved role; the service re-checks it so a mis-wired route
 * cannot bypass authorization.
 */
export interface OperatorContext {
  operatorId: string;
  role: string;
}

/** Stored delivery inputs needed to replay an event without mutating it. */
export interface StoredDelivery {
  subscriptionId: string;
  eventId: string;
  payload: Record<string, unknown>;
  signatureVersion: string;
  signatureTimestamp: string;
}

/**
 * Durable store for original delivery inputs and the operator audit trail.
 */
export interface OperatorRedeliveryStore {
  /** Loads the original delivery inputs, or null if unknown. */
  loadDelivery(subscriptionId: string, eventId: string): Promise<StoredDelivery | null>;
  /** Appends an audit record; MUST be durable before the call resolves. */
  appendAuditRecord(record: OperatorRedeliveryAuditRecord): Promise<void>;
}

/** Health snapshot for a single destination's circuit breaker. */
export interface DestinationBreakerHealth {
  subscriptionId: string;
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt?: string;
}

/**
 * Publishes the campaign lifecycle events consumed by external integrations.
 * The event identifiers are intentionally supplied by the caller so replayed
 * indexer notifications are deduplicated by WebhookService.
 */
export class CampaignWebhookService {
  constructor(
    private readonly webhookService = new WebhookService(),
    private readonly subscriptionStore?: CampaignWebhookSubscriptionStore,
    private readonly redeliveryStore?: OperatorRedeliveryStore
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

  /**
   * Replays a previously dispatched event to a single destination on behalf
   * of an authorized operator.
   *
   * Guarantees:
   * - Authorization is enforced here, at the service boundary: only callers
   *   with the "admin" role may redeliver.
   * - The original event payload and signature version/timestamp are loaded
   *   from the durable store and passed through unchanged; the method never
   *   re-signs or mutates the payload.
   * - Delivery reuses the isolated per-destination path in WebhookService so
   *   a failing destination cannot starve healthy ones.
   * - Exactly one audit record is appended per attempt, recording the outcome
   *   (delivered or failed) so operators can see failure and recovery states.
   */
  async redeliverEvent(
    request: OperatorRedeliveryRequest,
    operator: OperatorContext
  ): Promise<OperatorRedeliveryAuditRecord> {
    this.assertRequired(request.subscriptionId, "subscriptionId");
    this.assertRequired(request.eventId, "eventId");
    this.assertRequired(request.operatorId, "operatorId");
    this.assertRequired(request.reason, "reason");

    if (!operator || operator.role !== "admin") {
      throw new Error("redeliverEvent requires an admin operator");
    }
    if (operator.operatorId !== request.operatorId) {
      throw new Error("operatorId does not match authenticated operator");
    }
    if (!this.redeliveryStore) {
      throw new Error("redeliveryStore is required to redeliver events");
    }

    const delivery = await this.redeliveryStore.loadDelivery(
      request.subscriptionId,
      request.eventId
    );
    if (!delivery) {
      throw new Error(
        `no stored delivery for subscription ${request.subscriptionId} event ${request.eventId}`
      );
    }

    // Preserve the original signed inputs verbatim.
    const payload = delivery.payload;
    const signatureVersion = delivery.signatureVersion;
    const signatureTimestamp = delivery.signatureTimestamp;

    let outcome: "delivered" | "failed" = "delivered";
    let errorMessage: string | undefined;
    try {
      await this.webhookService.dispatchEventToDestination(
        request.subscriptionId,
        request.eventId,
        payload,
        { signatureVersion, signatureTimestamp }
      );
    } catch (error) {
      outcome = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const record: OperatorRedeliveryAuditRecord = {
      subscriptionId: request.subscriptionId,
      eventId: request.eventId,
      operatorId: request.operatorId,
      reason: request.reason,
      outcome,
      ...(errorMessage ? { error: errorMessage } : {}),
      signatureVersion,
      signatureTimestamp,
      payload,
      attemptedAt: new Date().toISOString(),
    };
    await this.redeliveryStore.appendAuditRecord(record);

    if (outcome === "failed") {
      throw new Error(`redelivery failed: ${errorMessage}`);
    }
    return record;
  }

  /**
   * Returns the circuit breaker health for each campaign destination so
   * operators can see which subscribers are failing and which have recovered.
   */
  getDestinationHealth(): DestinationBreakerHealth[] {
    return this.webhookService.getDestinationHealth();
  }

  private assertRequired(value: string, field: string): void {
    if (!value.trim()) throw new Error(`${field} is required`);
  }
}

export const campaignWebhookService = new CampaignWebhookService();
