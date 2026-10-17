import fs from 'fs/promises';
import type { CampaignWebhookEvent } from "../types/webhook";
import path from 'path';
import { createHmac, randomUUID } from 'crypto';
import type { WebhookSubscription, WebhookDeliveryAttempt, WebhookPayload } from '../types/webhook';

/**
 * Subscription representation safe to return from read operations.
 * The signing secret is intentionally omitted; it is only ever revealed once,
 * in the result of {@link WebhookService.createSubscription} or
 * {@link WebhookService.rotateSecret}.
 */
export type WebhookSubscriptionPublic = Omit<WebhookSubscription, 'secret'>;

/** Result of creating a subscription: the only time the secret is disclosed. */
export interface WebhookSubscriptionCreated extends WebhookSubscriptionPublic {
  secret: string;
}

/** Result of rotating a subscription secret. */
export interface WebhookSecretRotation {
  subscription: WebhookSubscriptionPublic;
  secret: string;
}

/** Thrown when a subscription does not exist or is not owned by the caller. */
export class WebhookSubscriptionNotFoundError extends Error {
  constructor(id: string) {
    super(`Webhook subscription not found: ${id}`);
    this.name = 'WebhookSubscriptionNotFoundError';
  }
}

function toPublicSubscription(sub: WebhookSubscription): WebhookSubscriptionPublic {
  const { secret: _secret, ...publicSub } = sub;
  return publicSub;
}

function generateSecret(): string {
  return randomUUID().replace(/-/g, '');
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
}

interface DedupeState {
  delivered: string[];
}

export class WebhookService {
  private readonly maxRetries: number;
  private readonly baseDelay: number;
  private readonly subscriptionsPath: string;
  private readonly deadLetterPath: string;
  private readonly deduplicationPath: string;
  private readonly pendingDeliveries: Set<Promise<unknown>> = new Set();
  private readonly inFlightEventKeys = new Set<string>();
  private readonly deliveredEventKeys = new Set<string>();
  private deduplicationLoaded = false;
  private deduplicationLock: Promise<void> = Promise.resolve();

  constructor(options: WebhookServiceOptions = {}) {
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelay = options.baseDelay ?? 1000;
    this.subscriptionsPath = options.subscriptionsPath ?? path.join(process.cwd(), 'data', 'webhook_subscriptions.json');
    this.deadLetterPath = options.deadLetterPath ?? path.join(process.cwd(), 'data', 'webhook_dead_letter.json');
    this.deduplicationPath = options.deduplicationPath ?? path.join(process.cwd(), 'data', 'webhook_delivered_events.json');
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
   * Load all subscriptions from the file-based database
   */
  async getSubscriptions(): Promise<WebhookSubscription[]> {
    try {
      const data = await fs.readFile(this.subscriptionsPath, 'utf-8');
      return JSON.parse(data) as WebhookSubscription[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      console.error('Failed to read webhook subscriptions:', err);
      throw err;
    }
  }

  /**
   * Register a new subscription owned by `accountId`.
   *
   * The returned object is the only place the signing secret is disclosed.
   * Subsequent reads return {@link WebhookSubscriptionPublic} without it.
   */
  async createSubscription(
    accountId: string,
    url: string,
    events: string[],
    secret?: string,
  ): Promise<WebhookSubscriptionCreated> {
    if (!accountId) {
      throw new Error('Subscription must be associated with an account');
    }

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
      accountId,
      url,
      events,
      secret: secret || generateSecret(),
      createdAt: new Date().toISOString(),
    };

    subscriptions.push(newSubscription);
    await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
    return { ...toPublicSubscription(newSubscription), secret: newSubscription.secret };
  }

  /**
   * List subscriptions owned by `accountId`. Secrets are never included.
   */
  async getSubscriptions(accountId: string): Promise<WebhookSubscriptionPublic[]> {
    const subscriptions = await this.readAllSubscriptions();
    return subscriptions
      .filter((sub) => sub.accountId === accountId)
      .map(toPublicSubscription);
  }

  /**
   * Fetch a single subscription owned by `accountId`. Secrets are never included.
   * Throws {@link WebhookSubscriptionNotFoundError} for unknown or foreign IDs so
   * cross-account probes cannot distinguish "missing" from "not yours".
   */
  async getSubscription(accountId: string, id: string): Promise<WebhookSubscriptionPublic> {
    const sub = await this.findOwnedSubscription(accountId, id);
    return toPublicSubscription(sub);
  }

  /**
   * Delete a subscription owned by `accountId`.
   * Returns false when the subscription does not exist or belongs to another account.
   */
  async deleteSubscription(accountId: string, id: string): Promise<boolean> {
    const subscriptions = await this.readAllSubscriptions();
    const index = subscriptions.findIndex(
      (sub) => sub.id === id && sub.accountId === accountId,
    );
    if (index === -1) {
      return false;
    }

    subscriptions.splice(index, 1);
    await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);
    return true;
  }

  /**
   * Revoke a subscription owned by `accountId`.
   *
   * Revocation is a hard delete: the subscription stops receiving deliveries and
   * its secret can no longer be used. Throws {@link WebhookSubscriptionNotFoundError}
   * when the subscription is unknown or owned by another account.
   */
  async revokeSubscription(accountId: string, id: string): Promise<void> {
    const deleted = await this.deleteSubscription(accountId, id);
    if (!deleted) {
      throw new WebhookSubscriptionNotFoundError(id);
    }
  }

