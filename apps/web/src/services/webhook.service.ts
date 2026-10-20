import fs from 'fs/promises';
import type { CampaignWebhookEvent } from "../types/webhook";
import path from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { WebhookSubscription, WebhookDeliveryAttempt, WebhookPayload } from '../types/webhook';
import {
  getActiveTrace,
  createChildContext,
  extractTraceContext,
  injectTraceHeaders,
  Span,
  sanitizeObject,
  sanitizeString,
  type TraceContext,
} from '@/lib/tracing';

/** Current signature scheme version. Included in the signed canonical string. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** Default replay window (ms) accepted by {@link verifyWebhookSignature}. */
export const DEFAULT_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Default bounded retry count for a single delivery. */
export const DEFAULT_WEBHOOK_MAX_RETRIES = 5;

/** Default base delay (ms) for exponential backoff. */
export const DEFAULT_WEBHOOK_BASE_DELAY_MS = 1000;

/** Maximum backoff delay (ms) so retries stay bounded even with large retry counts. */
export const MAX_WEBHOOK_BACKOFF_MS = 60 * 1000;

/**
 * Build the versioned canonical string that is signed.
 *
 * Format: `<version>.<timestamp>.<deliveryId>.<body>`
 *
 * Binding the delivery ID and timestamp into the signature prevents an
 * attacker from replaying a captured body under a different delivery or
 * timestamp, and the version prefix allows future schemes to coexist.
 */
export function buildWebhookSigningString(
  timestamp: number | string,
  deliveryId: string,
  body: string,
  version: string = WEBHOOK_SIGNATURE_VERSION,
): string {
  return `${version}.${timestamp}.${deliveryId}.${body}`;
}

/** Compute the hex HMAC-SHA256 signature for a delivery. */
export function signWebhookPayload(
  secret: string,
  timestamp: number | string,
  deliveryId: string,
  body: string,
  version: string = WEBHOOK_SIGNATURE_VERSION,
): string {
  return createHmac('sha256', secret)
    .update(buildWebhookSigningString(timestamp, deliveryId, body, version))
    .digest('hex');
}

export interface WebhookSignatureHeaders {
  'X-Webhook-Timestamp': string;
  'X-Webhook-Signature': string;
  'X-Webhook-Signature-Version': string;
  'X-Webhook-Delivery-Id': string;
}

export interface WebhookDeliveryMetadata {
  deliveryId: string;
  timestamp: number;
  signatureVersion: string;
}

export interface VerifyWebhookSignatureOptions {
  /** Raw request body exactly as received (string or Buffer). */
  body: string | Buffer;
  /** Value of the `X-Webhook-Timestamp` header. */
  timestamp: string | number;
  /** Value of the `X-Webhook-Delivery-Id` header. */
  deliveryId: string;
  /** Value of the `X-Webhook-Signature` header (hex). */
  signature: string;
  /** One or more accepted secrets (primary + secondary during rotation). */
  secrets: string | string[];
  /** Accepted signature version. Defaults to the current version. */
  version?: string;
  /** Replay window in ms. Defaults to 5 minutes. */
  replayWindowMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: number;
}

export interface VerifyWebhookSignatureResult {
  valid: boolean;
  reason?: 'missing_fields' | 'invalid_timestamp' | 'timestamp_out_of_window' | 'signature_mismatch';
}

/**
 * Verify a webhook signature and enforce a replay window.
 *
 * Accepts multiple secrets so a subscriber can rotate keys without downtime:
 * publish the new secret as secondary, switch the primary, then retire the old
 * one once in-flight deliveries have drained.
 */
export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): VerifyWebhookSignatureResult {
  const {
    body,
    timestamp,
    deliveryId,
    signature,
    secrets,
    version = WEBHOOK_SIGNATURE_VERSION,
    replayWindowMs = DEFAULT_WEBHOOK_REPLAY_WINDOW_MS,
    now = Date.now(),
  } = options;

  if (!signature || !deliveryId || timestamp === undefined || timestamp === null || timestamp === '') {
    return { valid: false, reason: 'missing_fields' };
  }

  const ts = typeof timestamp === 'number' ? timestamp : Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }

  if (Math.abs(now - ts) > replayWindowMs) {
    return { valid: false, reason: 'timestamp_out_of_window' };
  }

  const bodyStr = typeof body === 'string' ? body : body.toString('utf-8');
  const secretList = Array.isArray(secrets) ? secrets : [secrets];
  const provided = Buffer.from(signature, 'hex');

  for (const secret of secretList) {
    if (!secret) continue;
    const expected = Buffer.from(signWebhookPayload(secret, ts, deliveryId, bodyStr, version), 'hex');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'signature_mismatch' };
}

