/**
 * Bounded Soroban RPC Failover and Error Retry Classification.
 *
 * Provides multi-endpoint failover, exponential backoff with jitter,
 * and deterministic vs. transient error classification.
 */

import { parseContractError } from './errors.js';
import { assertSecureRpcUrl } from './rpcConnectionOptions.js';

export type ErrorClassification = 'transient' | 'deterministic' | 'unknown';

export interface RetryPolicy {
  /** Maximum number of retry attempts across all endpoints. Defaults to 3. */
  maxRetries?: number;
  /** Initial delay in ms before first retry. Defaults to 200ms. */
  initialBackoffMs?: number;
  /** Maximum delay in ms between retries. Defaults to 3000ms. */
  maxBackoffMs?: number;
  /** Backoff multiplier per failed attempt. Defaults to 2. */
  backoffMultiplier?: number;
  /** Enable randomized jitter to prevent thundering herd. Defaults to true. */
  jitter?: boolean;
  /** Cooldown in ms before a failing endpoint is retried. Defaults to 30,000ms. */
  endpointCooldownMs?: number;
}

/**
 * Configuration for a bounded, backpressure-aware work queue.
 *
 * The queue bounds in-flight memory by capping both the number of queued items
 * (`capacity`) and the number of concurrently executing items (`concurrency`).
 */
export interface BoundedQueueOptions {
  /** Maximum number of items that may be queued (not yet started). Defaults to 100. */
  capacity?: number;
  /** Maximum number of items executing concurrently. Defaults to 4. */
  concurrency?: number;
  /** Retry policy applied to individual queued tasks. Defaults to the client policy. */
  retryPolicy?: RetryPolicy;
  /**
   * Backpressure strategy when the queue is full.
   * - 'reject' (default): fail fast with a `QueueBackpressureError`.
   * - 'wait': await capacity, applying backpressure to the producer.
   */
  overflowStrategy?: 'reject' | 'wait';
  /** Maximum time in ms to wait for capacity under the 'wait' strategy. Defaults to 30,000ms. */
  maxWaitMs?: number;
}

export interface QueueMetrics {
  /** Current number of queued (not started) items. */
  queued: number;
  /** Current number of in-flight items. */
  inFlight: number;
  /** Configured capacity. */
  capacity: number;
  /** Configured concurrency. */
  concurrency: number;
  /** Total items enqueued since creation. */
  enqueued: number;
  /** Total items completed successfully. */
  completed: number;
  /** Total items that failed permanently. */
  failed: number;
  /** Total items rejected due to backpressure. */
  rejected: number;
  /** Total retry attempts performed. */
  retries: number;
  /** Peak observed queued depth (bounded memory proof). */
  peakQueued: number;
  /** Peak observed in-flight count. */
  peakInFlight: number;
}

export class QueueBackpressureError extends Error {
  readonly capacity: number;
  readonly queued: number;

  constructor(capacity: number, queued: number) {
    super(
      `Bounded queue is full (capacity=${capacity}, queued=${queued}); producer must apply backpressure`
    );
    this.name = 'QueueBackpressureError';
    this.capacity = capacity;
    this.queued = queued;
  }
}

export class QueueClosedError extends Error {
  constructor() {
    super('Bounded queue is closed and no longer accepts work');
    this.name = 'QueueClosedError';
  }
}

export interface RpcEndpointState {
  url: string;
  failures: number;
  consecutiveFailures: number;
  lastFailureAt?: number;
  healthy: boolean;
}

export class RpcFailoverError extends Error {
  readonly attempts: number;
  readonly errors: Error[];
  readonly classification: ErrorClassification;

  constructor(
    message: string,
    attempts: number,
    errors: Error[],
    classification: ErrorClassification = 'unknown'
  ) {
    super(message);
    this.name = 'RpcFailoverError';
    this.attempts = attempts;
    this.errors = errors;
    this.classification = classification;
  }
}

/**
 * Classifies an error as 'deterministic' (should not retry) or 'transient' (can retry).
 */
