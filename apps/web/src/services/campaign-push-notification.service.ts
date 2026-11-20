import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  CampaignPushSubscription,
  CampaignMilestoneType,
  MilestoneNotificationPayload,
  DeliveredPushNotification,
  DeviceType,
  PushSubscriptionKeys,
} from '../types/campaign-notification';

/**
 * A notification intent produced by a domain event (e.g. a campaign milestone
 * transition). Intents are persisted to an outbox and consumed asynchronously
 * so that event receipt is decoupled from provider delivery.
 */
export interface CampaignPushNotificationIntent {
  /** Stable identifier of the originating domain event. Used for dedupe. */
  eventId: string;
  campaignId: string;
  milestone: CampaignMilestoneType;
  details: MilestoneNotificationPayload['details'];
  campaignTitle?: string;
  deepLinkUrl?: string;
  /** When the intent was enqueued (ISO-8601). */
  enqueuedAt?: string;
}

export type DeliveryOutcomeStatus = 'queued' | 'sent' | 'suppressed' | 'failed';

export interface DeliveryOutcome {
  eventId: string;
  subscriptionId: string;
  milestone: CampaignMilestoneType;
  status: DeliveryOutcomeStatus;
  /** Reason for suppression/failure, surfaced to operators. */
  reason?: string;
  /** True when the outcome was produced by a replayed intent and no send occurred. */
  deduplicated?: boolean;
}

export interface ConsumeIntentsResult {
  sentCount: number;
  suppressedCount: number;
  failedCount: number;
  deduplicatedCount: number;
  delivered: DeliveredPushNotification[];
  outcomes: DeliveryOutcome[];
}

export interface CampaignPushServiceOptions {
  dataDir?: string;
  pushSender?: (
    subscription: CampaignPushSubscription,
    payload: { title: string; body: string; data: Record<string, unknown> }
  ) => Promise<boolean>;
  /** Optional clock injection for deterministic tests. */
  now?: () => Date;
}

export class CampaignPushNotificationService {
  private readonly subscriptionsPath: string;
  private readonly notificationsPath: string;
  private readonly pushSender?: (
    subscription: CampaignPushSubscription,
    payload: { title: string; body: string; data: Record<string, unknown> }
  ) => Promise<boolean>;
  private readonly now: () => Date;

  constructor(options: CampaignPushServiceOptions = {}) {
    const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
    this.subscriptionsPath = path.join(dataDir, 'mobile_push_subscriptions.json');
    this.notificationsPath = path.join(dataDir, 'mobile_push_delivered.json');
    this.pushSender = options.pushSender;
    this.now = options.now ?? (() => new Date());
  }