const IDEMPOTENCY_FIELDS = [
  'idempotencyKey',
  'idempotency_key',
  'eventId',
  'event_id',
  'notificationId',
  'notification_id',
  'verificationId',
  'verification_id',
  'campaignId',
  'campaign_id',
  'campaign',
  'nullifier',
  'txHash',
  'tx_hash',
  'transactionHash',
  'transaction_hash',
] as const;

/**
 * Return the caller-provided identity for an event, if one is available.
 *
 * A generated webhook delivery ID is deliberately not used here: it changes
 * every time the same source event is dispatched and therefore cannot prevent
 * duplicate notifications. Events without a stable identity retain the
 * existing at-least-once delivery behavior.
 */
export function getEventIdempotencyKey(
  event: string,
  eventData: Record<string, unknown>,
): string | null {
  for (const field of IDEMPOTENCY_FIELDS) {
    const value = eventData[field];
    if (typeof value === 'string' && value.length > 0) {
      return `${event}:${field}:${value}`;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return `${event}:${field}:${String(value)}`;
    }
  }

  return null;
}

export interface WebhookServiceOptions {
  maxRetries?: number;
  baseDelay?: number; // ms
  subscriptionsPath?: string;
  deadLetterPath?: string;
  /** Persistent store for successfully delivered event identities. */
  deduplicationPath?: string;
  /** Maximum backoff delay (ms). Defaults to {@link MAX_WEBHOOK_BACKOFF_MS}. */
  maxBackoff?: number;
  /** Replay window (ms) advertised to subscribers. Defaults to 5 minutes. */
  replayWindowMs?: number;
}

interface DedupeState {
  delivered: string[];
}

/**
 * Source-of-truth model
 * ---------------------
 * All webhook state is durable on disk and survives process restarts:
 *
 * - `subscriptionsPath`  -> `WebhookSubscription[]` (source of truth for who
 *   receives which events). Mutated only by `createSubscription` /
 *   `deleteSubscription`.
 * - `deadLetterPath`     -> `WebhookDeliveryAttempt[]` (append-only log of
 *   deliveries that exhausted all retries). This is the source of truth for
 *   permanently failed deliveries; it is never rewritten except to append.
 * - `deduplicationPath`  -> `DedupeState` (set of event identities that were
 *   successfully delivered). This is the source of truth for idempotency and
 *   is what prevents duplicate delivery after a restart.
 *
 * Transaction boundaries
 * ----------------------
 * Each file is written with `writeJsonAtomic` (write temp file + rename), so a
 * single file mutation is atomic: readers observe either the previous or the
 * new complete document, never a partial write. There is no cross-file
 * transaction; the guarantees are per-file:
 *
 * 1. Subscription mutations: read -> mutate -> atomic write. Concurrent
 *    mutations are serialized by the caller-facing API contract (one
 *    operation at a time per service instance).
 * 2. Idempotency: `reserveEvent` (in-flight reservation) and `completeEvent`
 *    (persist delivered key) are serialized through `withDeduplicationLock`.
 *    The delivered key is only persisted after a successful delivery, so a
 *    crash mid-delivery leaves the event un-deduplicated and it may be
 *    retried (at-least-once). A crash after persistence means the event is
 *    never delivered again (effectively-once for stable identities).
 * 3. Dead-letter append: read -> push -> atomic write. A failure to write the
 *    DLQ is logged but does not fail the dispatch (best-effort durability of
 *    the failure record).
 */
=======

export class WebhookService {
  private readonly maxRetries: number;
  private readonly baseDelay: number;
  private readonly maxBackoff: number;
  private readonly replayWindowMs: number;
  private readonly subscriptionsPath: string;
  private readonly deadLetterPath: string;
  private readonly deduplicationPath: string;
  private readonly pendingDeliveries: Set<Promise<unknown>> = new Set();
  private readonly inFlightEventKeys = new Set<string>();
  private readonly deliveredEventKeys = new Set<string>();
  private deduplicationLoaded = false;
  private deduplicationLock: Promise<void> = Promise.resolve();

