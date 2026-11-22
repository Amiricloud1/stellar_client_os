export type CampaignMilestoneType =
  | 'trees_planted'
  | 'verification_complete'
  | 'campaign_finished'
  | 'impact_achieved';

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export type DeviceType = 'mobile_ios' | 'mobile_android' | 'mobile_web' | 'unknown';

export interface CampaignPushSubscription {
  id: string;
  subscriberAddress: string;
  campaignId: string; // specific campaign ID or '*' for all sponsored campaigns
  endpoint: string;
  keys: PushSubscriptionKeys;
  deviceType: DeviceType;
  enabledMilestones: CampaignMilestoneType[];
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneNotificationPayload {
  campaignId: string;
  campaignTitle: string;
  milestone: CampaignMilestoneType;
  details: {
    treesPlanted?: number;
    targetTrees?: number;
    impactDescription?: string;
    verifierAddress?: string;
    completionTimestamp?: number;
    [key: string]: unknown;
  };
  deepLinkUrl?: string;
}

/**
 * Lifecycle state of a notification intent as it moves through the outbox.
 *
 * - `queued`: intent recorded from a domain event, awaiting delivery.
 * - `sent`: provider accepted the delivery.
 * - `suppressed`: delivery intentionally skipped (e.g. recipient opted out).
 * - `failed`: delivery attempted and failed; may be retried.
 */
export type NotificationDeliveryState = 'queued' | 'sent' | 'suppressed' | 'failed';

export type NotificationChannel = 'push' | 'email' | 'in_app';

/**
 * A durable record of a notification that should be delivered for a domain
 * event. Intents are written idempotently (keyed by `idempotencyKey`) so that
 * replayed domain events do not produce duplicate deliveries.
 */
export interface NotificationIntent {
  id: string;
  /** Stable key derived from the source event + recipient + channel. */
  idempotencyKey: string;
  /** Identifier of the originating domain event. */
  eventId: string;
  /** Recipient address (wallet address or other channel-specific identifier). */
  recipient: string;
  channel: NotificationChannel;
  /** Channel-specific payload to deliver. */
  payload: Record<string, unknown>;
  state: NotificationDeliveryState;
  /** Number of delivery attempts made so far. */
  attempts: number;
  /** Last error message observed, if any. */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  /** Timestamp of the most recent delivery attempt, if any. */
  lastAttemptAt?: string;
  /** Timestamp when the intent reached a terminal state (sent/suppressed), if any. */
  completedAt?: string;
}

export interface DeliveredPushNotification {
  id: string;
  /** Idempotency key of the originating intent, used to deduplicate replays. */
  idempotencyKey: string;
  /** Delivery state at the time this record was written. */
  state: NotificationDeliveryState;
  subscriptionId: string;
  subscriberAddress: string;
  campaignId: string;
  milestone: CampaignMilestoneType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sentAt: string;
  status: 'sent' | 'failed';
  errorMessage?: string;
}