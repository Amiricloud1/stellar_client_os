export const CAMPAIGN_WEBHOOK_EVENTS = ["tree_verified", "batch_verified", "campaign_milestone_reached", "campaign_completed"] as const;
export type CampaignWebhookEvent = (typeof CAMPAIGN_WEBHOOK_EVENTS)[number];

/**
 * Version of the webhook signature scheme.
 *
 * - `v1`: HMAC-SHA256 over `${timestamp}.${rawBody}` using the subscription secret.
 *
 * The version is transmitted in the `X-Webhook-Signature` header (e.g. `v1=<hex>`)
 * so receivers can select the correct verification routine and so future
 * schemes can be rolled out without breaking existing consumers.
 */
export const WEBHOOK_SIGNATURE_VERSION = "v1" as const;
export type WebhookSignatureVersion = typeof WEBHOOK_SIGNATURE_VERSION;

/**
 * Maximum age (in seconds) of a signed delivery that receivers should accept.
 * Deliveries whose timestamp falls outside this window must be rejected to
 * prevent replay attacks. Receivers should also track delivery IDs to reject
 * duplicate deliveries within the window.
 */
export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

/**
 * Maximum number of delivery attempts (initial attempt + retries) before a
 * delivery is marked as permanently failed.
 */
export const WEBHOOK_MAX_DELIVERY_ATTEMPTS = 5;

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[]; // e.g., ["stream.status_updated", "milestone.funds_released"] or ["*"]
  /**
   * Primary secret used for HMAC-SHA256 signing.
   * During rotation this is the *new* secret once `secretRotatedAt` is set.
   */
  secret: string;
  /**
   * Optional secondary (previous) secret kept valid during a rotation grace
   * period. When present, deliveries are signed with `secret` but receivers
   * may still verify with `secondarySecret` until the grace period ends.
   */
  secondarySecret?: string | null;
  /**
   * ISO timestamp of the most recent secret rotation. Used to determine when
   * the `secondarySecret` grace period expires and to surface rotation
   * guidance to operators.
   */
  secretRotatedAt?: string | null;
  createdAt: string;
}

export interface WebhookPayload {
  id: string; // Unique delivery ID (stable across retries of the same event)
  event: string; // Event name (e.g., 'stream.status_updated')
  timestamp: number; // Epoch timestamp (seconds) of delivery, included in signature
  payload: Record<string, unknown>; // Event details
}

/**
 * Signature metadata attached to an outgoing delivery. Receivers verify the
 * signature using the raw request body and the `timestamp` value.
 */
export interface WebhookSignature {
  version: WebhookSignatureVersion;
  timestamp: number; // Epoch seconds used in the signed payload
  signature: string; // Hex-encoded HMAC-SHA256 digest
}

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