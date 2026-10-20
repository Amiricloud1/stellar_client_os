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
  url: string;
  events: string[]; // e.g., ["stream.status_updated", "milestone.funds_released"] or ["*"]
  secret: string; // Used for HMAC-SHA256 signature
  createdAt: string; // ISO string; set once at creation
  updatedAt: string; // ISO string; bumped on every successful mutation
  version: number; // Optimistic-concurrency token; starts at 1
  idempotencyKey: string | null; // Client-supplied key for idempotent creation
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