export function classifyRpcError(error: unknown): ErrorClassification {
  if (!error) {
    return 'unknown';
  }

  // 1. Check for Soroban contract errors (e.g. panic, invariant violation, auth failure)
  try {
    const parsed = parseContractError(error);
    if (parsed.type === 'contract_error') {
      return 'deterministic';
    }
  } catch {
    // ignore parser error
  }

  const errStr = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const status = extractHttpStatus(error);

  // 2. HTTP Status checks
  if (status !== null) {
    // 429: Rate limited -> transient
    // 500, 502, 503, 504: Gateway/server down -> transient
    if (status === 429 || status === 502 || status === 503 || status === 504 || status === 500) {
      return 'transient';
    }
    // 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found -> deterministic
    if (status >= 400 && status < 500) {
      return 'deterministic';
    }
  }

  // 3. Known transient network patterns
  const transientPatterns = [
    /network\s*error/i,
    /failed\s*to\s*fetch/i,
    /timeout/i,
    /timed\s*out/i,
    /etimedout/i,
    /econnreset/i,
    /econnrefused/i,
    /ehostunreach/i,
    /socket\s*hang\s*up/i,
    /rate\s*limit/i,
    /overloaded/i,
    /temporarily\s*unavailable/i,
    /503\s+service\s+unavailable/i,
    /504\s+gateway\s+timeout/i,
    /429\s+too\s+many\s+requests/i,
  ];

  for (const pattern of transientPatterns) {
    if (pattern.test(errStr)) {
      return 'transient';
    }
  }

  // 4. Known deterministic contract/auth patterns
  const deterministicPatterns = [
    /invalid\s*argument/i,
    /unauthorized/i,
    /bad\s*sequence/i,
    /tx_bad_seq/i,
    /tx_failed/i,
    /op_malformed/i,
    /contract_error/i,
    /simulation_error/i,
    /hosterror/i,
    /missing\s*signature/i,
  ];

  for (const pattern of deterministicPatterns) {
    if (pattern.test(errStr)) {
      return 'deterministic';
    }
  }

  return 'unknown';
}

function extractHttpStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && typeof (error as any).status === 'number') {
      return (error as any).status;
    }
    if ('statusCode' in error && typeof (error as any).statusCode === 'number') {
      return (error as any).statusCode;
    }
    if ('response' in error && typeof (error as any).response === 'object' && (error as any).response !== null) {
      const res = (error as any).response;
      if (typeof res.status === 'number') return res.status;
      if (typeof res.statusCode === 'number') return res.statusCode;
    }
  }

  const str = String(error);
  const match = str.match(/\b(429|500|502|503|504|400|401|403|404)\b/);
  return match ? parseInt(match[1], 10) : null;
}

export class RpcFailoverClient {
  private readonly endpoints: RpcEndpointState[];
  private readonly policy: Required<RetryPolicy>;
  private currentIndex: number = 0;

  constructor(endpoints: string[], policy?: RetryPolicy) {
    if (!endpoints || endpoints.length === 0) {
      throw new Error('RpcFailoverClient requires at least one endpoint');
    }

    endpoints.forEach(url => assertSecureRpcUrl(url));

    this.endpoints = endpoints.map(url => ({
      url,
      failures: 0,
      consecutiveFailures: 0,
      healthy: true,
    }));

    this.policy = {
      maxRetries: policy?.maxRetries ?? 3,
      initialBackoffMs: policy?.initialBackoffMs ?? 200,
      maxBackoffMs: policy?.maxBackoffMs ?? 3000,
      backoffMultiplier: policy?.backoffMultiplier ?? 2,
      jitter: policy?.jitter ?? true,
      endpointCooldownMs: policy?.endpointCooldownMs ?? 30_000,
    };
  }

  getEndpoints(): readonly RpcEndpointState[] {
    return this.endpoints;
  }

  /**
   * Creates a bounded queue whose tasks are executed through this failover
   * client. Event consumers should enqueue work here so that RPC outages apply
   * backpressure instead of unbounded memory growth.
   */
  createBoundedQueue(options: BoundedQueueOptions = {}): BoundedQueue {
    return new BoundedQueue({
      ...options,
      retryPolicy: options.retryPolicy ?? this.policy,
    });
  }

