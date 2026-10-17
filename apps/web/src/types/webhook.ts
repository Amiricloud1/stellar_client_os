export const CAMPAIGN_WEBHOOK_EVENTS = ["tree_verified", "batch_verified", "campaign_milestone_reached", "campaign_completed"] as const;
export type CampaignWebhookEvent = (typeof CAMPAIGN_WEBHOOK_EVENTS)[number];

export interface WebhookSubscription {
  id: string;
  accountId: string; // Owning account; used to enforce cross-account isolation
  url: string;
  events: string[]; // e.g., ["stream.status_updated", "milestone.funds_released"] or ["*"]
  secret: string; // Used for HMAC-SHA256 signature
  createdAt: string;
}

/**
 * Public representation of a webhook subscription.
 * The `secret` is intentionally omitted; it is only revealed on creation or rotation.
 */
export type WebhookSubscriptionPublic = Omit<WebhookSubscription, "secret">;

/**
 * Returned only when a subscription is created. This is the sole point (besides
 * rotation) at which the signing secret is disclosed to the caller.
 */
export interface WebhookSubscriptionCreated extends WebhookSubscriptionPublic {
  secret: string;
}

/**
 * Result of rotating a subscription's signing secret. The new secret is disclosed
 * exactly once; subsequent reads of the subscription will not include it.
 */
export interface WebhookSecretRotationResult {
  subscriptionId: string;
  secret: string;
  rotatedAt: string; // ISO string
}

export interface WebhookPayload {
  id: string; // Unique delivery attempt UUID
  event: string; // Event name (e.g., 'stream.status_updated')
  timestamp: number; // Epoch timestamp of delivery
  payload: Record<string, unknown>; // Event details
}

export interface WebhookDeliveryAttempt {
  id: string; // Unique delivery ID
  subscriptionId: string;
  event: string;
  url: string;
  payload: Record<string, unknown>;
  timestamp: string; // ISO string
  statusCode: number | null;
  success: boolean;
  errorMessage: string | null;
  attempt: number; // Retries count (1 for first try, 2, etc.)
}