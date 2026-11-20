/**
 * Helpers for safely configuring Stellar RPC / Horizon HTTP connections.
 *
 * Plain HTTP is only permitted for local loopback endpoints when the caller
 * explicitly opts in via `allowHttp: true`.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Hard upper bound on consumer queue capacity to keep memory bounded. */
export const MAX_QUEUE_CAPACITY = 100_000;
/** Hard upper bound on concurrent in-flight consumer requests. */
export const MAX_CONCURRENCY = 256;
/** Hard upper bound on retry attempts for a single consumer request. */
export const MAX_RETRY_ATTEMPTS = 10;
/** Hard upper bound on retry base delay (ms). */
export const MAX_RETRY_BASE_DELAY_MS = 60_000;
/** Hard upper bound on retry jitter ratio (fraction of the base delay). */
export const MAX_RETRY_JITTER_RATIO = 1;

export interface RpcConnectionOptions {
  /** Opt in to plain HTTP for local loopback RPC/Horizon URLs. Defaults to false. */
  allowHttp?: boolean;
  /** Maximum number of queued events before backpressure is applied. */
  queueCapacity?: number;
  /** Maximum number of concurrent in-flight consumer requests. */
  concurrency?: number;
  /** Retry policy applied to failed consumer requests. */
  retry?: RpcRetryOptions;
}

export interface RpcRetryOptions {
  /** Maximum retry attempts (0 disables retries). Defaults to 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds used for exponential backoff. Defaults to 250. */
  baseDelayMs?: number;
  /** Jitter ratio in [0, 1] applied to each backoff delay. Defaults to 0.2. */
  jitterRatio?: number;
}

export interface ResolvedRpcConsumerOptions {
  queueCapacity: number;
  concurrency: number;
  retry: Required<RpcRetryOptions>;
}

export const DEFAULT_QUEUE_CAPACITY = 1_000;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_RETRY_OPTIONS: Required<RpcRetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  jitterRatio: 0.2,
};

function assertIntegerInRange(
  name: string,
  value: unknown,
  min: number,
  max: number
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer. Got: ${String(value)}`);
  }
  if (value < min || value > max) {
    throw new Error(
      `${name} must be between ${min} and ${max} (inclusive). Got: ${value}`
    );
  }
}

function assertNumberInRange(
  name: string,
  value: unknown,
  min: number,
  max: number
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number. Got: ${String(value)}`);
  }
  if (value < min || value > max) {
    throw new Error(
      `${name} must be between ${min} and ${max} (inclusive). Got: ${value}`
    );
  }
}

/**
 * Validates and normalizes bounded queue/concurrency/retry consumer options.
 *
 * Rejects non-integer or out-of-range values so operators cannot silently
 * configure unbounded queues or unbounded concurrency.
 */
export function resolveRpcConsumerOptions(
  options: RpcConnectionOptions = {}
): ResolvedRpcConsumerOptions {
  const queueCapacity = options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const retry = options.retry ?? {};

  assertIntegerInRange('queueCapacity', queueCapacity, 1, MAX_QUEUE_CAPACITY);
  assertIntegerInRange('concurrency', concurrency, 1, MAX_CONCURRENCY);

  const maxAttempts = retry.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts;
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs;
  const jitterRatio = retry.jitterRatio ?? DEFAULT_RETRY_OPTIONS.jitterRatio;

  assertIntegerInRange('retry.maxAttempts', maxAttempts, 0, MAX_RETRY_ATTEMPTS);
  assertIntegerInRange(
    'retry.baseDelayMs',
    baseDelayMs,
    0,
    MAX_RETRY_BASE_DELAY_MS
  );
  assertNumberInRange('retry.jitterRatio', jitterRatio, 0, MAX_RETRY_JITTER_RATIO);

  return {
    queueCapacity,
    concurrency,
    retry: { maxAttempts, baseDelayMs, jitterRatio },
  };
}

/**
 * Computes the exponential backoff delay (with jitter) for a retry attempt.
 * `attempt` is 1-based; attempt 1 is the first retry after the initial failure.
 */
export function computeRetryDelayMs(
  attempt: number,
  retry: Required<RpcRetryOptions>,
  random: () => number = Math.random
): number {
  assertIntegerInRange('attempt', attempt, 1, MAX_RETRY_ATTEMPTS);
  const exponential = retry.baseDelayMs * 2 ** (attempt - 1);
  const jitter = exponential * retry.jitterRatio * random();
  return Math.min(MAX_RETRY_BASE_DELAY_MS, Math.round(exponential + jitter));
}

/**
 * Returns true when `url` uses plain HTTP against a local loopback host.
 */
export function isLoopbackHttpUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:') {
    return false;
  }

  return LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/**
 * Rejects non-loopback plain-HTTP URLs before any network client is created.
 */
export function assertSecureRpcUrl(url: string): void {
  if (url.startsWith('http://') && !isLoopbackHttpUrl(url)) {
    throw new Error(
      `Insecure RPC URL rejected: "${url}". Use https:// for remote hosts. ` +
        'Plain HTTP is only permitted for local development against ' +
        'http://localhost, http://127.0.0.1, or http://[::1] with allowHttp: true.'
    );
  }
}

/**
 * Resolves Stellar SDK `{ allowHttp }` server options from a URL and caller config.
 */
export function resolveRpcServerOptions(
  url: string,
  options: RpcConnectionOptions = {}
): { allowHttp: boolean } {
  assertSecureRpcUrl(url);
  // Validate consumer bounds eagerly so misconfiguration fails fast.
  resolveRpcConsumerOptions(options);

  const requestedAllowHttp = options.allowHttp ?? false;
  if (requestedAllowHttp) {
    if (!isLoopbackHttpUrl(url)) {
      throw new Error(
        'allowHttp: true is only permitted for loopback HTTP URLs ' +
          '(http://localhost, http://127.0.0.1, http://[::1]). ' +
          `Got: "${url}"`
      );
    }
    return { allowHttp: true };
  }

  if (isLoopbackHttpUrl(url)) {
    throw new Error(
      'Plain HTTP for loopback RPC URLs requires explicit allowHttp: true.'
    );
  }

  return { allowHttp: false };
}