  /**
   * Executes an asynchronous RPC operation against the healthiest endpoint,
   * falling over to alternative endpoints on transient failure.
   */
  async execute<T>(
    operation: (endpointUrl: string) => Promise<T>,
    customMaxRetries?: number
  ): Promise<T> {
    const maxRetries = customMaxRetries ?? this.policy.maxRetries;
    const collectedErrors: Error[] = [];
    let attempt = 0;

    while (attempt <= maxRetries) {
      const endpoint = this.selectNextEndpoint();

      try {
        const result = await operation(endpoint.url);
        // On success, reset consecutive failures
        endpoint.consecutiveFailures = 0;
        endpoint.healthy = true;
        return result;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        collectedErrors.push(error);

        const classification = classifyRpcError(error);

        // Immediately throw deterministic contract or validation errors
        if (classification === 'deterministic') {
          throw error;
        }

        // Record failure against this endpoint
        endpoint.failures++;
        endpoint.consecutiveFailures++;
        endpoint.lastFailureAt = Date.now();
        if (endpoint.consecutiveFailures >= 2) {
          endpoint.healthy = false;
        }

        attempt++;
        if (attempt > maxRetries) {
          break;
        }

        // Calculate backoff
        const delay = this.calculateBackoff(attempt);
        await sleep(delay);
      }
    }

    throw new RpcFailoverError(
      `RPC operation failed after ${attempt} attempts across ${this.endpoints.length} endpoints. Last error: ${collectedErrors[collectedErrors.length - 1]?.message}`,
      attempt,
      collectedErrors,
      'transient'
    );
  }

  private selectNextEndpoint(): RpcEndpointState {
    const now = Date.now();

    // Check if any cooldowns have elapsed
    for (const ep of this.endpoints) {
      if (!ep.healthy && ep.lastFailureAt) {
        if (now - ep.lastFailureAt >= this.policy.endpointCooldownMs) {
          ep.healthy = true;
          ep.consecutiveFailures = 0;
        }
      }
    }

    // Try starting from currentIndex
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.currentIndex + i) % this.endpoints.length;
      if (this.endpoints[idx].healthy) {
        this.currentIndex = (idx + 1) % this.endpoints.length;
        return this.endpoints[idx];
      }
    }

    // If all unhealthy, fallback to least recently failed
    let oldestIndex = 0;
    let oldestTime = Infinity;
    for (let i = 0; i < this.endpoints.length; i++) {
      const time = this.endpoints[i].lastFailureAt ?? 0;
      if (time < oldestTime) {
        oldestTime = time;
        oldestIndex = i;
      }
    }

    this.currentIndex = (oldestIndex + 1) % this.endpoints.length;
    return this.endpoints[oldestIndex];
  }

  private calculateBackoff(attempt: number): number {
    const base = this.policy.initialBackoffMs * Math.pow(this.policy.backoffMultiplier, attempt - 1);
    const capped = Math.min(base, this.policy.maxBackoffMs);

    if (this.policy.jitter) {
      // Full jitter: between 0.5 * capped and capped
      return Math.floor(capped * (0.5 + Math.random() * 0.5));
    }

    return Math.floor(capped);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface QueueEntry<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  attempts: number;
}

/**
 * A bounded, concurrency-limited work queue with explicit backpressure.
 *
 * Memory is bounded by `capacity` (queued) + `concurrency` (in-flight). When the
 * queue is full, producers either receive a `QueueBackpressureError` ('reject')
 * or are suspended until capacity frees up ('wait'). Failed tasks are retried
 * with jittered exponential backoff, and metrics expose recovery throughput.
 */
export class BoundedQueue {
  private readonly capacity: number;
  private readonly concurrency: number;
  private readonly retryPolicy: Required<RetryPolicy>;
  private readonly overflowStrategy: 'reject' | 'wait';
  private readonly maxWaitMs: number;

  private readonly pending: QueueEntry<unknown>[] = [];
  private inFlight = 0;
  private closed = false;
  private waiters: Array<() => void> = [];

  private enqueued = 0;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private retries = 0;
  private peakQueued = 0;
  private peakInFlight = 0;

