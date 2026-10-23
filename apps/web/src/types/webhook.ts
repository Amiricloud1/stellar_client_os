export const CAMPAIGN_WEBHOOK_EVENTS = ["tree_verified", "batch_verified", "campaign_milestone_reached", "campaign_completed"] as const;
export type CampaignWebhookEvent = (typeof CAMPAIGN_WEBHOOK_EVENTS)[number];

/**
 * A durable webhook subscription record.
 *
 * Persistence contract:
 * - This record is the source of truth for webhook subscriptions and MUST be
 *   persisted in durable storage (not in-memory) so that it survives process
 *   restarts and redeploys.
 * - Writes are transactional: a subscription is created or updated atomically,
 *   and `updatedAt` is bumped on every successful mutation.
 * - `version` is a monotonically increasing optimistic-concurrency token. Writers
 *   MUST supply the version they read; a mismatch indicates a concurrent update
 *   and the write MUST be rejected (conflict) rather than silently overwritten.
 * - `idempotencyKey` makes creation idempotent: replaying a create with the same
 *   key MUST return the existing record instead of creating a duplicate.
 *
 * Migration implications for existing records:
 * - Records persisted before these fields existed lack `updatedAt`, `version`,
 *   and `idempotencyKey`. On read, backfill `updatedAt` from `createdAt`,
 *   default `version` to `1`, and treat a missing `idempotencyKey` as `null`.
 * - Backfilled records should be written back lazily (on next mutation) or via a
 *   one-time migration; either way the backfill MUST be idempotent.
 */
export interface WebhookSubscription {
  id: string;
  accountId: string; // Owning account; used to enforce cross-account isolation
  url: string;
  events: string[]; // e.g., ["stream.status_updated", "milestone.funds_released"] or ["*"]
  secret: string; // Used for HMAC-SHA256 signature
  createdAt: string; // ISO string; set once at creation
  updatedAt: string; // ISO string; bumped on every successful mutation
  version: number; // Optimistic-concurrency token; starts at 1
  idempotencyKey: string | null; // Client-supplied key for idempotent creation
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
  id: string; // Unique delivery ID (stable across retries of the same event)
  event: string; // Event name (e.g., 'stream.status_updated')
  timestamp: number; // Epoch timestamp (seconds) of delivery, included in signature
  payload: Record<string, unknown>; // Event details
}

/**
 * A durable record of a single webhook delivery attempt.
 *
 * Persistence contract:
 * - Delivery attempts are appended to durable storage so retry state and audit
 *   history survive process restarts.
 * - `id` is unique per attempt and serves as the idempotency key for recording
 *   the attempt; re-recording the same `id` MUST be a no-op.
 */
export interface WebhookDeliveryAttempt {
  id: string; // Unique delivery ID (stable across retries)
  subscriptionId: string;
  event: string;
  url: string;
  payload: Record<string, unknown>;
  timestamp: string; // ISO string
  signatureVersion: WebhookSignatureVersion;
  signatureTimestamp: number; // Epoch seconds used in the signature
  statusCode: number | null;
  success: boolean;
  errorMessage: string | null;
  attempt: number; // Retries count (1 for first try, 2, etc.)
}