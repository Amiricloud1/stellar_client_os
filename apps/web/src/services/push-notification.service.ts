export type CampaignMilestone = 
  | 'trees planted'
  | 'verification complete'
  | 'campaign finished'
  | 'impact achieved'
  | string;

export interface SendPushNotificationOptions {
  userId?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Explicit lifecycle states for a notification intent.
 *
 * - `queued`     : intent accepted, awaiting delivery
 * - `sent`       : provider accepted the delivery
 * - `suppressed` : delivery intentionally skipped (opt-out / no recipient / no prefs)
 * - `failed`     : provider delivery failed; eligible for retry
 */
export type NotificationStatus = 'queued' | 'sent' | 'suppressed' | 'failed';

export type NotificationChannel = 'push' | string;

export interface NotificationIntent {
  /** Stable idempotency key derived from (eventId, recipient, channel). */
  key: string;
  eventId: string;
  recipient: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: NotificationStatus;
  attempts: number;
  lastError?: string;
  suppressedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueNotificationIntentOptions {
  /** Stable identifier of the originating domain event. Required for dedupe. */
  eventId: string;
  /** Recipient user id. Required; intents without a recipient are rejected. */
  recipient: string;
  channel?: NotificationChannel;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface NotificationPreferences {
  /** Whether the user has opted into push notifications. */
  pushEnabled?: boolean;
  /** Explicit per-channel opt-outs. */
  optOuts?: NotificationChannel[];
}

/**
 * Minimal preferences service contract. The outbox re-checks opt-outs at send
 * time (not enqueue time) so that a user who opts out after an event is
 * received but before delivery is honored.
 */
export interface NotificationPreferencesService {
  getPreferences(userId: string): Promise<NotificationPreferences | null | undefined>;
}

export interface DeliverPendingNotificationsResult {
  sent: number;
  suppressed: number;
  failed: number;
  skipped: number;
}

export interface DeliverPendingNotificationsOptions {
  /** Maximum number of delivery attempts per intent before it is left failed. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function buildIntentKey(eventId: string, recipient: string, channel: NotificationChannel): string {
  return `${eventId}::${recipient}::${channel}`;
}

export class PushNotificationService {
  private readonly outbox = new Map<string, NotificationIntent>();
  private readonly preferencesService?: NotificationPreferencesService;

  constructor(preferencesService?: NotificationPreferencesService) {
    this.preferencesService = preferencesService;
  }

  /**
   * Mock implementation of a push notification provider.
   * In a real environment, this would use web-push, Firebase Cloud Messaging, OneSignal, etc.
   */
  async sendPushNotification(options: SendPushNotificationOptions): Promise<boolean> {
    console.log(`[PushNotificationService] Sending push notification to user: ${options.userId || 'broadcast'}`);
    console.log(`[PushNotificationService] Title: ${options.title}`);
    console.log(`[PushNotificationService] Body: ${options.body}`);
    
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    console.log(`[PushNotificationService] Push notification sent successfully.`);
    return true;
  }

  /**
   * Accept a notification intent from a domain event.
   *
   * Idempotent: replaying the same (eventId, recipient, channel) returns the
   * existing intent without creating a duplicate or resetting its state.
   */
  async enqueueNotificationIntent(options: EnqueueNotificationIntentOptions): Promise<NotificationIntent> {
    const channel: NotificationChannel = options.channel ?? 'push';
    const recipient = options.recipient?.trim();

    if (!options.eventId) {
      throw new Error('enqueueNotificationIntent requires a non-empty eventId');
    }
    if (!recipient) {
      throw new Error('enqueueNotificationIntent requires a non-empty recipient');
    }

    const key = buildIntentKey(options.eventId, recipient, channel);
    const existing = this.outbox.get(key);
    if (existing) {
      // Dedupe on replay: return the existing intent untouched.
      return existing;
    }

    const now = Date.now();
    const intent: NotificationIntent = {
      key,
      eventId: options.eventId,
      recipient,
      channel,
      title: options.title,
      body: options.body,
      data: options.data,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.outbox.set(key, intent);
    return intent;
  }

  /**
   * Deliver all queued (and retryable failed) intents.
   *
   * Opt-outs are re-checked here, at send time, via the preferences service.
   * Intents whose recipient has no preferences or has opted out are marked
   * `suppressed` and never sent.
   */
  async deliverPendingNotifications(
    options: DeliverPendingNotificationsOptions = {}
  ): Promise<DeliverPendingNotificationsResult> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const result: DeliverPendingNotificationsResult = { sent: 0, suppressed: 0, failed: 0, skipped: 0 };

    for (const intent of this.outbox.values()) {
      if (intent.status === 'sent' || intent.status === 'suppressed') {
        result.skipped += 1;
        continue;
      }
      if (intent.status === 'failed' && intent.attempts >= maxAttempts) {
        result.skipped += 1;
        continue;
      }

      const suppressionReason = await this.checkSuppression(intent);
      if (suppressionReason) {
        intent.status = 'suppressed';
        intent.suppressedReason = suppressionReason;
        intent.updatedAt = Date.now();
        result.suppressed += 1;
        continue;
      }

      intent.attempts += 1;
      try {
        const ok = await this.sendPushNotification({
          userId: intent.recipient,
          title: intent.title,
          body: intent.body,
          data: intent.data,
        });
        if (ok) {
          intent.status = 'sent';
          intent.lastError = undefined;
          intent.updatedAt = Date.now();
          result.sent += 1;
        } else {
          intent.status = 'failed';
          intent.lastError = 'provider rejected delivery';
          intent.updatedAt = Date.now();
          result.failed += 1;
        }
      } catch (err) {
        intent.status = 'failed';
        intent.lastError = err instanceof Error ? err.message : String(err);
        intent.updatedAt = Date.now();
        result.failed += 1;
      }
    }

    return result;
  }

  /**
   * Returns a suppression reason if delivery should be skipped, otherwise null.
   */
  private async checkSuppression(intent: NotificationIntent): Promise<string | null> {
    if (!intent.recipient) {
      return 'missing recipient';
    }
    if (!this.preferencesService) {
      // No preferences service configured: default to allowing delivery.
      return null;
    }
    const prefs = await this.preferencesService.getPreferences(intent.recipient);
    if (!prefs) {
      return 'no preferences found';
    }
    if (prefs.optOuts && prefs.optOuts.includes(intent.channel)) {
      return `opted out of ${intent.channel}`;
    }
    if (intent.channel === 'push' && prefs.pushEnabled === false) {
      return 'push notifications disabled';
    }
    return null;
  }

  /** Read-only view of an intent, primarily for tests and operators. */
  getNotificationIntent(eventId: string, recipient: string, channel: NotificationChannel = 'push'): NotificationIntent | undefined {
    return this.outbox.get(buildIntentKey(eventId, recipient, channel));
  }

  /** Snapshot of all intents, primarily for tests and operators. */
  listNotificationIntents(): NotificationIntent[] {
    return Array.from(this.outbox.values());
  }

  async notifyMilestone(campaignId: string, campaignName: string, milestone: CampaignMilestone, userId?: string): Promise<void> {
    await this.sendPushNotification({
      userId,
      title: `Milestone Reached!`,
      body: `Sponsored campaign "${campaignName}" has reached a new milestone: ${milestone}`,
      data: { milestone, campaignId, campaignName }
    });
  }
}

export const pushNotificationService = new PushNotificationService();