  /**
   * Rotate the signing secret for a subscription owned by `accountId`.
   *
   * The previous secret is invalidated immediately: deliveries are signed with
   * the new secret from the next dispatch onward. The new secret is returned
   * exactly once. Throws {@link WebhookSubscriptionNotFoundError} on cross-account
   * access.
   */
  async rotateSecret(accountId: string, id: string): Promise<WebhookSecretRotation> {
    const subscriptions = await this.readAllSubscriptions();
    const index = subscriptions.findIndex(
      (sub) => sub.id === id && sub.accountId === accountId,
    );
    if (index === -1) {
      throw new WebhookSubscriptionNotFoundError(id);
    }

    const rotated: WebhookSubscription = {
      ...subscriptions[index],
      secret: generateSecret(),
      secretRotatedAt: new Date().toISOString(),
    };
    subscriptions[index] = rotated;
    await this.writeJsonAtomic(this.subscriptionsPath, subscriptions);

    return { subscription: toPublicSubscription(rotated), secret: rotated.secret };
  }

  /** Read the raw subscription records (including secrets) from storage. */
  private async readAllSubscriptions(): Promise<WebhookSubscription[]> {
    try {
      const data = await fs.readFile(this.subscriptionsPath, 'utf-8');
      return JSON.parse(data) as WebhookSubscription[];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return [];
      }
      console.error('Failed to read webhook subscriptions:', err);
      throw err;
    }
  }

  /** Resolve a subscription only when it is owned by `accountId`. */
  private async findOwnedSubscription(
    accountId: string,
    id: string,
  ): Promise<WebhookSubscription> {
    const subscriptions = await this.readAllSubscriptions();
    const sub = subscriptions.find(
      (candidate) => candidate.id === id && candidate.accountId === accountId,
    );
    if (!sub) {
      throw new WebhookSubscriptionNotFoundError(id);
    }
    return sub;
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
   * Append a failed delivery attempt to the dead-letter log
   */
  async logToDeadLetter(attempt: WebhookDeliveryAttempt): Promise<void> {
    try {
      let deadLetters: WebhookDeliveryAttempt[] = [];
      try {
        const data = await fs.readFile(this.deadLetterPath, 'utf-8');
        deadLetters = JSON.parse(data) as WebhookDeliveryAttempt[];
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
   * Read all dead-letter deliveries
   */
  async getDeadLetters(): Promise<WebhookDeliveryAttempt[]> {
    try {
      const data = await fs.readFile(this.deadLetterPath, 'utf-8');
      return JSON.parse(data) as WebhookDeliveryAttempt[];
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
   * Dispatch an event to all interested subscribers
   */
  async dispatchEvent(event: string, eventData: Record<string, unknown>): Promise<void> {
    const subscriptions = await this.readAllSubscriptions();
    const matchingSubs = subscriptions.filter(
      (sub) => sub.events.includes(event) || sub.events.includes('*')
    );

    for (const sub of matchingSubs) {
      // Dedupe per subscription: one subscriber must not suppress delivery to
      // another subscriber that is also listening for the same source event.
      const sourceKey = getEventIdempotencyKey(event, eventData);
      const eventKey = sourceKey ? `${sub.id}:${sourceKey}` : null;
      if (!(await this.reserveEvent(eventKey))) continue;

      const deliveryPromise = this.deliverWithRetry(sub, event, eventData).then(
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
   * Internal method to orchestrate delivery with backoff retries
   */
  private async deliverWithRetry(
    sub: WebhookSubscription,
    event: string,
    eventData: Record<string, unknown>,
    attemptNum = 1
  ): Promise<boolean> {
    const deliveryId = 'del_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const timestamp = Date.now();

    const payload: WebhookPayload = {
      id: deliveryId,
      event,
      timestamp,
      payload: eventData,
    };

    const payloadStr = JSON.stringify(payload);
    const hmac = createHmac('sha256', sub.secret);
    const signature = hmac.update(`${timestamp}.${payloadStr}`).digest('hex');

    let success = false;
    let statusCode: number | null = null;
    let errorMessage: string | null = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s HTTP timeout

      const response = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Timestamp': timestamp.toString(),
          'X-Webhook-Signature': signature,
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

    const attemptRecord: WebhookDeliveryAttempt = {
      id: deliveryId,
      subscriptionId: sub.id,
      event,
      url: sub.url,
      payload: eventData,
      timestamp: new Date().toISOString(),
      statusCode,
      success,
      errorMessage,
      attempt: attemptNum,
    };

    if (success) {
      console.log(`[Webhook success] Event: ${event}, Sub: ${sub.id}, Url: ${sub.url}`);
      return true;
    }

    console.warn(
      `[Webhook failure] Attempt ${attemptNum}/${this.maxRetries} to ${sub.url} failed. Error: ${errorMessage}`
    );

    if (attemptNum < this.maxRetries) {
      const backoffDelay = this.baseDelay * Math.pow(2, attemptNum - 1);
      
      const retryPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          this.deliverWithRetry(sub, event, eventData, attemptNum + 1).then(resolve, () => resolve(false));
        }, backoffDelay);
      });

      this.pendingDeliveries.add(retryPromise);
      retryPromise.finally(() => {
        this.pendingDeliveries.delete(retryPromise);
      });
      
      return retryPromise;
    } else {
      console.error(
        `[Webhook dead-letter] All retries (${this.maxRetries}) exhausted for ${sub.url}. Writing to DLQ.`
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