  constructor(options: WebhookServiceOptions = {}) {
    this.maxRetries = Math.max(1, options.maxRetries ?? DEFAULT_WEBHOOK_MAX_RETRIES);
    this.baseDelay = options.baseDelay ?? DEFAULT_WEBHOOK_BASE_DELAY_MS;
    this.maxBackoff = options.maxBackoff ?? MAX_WEBHOOK_BACKOFF_MS;
    this.replayWindowMs = options.replayWindowMs ?? DEFAULT_WEBHOOK_REPLAY_WINDOW_MS;
    this.subscriptionsPath = options.subscriptionsPath ?? path.join(process.cwd(), 'data', 'webhook_subscriptions.json');
    this.deadLetterPath = options.deadLetterPath ?? path.join(process.cwd(), 'data', 'webhook_dead_letter.json');
    this.deduplicationPath = options.deduplicationPath ?? path.join(process.cwd(), 'data', 'webhook_delivered_events.json');
  }

  /** Replay window (ms) that subscribers should enforce. */
  getReplayWindowMs(): number {
    return this.replayWindowMs;
  }

  // ============================================
  // Storage Methods (Subscriptions)
  // ============================================

  /**
   * Helper to write JSON file atomically
   */
  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }
  }

  /**
   * Load all subscriptions from the file-based database.
   *
   * This is the durable source of truth for subscriptions; it is re-read on
   * every call so a fresh process observes state written by a previous one.
   */
  async getSubscriptions(): Promise<WebhookSubscription[]> {
    try {
      const data = await fs.readFile(this.subscriptionsPath, 'utf-8');
      const parsed = JSON.parse(data) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Webhook subscriptions store is corrupt: expected an array');
      }
      return parsed as WebhookSubscription[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      console.error('Failed to read webhook subscriptions:', err);
      throw err;
    }
  }

  /**
   * Register a new subscription
   */
  async createSubscription(url: string, events: string[], secret?: string): Promise<WebhookSubscription> {
    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid subscriber URL format');
    }

    if (!events || events.length === 0) {
      throw new Error('Subscription must specify at least one event type');
    }

    const subscriptions = await this.getSubscriptions();
    const newSubscription: WebhookSubscription = {
      id: 'sub_' + randomUUID().replace(/-/g, '').slice(0, 16),
      url,
      events,
      secret: secret || randomUUID().replace(/-/g, ''),
      createdAt: new Date().toISOString(),
    };

    subscriptions.push(newSubscription);
    await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
    return newSubscription;
  }

  /**
   * Delete subscription by ID
   */
  async deleteSubscription(id: string): Promise<boolean> {
    const subscriptions = await this.getSubscriptions();
    const index = subscriptions.findIndex((sub) => sub.id === id);
    if (index === -1) {
      return false;
    }

    subscriptions.splice(index, 1);
    await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
    return true;
  }

  // ============================================
  // Idempotency Methods
  // ============================================

  /** Serialize mutations to the persistent idempotency store. */
  private async withDeduplicationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.deduplicationLock;
    let release!: () => void;
    this.deduplicationLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadDeduplicationState(): Promise<void> {
    if (this.deduplicationLoaded) return;

    try {
      const data = await fs.readFile(this.deduplicationPath, 'utf-8');
      const state = JSON.parse(data) as DedupeState;
      if (Array.isArray(state.delivered)) {
        for (const key of state.delivered) {
          if (typeof key === 'string') this.deliveredEventKeys.add(key);
        }
      }
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }

    this.deduplicationLoaded = true;
  }

  /**
   * Force a reload of the persisted idempotency state from disk.
   *
   * Useful after an external writer (or a previous process) updated the
   * deduplication store. Serialized through the deduplication lock so it
   * cannot interleave with an in-flight reservation.
   */
  async reloadDeduplicationState(): Promise<void> {
    await this.withDeduplicationLock(async () => {
      this.deduplicationLoaded = false;
      this.deliveredEventKeys.clear();
      await this.loadDeduplicationState();
    });
  }

  private async persistDeduplicationState(): Promise<void> {
    const state: DedupeState = {
      delivered: Array.from(this.deliveredEventKeys),
    };
    await this.writeJsonAtomic(this.deduplicationPath, state);
  }

  /** Reserve an event identity so concurrent dispatches cannot deliver twice. */
  private async reserveEvent(eventKey: string | null): Promise<boolean> {
    if (!eventKey) return true;

    return this.withDeduplicationLock(async () => {
      await this.loadDeduplicationState();
      if (this.deliveredEventKeys.has(eventKey) || this.inFlightEventKeys.has(eventKey)) {
        return false;
      }
      this.inFlightEventKeys.add(eventKey);
      return true;
    });
  }

  private async completeEvent(eventKey: string | null, delivered: boolean): Promise<void> {
    if (!eventKey) return;

    await this.withDeduplicationLock(async () => {
      this.inFlightEventKeys.delete(eventKey);
      if (!delivered) return;

      this.deliveredEventKeys.add(eventKey);
      await this.persistDeduplicationState();
    });
  }

  // ============================================
  // Log / Dead-Letter Queue (DLQ) Methods
  // ============================================

  /**
   * Append a failed delivery attempt to the dead-letter log.
   *
   * Transaction boundary: read -> push -> atomic write. The DLQ is the durable
   * source of truth for permanently failed deliveries and is append-only.
   * Write failures are logged but swallowed so a DLQ outage cannot crash the
   * dispatcher; callers that need strict durability should inspect
   * `getDeadLetters()` after `awaitPendingDeliveries()`.
   */
  async logToDeadLetter(attempt: WebhookDeliveryAttempt): Promise<void> {
    try {
      let deadLetters: WebhookDeliveryAttempt[] = [];
      try {
        const data = await fs.readFile(this.deadLetterPath, 'utf-8');
        const parsed = JSON.parse(data) as unknown;
        if (Array.isArray(parsed)) {
          deadLetters = parsed as WebhookDeliveryAttempt[];
        } else {
          console.error('Dead-letter log is corrupt: expected an array; starting fresh');
        }
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== 'ENOENT') {
          console.error('Failed to read dead-letter log:', err);
        }
      }

      deadLetters.push(attempt);
      await this.writeJsonAtomic(this.deadLetterPath, deadLetters);
    } catch (err) {
      console.error('Critical failure writing to dead-letter log:', err);
    }
  }

  /**
   * Read all dead-letter deliveries.
   *
   * Re-reads from disk so a fresh process observes failures recorded by a
   * previous one.
   */
  async getDeadLetters(): Promise<WebhookDeliveryAttempt[]> {
    try {
      const data = await fs.readFile(this.deadLetterPath, 'utf-8');
      const parsed = JSON.parse(data) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Dead-letter log is corrupt: expected an array');
      }
      return parsed as WebhookDeliveryAttempt[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  // ============================================
  // Webhook Dispatcher Methods
  // ============================================

  /**
   * Wait for all pending deliveries (and scheduled retries) to complete
   */
  async awaitPendingDeliveries(): Promise<void> {
    while (this.pendingDeliveries.size > 0) {
      const promises = Array.from(this.pendingDeliveries);
      await Promise.all(promises);
    }
  }

  /**
   * Dispatch an event to all interested subscribers.
   *
   * Idempotency semantics: for each matching subscription, a stable source
   * identity (see `getEventIdempotencyKey`) is reserved before delivery and
   * persisted only after a successful delivery. This yields at-least-once
   * delivery for events without a stable identity and effectively-once
   * delivery for events with one, including across process restarts.
   */
  async dispatchEvent(
    event: string,
    eventData: Record<string, unknown>,
    traceContext?: TraceContext
  ): Promise<void> {
    const parentTrace = traceContext ?? getActiveTrace();
    const subscriptions = await this.getSubscriptions();
    const matchingSubs = subscriptions.filter(
      (sub) => sub.events.includes(event) || sub.events.includes('*')
    );

    for (const sub of matchingSubs) {
      // Dedupe per subscription: one subscriber must not suppress delivery to
      // another subscriber that is also listening for the same source event.
      const sourceKey = getEventIdempotencyKey(event, eventData);
      const eventKey = sourceKey ? `${sub.id}:${sourceKey}` : null;
      if (!(await this.reserveEvent(eventKey))) continue;

      const deliveryPromise = this.deliverWithRetry(sub, event, eventData, 1, parentTrace).then(
        (delivered) => this.completeEvent(eventKey, delivered),
        async () => {
          await this.completeEvent(eventKey, false);
        },
      );
      this.pendingDeliveries.add(deliveryPromise);
      deliveryPromise.finally(() => {
        this.pendingDeliveries.delete(deliveryPromise);
      });
    }
  }

  /**
   * Compute the bounded exponential backoff delay for a given attempt.
   * Attempt 1 -> baseDelay, attempt 2 -> 2*baseDelay, ... capped at maxBackoff.
   */
  private computeBackoffDelay(attemptNum: number): number {
    const exponential = this.baseDelay * Math.pow(2, attemptNum - 1);
    return Math.min(exponential, this.maxBackoff);
  }

  /**
   * Internal method to orchestrate delivery with backoff retries.
   *
   * A single delivery ID and timestamp are generated per logical delivery and
   * reused across retries so subscribers can deduplicate retried attempts.
   */
  private async deliverWithRetry(
    sub: WebhookSubscription,
    event: string,
    eventData: Record<string, unknown>,
    attemptNum = 1,
    delivery?: WebhookDeliveryMetadata,
  ): Promise<boolean> {
    const metadata: WebhookDeliveryMetadata = delivery ?? {
      deliveryId: 'del_' + randomUUID().replace(/-/g, ''),
      timestamp: Date.now(),
      signatureVersion: WEBHOOK_SIGNATURE_VERSION,
    };
    const { deliveryId, timestamp, signatureVersion } = metadata;

    // Trace context and span propagation
    const active = traceContext ?? getActiveTrace();
    const traceCtx = active ? createChildContext(active) : extractTraceContext({});
    const span = new Span(traceCtx, 'webhook.deliver', {
      'webhook.subscription_id': sub.id,
      'webhook.event': event,
      'webhook.attempt': attemptNum,
      'webhook.url': sub.url,
      'webhook.delivery_id': deliveryId,
    });

    const payload: WebhookPayload = {
      id: deliveryId,
      event,
      timestamp,
      payload: eventData,
    };

    const payloadStr = JSON.stringify(payload);
    const signature = signWebhookPayload(sub.secret, timestamp, deliveryId, payloadStr, signatureVersion);

    let success = false;
    let statusCode: number | null = null;
    let errorMessage: string | null = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s HTTP timeout

      const outgoingHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Webhook-Timestamp': timestamp.toString(),
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event,
        'X-Webhook-Delivery-Id': deliveryId,
      };
      injectTraceHeaders(traceCtx, outgoingHeaders);

      const response = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Timestamp': timestamp.toString(),
          'X-Webhook-Signature': signature,
          'X-Webhook-Signature-Version': signatureVersion,
          'X-Webhook-Event': event,
          'X-Webhook-Delivery-Id': deliveryId,
        },
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      statusCode = response.status;
      success = response.ok;

      if (!success) {
        errorMessage = `HTTP failure status: ${response.status}`;
      }
    } catch (err: unknown) {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    span.setAttribute('http.status_code', statusCode ?? 0);
    if (success) {
      span.end('ok');
    } else {
      if (errorMessage) span.setAttribute('error.message', sanitizeString(errorMessage));
      span.end('error');
    }

    const attemptRecord: WebhookDeliveryAttempt = {
      id: deliveryId,
      subscriptionId: sub.id,
      event,
      url: sub.url,
      payload: sanitizeObject(eventData),
      timestamp: new Date().toISOString(),
      statusCode,
      success,
      errorMessage: errorMessage ? sanitizeString(errorMessage) : null,
      attempt: attemptNum,
    };

    if (success) {
      console.log(sanitizeString(`[Webhook success] Event: ${event}, Sub: ${sub.id}, Url: ${sub.url}`));
      return true;
    }

    console.warn(
      sanitizeString(
        `[Webhook failure] Attempt ${attemptNum}/${this.maxRetries} to ${sub.url} failed. Error: ${errorMessage}`
      )
    );

    if (attemptNum < this.maxRetries) {
      const backoffDelay = this.computeBackoffDelay(attemptNum);

      const retryPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          this.deliverWithRetry(sub, event, eventData, attemptNum + 1, metadata).then(resolve, () => resolve(false));
        }, backoffDelay);
      });

      this.pendingDeliveries.add(retryPromise);
      retryPromise.finally(() => {
        this.pendingDeliveries.delete(retryPromise);
      });

      return retryPromise;
    } else {
      console.error(
        sanitizeString(
          `[Webhook dead-letter] All retries (${this.maxRetries}) exhausted for ${sub.url}. Writing to DLQ.`
        )
      );
      await this.logToDeadLetter(attemptRecord);
      return false;
    }
  }
}


/** Dispatch one of the campaign integration events through the signed delivery pipeline. */
export async function dispatchCampaignWebhook(
  event: CampaignWebhookEvent,
  payload: Record<string, unknown>,
  service = new WebhookService(),
): Promise<void> {
  if (!payload.eventId && !payload.verificationId && !payload.treeId && !payload.campaignId) {
    throw new Error("Campaign webhook payload must include a stable eventId, verificationId, treeId, or campaignId");
  }
  await service.dispatchEvent(event, payload);
}