  constructor(options: BoundedQueueOptions = {}) {
    const capacity = options.capacity ?? 100;
    const concurrency = options.concurrency ?? 4;

    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('BoundedQueue capacity must be a positive integer');
    }
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error('BoundedQueue concurrency must be a positive integer');
    }

    this.capacity = capacity;
    this.concurrency = concurrency;
    this.overflowStrategy = options.overflowStrategy ?? 'reject';
    this.maxWaitMs = options.maxWaitMs ?? 30_000;
    this.retryPolicy = {
      maxRetries: options.retryPolicy?.maxRetries ?? 3,
      initialBackoffMs: options.retryPolicy?.initialBackoffMs ?? 200,
      maxBackoffMs: options.retryPolicy?.maxBackoffMs ?? 3000,
      backoffMultiplier: options.retryPolicy?.backoffMultiplier ?? 2,
      jitter: options.retryPolicy?.jitter ?? true,
      endpointCooldownMs: options.retryPolicy?.endpointCooldownMs ?? 30_000,
    };
  }

  getMetrics(): QueueMetrics {
    return {
      queued: this.pending.length,
      inFlight: this.inFlight,
      capacity: this.capacity,
      concurrency: this.concurrency,
      enqueued: this.enqueued,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
      retries: this.retries,
      peakQueued: this.peakQueued,
      peakInFlight: this.peakInFlight,
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True when the queue cannot accept more work without backpressure. */
  get isSaturated(): boolean {
    return this.pending.length >= this.capacity;
  }

  /**
   * Enqueues a task. Resolves with the task result once it executes (and any
   * retries succeed). Rejects with `QueueBackpressureError` when full under the
   * 'reject' strategy, or `QueueClosedError` after `close()`.
   */
  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new QueueClosedError();
    }

    if (this.isSaturated) {
      if (this.overflowStrategy === 'reject') {
        this.rejected++;
        throw new QueueBackpressureError(this.capacity, this.pending.length);
      }
      await this.waitForCapacity();
      if (this.closed) {
        throw new QueueClosedError();
      }
    }

    this.enqueued++;

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        task,
        resolve,
        reject,
        attempts: 0,
      };
      this.pending.push(entry as QueueEntry<unknown>);
      this.peakQueued = Math.max(this.peakQueued, this.pending.length);
      this.drain();
    });
  }

  /**
   * Stops accepting new work. Already-queued work continues to drain.
   */
  close(): void {
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) {
      wake();
    }
  }

  /**
   * Waits until all queued and in-flight work has settled. Useful for
   * deterministic shutdown and for tests proving recovery throughput.
   */
  async onIdle(): Promise<void> {
    while (this.pending.length > 0 || this.inFlight > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }

  private waitForCapacity(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== wake);
        this.rejected++;
        reject(new QueueBackpressureError(this.capacity, this.pending.length));
      }, this.maxWaitMs);

      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  private drain(): void {
    while (!this.closed && this.inFlight < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!;
      this.inFlight++;
      this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
      void this.runEntry(entry);
    }
  }

  private async runEntry<T>(entry: QueueEntry<T>): Promise<void> {
    try {
      const result = await entry.task();
      this.completed++;
      entry.resolve(result);
    } catch (err) {
      const classification = classifyRpcError(err);
      const canRetry =
        classification !== 'deterministic' && entry.attempts < this.retryPolicy.maxRetries;

      if (canRetry) {
        entry.attempts++;
        this.retries++;
        const delay = this.calculateBackoff(entry.attempts);
        await sleep(delay);
        // Re-queue at the front so retried work is prioritised.
        this.pending.unshift(entry as QueueEntry<unknown>);
        this.peakQueued = Math.max(this.peakQueued, this.pending.length);
      } else {
        this.failed++;
        entry.reject(err);
      }
    } finally {
      this.inFlight--;
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) {
        wake();
      }
      this.drain();
    }
  }

  private calculateBackoff(attempt: number): number {
    const base =
      this.retryPolicy.initialBackoffMs *
      Math.pow(this.retryPolicy.backoffMultiplier, attempt - 1);
    const capped = Math.min(base, this.retryPolicy.maxBackoffMs);

    if (this.retryPolicy.jitter) {
      return Math.floor(capped * (0.5 + Math.random() * 0.5));
    }
    return Math.floor(capped);
  }
}