  private deliveryKey(
    eventId: string,
    subscriptionId: string,
    milestone: CampaignMilestoneType
  ): string {
    return `${eventId}::${subscriptionId}::${milestone}`;
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

  async getSubscriptions(): Promise<CampaignPushSubscription[]> {
    try {
      const data = await fs.readFile(this.subscriptionsPath, 'utf-8');
      return JSON.parse(data) as CampaignPushSubscription[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  async getDeliveredNotifications(): Promise<DeliveredPushNotification[]> {
    try {
      const data = await fs.readFile(this.notificationsPath, 'utf-8');
      return JSON.parse(data) as DeliveredPushNotification[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') return [];
      throw err;
    }
  }

  async registerSubscription(input: {
    subscriberAddress: string;
    campaignId?: string;
    endpoint: string;
    keys: PushSubscriptionKeys;
    deviceType?: DeviceType;
    enabledMilestones?: CampaignMilestoneType[];
  }): Promise<CampaignPushSubscription> {
    if (!input.subscriberAddress || !input.endpoint || !input.keys?.auth || !input.keys?.p256dh) {
      throw new Error('Invalid push subscription: subscriberAddress, endpoint, and keys are required');
    }

    const subscriptions = await this.getSubscriptions();
    const existingIndex = subscriptions.findIndex((s) => s.endpoint === input.endpoint);

    const now = new Date().toISOString();
    const defaultMilestones: CampaignMilestoneType[] = [
      'trees_planted',
      'verification_complete',
      'campaign_finished',
      'impact_achieved',
    ];

    if (existingIndex >= 0) {
      const existing = subscriptions[existingIndex];
      const updated: CampaignPushSubscription = {
        ...existing,
        subscriberAddress: input.subscriberAddress,
        campaignId: input.campaignId ?? existing.campaignId,
        deviceType: input.deviceType ?? existing.deviceType,
        enabledMilestones: input.enabledMilestones ?? existing.enabledMilestones,
        updatedAt: now,
      };
      subscriptions[existingIndex] = updated;
      await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
      return updated;
    }

    const newSub: CampaignPushSubscription = {
      id: `sub_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      subscriberAddress: input.subscriberAddress,
      campaignId: input.campaignId ?? '*',
      endpoint: input.endpoint,
      keys: input.keys,
      deviceType: input.deviceType ?? 'unknown',
      enabledMilestones: input.enabledMilestones ?? defaultMilestones,
      createdAt: now,
      updatedAt: now,
    };

    subscriptions.push(newSub);
    await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
    return newSub;
  }

  async unregisterSubscription(endpointOrId: string): Promise<boolean> {
    const subscriptions = await this.getSubscriptions();
    const filtered = subscriptions.filter(
      (s) => s.endpoint !== endpointOrId && s.id !== endpointOrId
    );
    if (filtered.length === subscriptions.length) {
      return false;
    }
    await this.writeJsonAtomic(this.subscriptionsPath, filtered);
    return true;
  }

  async updatePreferences(
    subscriberAddress: string,
    campaignId: string,
    enabledMilestones: CampaignMilestoneType[]
  ): Promise<CampaignPushSubscription[]> {
    const subscriptions = await this.getSubscriptions();
    const updatedList: CampaignPushSubscription[] = [];

    for (let i = 0; i < subscriptions.length; i++) {
      const sub = subscriptions[i];
      if (
        sub.subscriberAddress.toLowerCase() === subscriberAddress.toLowerCase() &&
        (campaignId === '*' || sub.campaignId === '*' || sub.campaignId === campaignId)
      ) {
        sub.enabledMilestones = enabledMilestones;
        sub.updatedAt = new Date().toISOString();
        updatedList.push(sub);
      }
    }

    if (updatedList.length > 0) {
      await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
    }

    return updatedList;
  }

  formatMilestoneContent(payload: MilestoneNotificationPayload): { title: string; body: string } {
    const name = payload.campaignTitle || `Campaign #${payload.campaignId}`;

    switch (payload.milestone) {
      case 'trees_planted': {
        const count = payload.details.treesPlanted ?? 'New';
        const target = payload.details.targetTrees ? ` of ${payload.details.targetTrees}` : '';
        return {
          title: `🌱 Milestone Reached: Trees Planted!`,
          body: `${name} has just reached ${count}${target} trees planted!`,
        };
      }
      case 'verification_complete': {
        return {
          title: `✅ Milestone: Verification Complete!`,
          body: `Verification for ${name} has been successfully validated and logged on-chain.`,
        };
      }
      case 'campaign_finished': {
        return {
          title: `🎉 Milestone: Campaign Finished!`,
          body: `${name} has completed all milestones and successfully finished!`,
        };
      }
      case 'impact_achieved': {
        const impact = payload.details.impactDescription ?? 'environmental targets achieved';
        return {
          title: `🌍 Milestone: Impact Achieved!`,
          body: `${name} has achieved its targeted impact: ${impact}.`,
        };
      }
    }
  }

  /**
   * Consume a batch of notification intents produced by domain events.
   *
   * Delivery is idempotent: each (eventId, subscriptionId, milestone) triple is
   * delivered at most once. Replayed intents are deduplicated and reported as
   * `deduplicated` outcomes without contacting the push provider.
   *
   * Opt-outs and subscription state are re-evaluated at send time, so a
   * subscriber who disabled a milestone (or unregistered) after the event was
   * enqueued is suppressed rather than notified.
   */
  async consumeNotificationIntents(
    intents: CampaignPushNotificationIntent[]
  ): Promise<ConsumeIntentsResult> {
    const subscriptions = await this.getSubscriptions();
    const deliveredRecords = await this.getDeliveredNotifications();

    const seen = new Set<string>(
      deliveredRecords.map((r) =>
        this.deliveryKey(r.eventId ?? '', r.subscriptionId, r.milestone)
      )
    );

    const newDeliveries: DeliveredPushNotification[] = [];
    const outcomes: DeliveryOutcome[] = [];
    let sentCount = 0;
    let suppressedCount = 0;
    let failedCount = 0;
    let deduplicatedCount = 0;

    for (const intent of intents) {
      const payload: MilestoneNotificationPayload = {
        campaignId: intent.campaignId,
        campaignTitle: intent.campaignTitle,
        milestone: intent.milestone,
        details: intent.details,
        deepLinkUrl: intent.deepLinkUrl,
      };

      const { title, body } = this.formatMilestoneContent(payload);
      const deepLinkUrl = intent.deepLinkUrl || `/campaigns/${intent.campaignId}`;
      const pushData = {
        campaignId: intent.campaignId,
        milestone: intent.milestone,
        deepLinkUrl,
        ...intent.details,
      };

      // Candidate subscriptions for this campaign. Opt-out is re-checked below
      // at send time so stale intents cannot bypass preferences.
      const candidateSubs = subscriptions.filter(
        (sub) => sub.campaignId === '*' || sub.campaignId === intent.campaignId
      );

      if (candidateSubs.length === 0) {
        outcomes.push({
          eventId: intent.eventId,
          subscriptionId: '',
          milestone: intent.milestone,
          status: 'suppressed',
          reason: 'no_matching_subscriptions',
        });
        suppressedCount++;
        continue;
      }

      for (const sub of candidateSubs) {
        const key = this.deliveryKey(intent.eventId, sub.id, intent.milestone);

        if (seen.has(key)) {
          outcomes.push({
            eventId: intent.eventId,
            subscriptionId: sub.id,
            milestone: intent.milestone,
            status: 'suppressed',
            reason: 'duplicate_event',
            deduplicated: true,
          });
          deduplicatedCount++;
          continue;
        }

        // Authorization / opt-out re-check at send time.
        if (!sub.enabledMilestones.includes(intent.milestone)) {
          outcomes.push({
            eventId: intent.eventId,
            subscriptionId: sub.id,
            milestone: intent.milestone,
            status: 'suppressed',
            reason: 'milestone_disabled',
          });
          suppressedCount++;
          continue;
        }

        let success = true;
        let errorMsg: string | undefined;

        if (this.pushSender) {
          try {
            success = await this.pushSender(sub, { title, body, data: pushData });
          } catch (err: unknown) {
            success = false;
            errorMsg = err instanceof Error ? err.message : 'Push transmission failed';
          }
        }

        const deliveryRecord: DeliveredPushNotification = {
          id: `ntf_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          eventId: intent.eventId,
          subscriptionId: sub.id,
          subscriberAddress: sub.subscriberAddress,
          campaignId: intent.campaignId,
          milestone: intent.milestone,
          title,
          body,
          data: pushData,
          sentAt: this.now().toISOString(),
          status: success ? 'sent' : 'failed',
          errorMessage: errorMsg,
        };

        // Record the attempt (success or failure) so replays are deduplicated.
        seen.add(key);
        newDeliveries.push(deliveryRecord);
        deliveredRecords.push(deliveryRecord);

        if (success) {
          sentCount++;
          outcomes.push({
            eventId: intent.eventId,
            subscriptionId: sub.id,
            milestone: intent.milestone,
            status: 'sent',
          });
        } else {
          failedCount++;
          outcomes.push({
            eventId: intent.eventId,
            subscriptionId: sub.id,
            milestone: intent.milestone,
            status: 'failed',
            reason: errorMsg,
          });
        }
      }
    }

    if (newDeliveries.length > 0) {
      await this.writeJsonAtomic(this.notificationsPath, deliveredRecords);
    }

    return {
      sentCount,
      suppressedCount,
      failedCount,
      deduplicatedCount,
      delivered: newDeliveries,
      outcomes,
    };
  }

  /**
   * @deprecated Prefer enqueuing a {@link CampaignPushNotificationIntent} and
   * calling {@link consumeNotificationIntents}. This direct-send path is kept
   * for backward compatibility and derives a synthetic event id so that
   * repeated calls with the same payload are deduplicated.
   */
  async sendMilestonePushNotification(
    payload: MilestoneNotificationPayload
  ): Promise<{ sentCount: number; errors: number; delivered: DeliveredPushNotification[] }> {
    const eventId =
      payload.eventId ??
      `legacy_${payload.campaignId}_${payload.milestone}_${JSON.stringify(payload.details)}`;

    const result = await this.consumeNotificationIntents([
      {
        eventId,
        campaignId: payload.campaignId,
        campaignTitle: payload.campaignTitle,
        milestone: payload.milestone,
        details: payload.details,
        deepLinkUrl: payload.deepLinkUrl,
      },
    ]);

    return {
      sentCount: result.sentCount,
      errors: result.failedCount,
      delivered: result.delivered,
    };
  }
}
