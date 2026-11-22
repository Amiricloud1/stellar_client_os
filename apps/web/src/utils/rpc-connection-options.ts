const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Bounded queue / concurrency limits for event consumers talking to the RPC.
 *
 * These limits apply backpressure to event producers when the RPC (or a
 * downstream consumer) is slow or unavailable, keeping memory bounded and
 * making failure/recovery states explicit to operators.
 *
 * Operational tuning notes:
 * - `maxQueueSize` bounds the number of buffered events. When the queue is
 *   full, new events are rejected (backpressure) rather than buffered
 *   unboundedly. Size this to roughly `maxConcurrency * expectedLatencyMs`
 *   divided by the per-event processing time, with headroom for bursts.
 * - `maxConcurrency` bounds in-flight RPC requests. Keep it below the RPC
 *   provider's per-key rate limit to avoid 429s during recovery.
 * - `retryBaseDelayMs` / `maxRetryDelayMs` control exponential backoff on
 *   transient RPC failures. Recovery throughput is `maxConcurrency` requests
 *   per `retryBaseDelayMs` window once the RPC recovers.
 * - `drainTimeoutMs` bounds how long shutdown waits for the queue to drain
 *   before surfacing an explicit failure state.
 */
export interface EventConsumerLimits {
  maxQueueSize: number;
  maxConcurrency: number;
  retryBaseDelayMs: number;
  maxRetryDelayMs: number;
  drainTimeoutMs: number;
}

export const DEFAULT_EVENT_CONSUMER_LIMITS: Readonly<EventConsumerLimits> = Object.freeze({
  maxQueueSize: 1000,
  maxConcurrency: 8,
  retryBaseDelayMs: 250,
  maxRetryDelayMs: 30_000,
  drainTimeoutMs: 10_000,
});

const LIMIT_BOUNDS: Record<keyof EventConsumerLimits, { min: number; max: number }> = {
  maxQueueSize: { min: 1, max: 100_000 },
  maxConcurrency: { min: 1, max: 256 },
  retryBaseDelayMs: { min: 10, max: 60_000 },
  maxRetryDelayMs: { min: 10, max: 600_000 },
  drainTimeoutMs: { min: 100, max: 300_000 },
};

export class EventConsumerLimitsError extends Error {
  constructor(
    public readonly field: keyof EventConsumerLimits,
    public readonly value: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'EventConsumerLimitsError';
  }
}

function assertIntegerInBounds(field: keyof EventConsumerLimits, value: unknown): number {
  const bounds = LIMIT_BOUNDS[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new EventConsumerLimitsError(
      field,
      value,
      `Event consumer limit "${field}" must be an integer, received ${String(value)}`,
    );
  }
  if (value < bounds.min || value > bounds.max) {
    throw new EventConsumerLimitsError(
      field,
      value,
      `Event consumer limit "${field}" must be between ${bounds.min} and ${bounds.max}, received ${value}`,
    );
  }
  return value;
}

/**
 * Validate and normalize event consumer limits.
 *
 * Throws {@link EventConsumerLimitsError} on invalid input so misconfiguration
 * fails fast at startup rather than silently degrading under load.
 */
export function resolveEventConsumerLimits(
  overrides: Partial<EventConsumerLimits> = {},
): EventConsumerLimits {
  const merged: EventConsumerLimits = { ...DEFAULT_EVENT_CONSUMER_LIMITS, ...overrides };

  const resolved: EventConsumerLimits = {
    maxQueueSize: assertIntegerInBounds('maxQueueSize', merged.maxQueueSize),
    maxConcurrency: assertIntegerInBounds('maxConcurrency', merged.maxConcurrency),
    retryBaseDelayMs: assertIntegerInBounds('retryBaseDelayMs', merged.retryBaseDelayMs),
    maxRetryDelayMs: assertIntegerInBounds('maxRetryDelayMs', merged.maxRetryDelayMs),
    drainTimeoutMs: assertIntegerInBounds('drainTimeoutMs', merged.drainTimeoutMs),
  };

  if (resolved.maxRetryDelayMs < resolved.retryBaseDelayMs) {
    throw new EventConsumerLimitsError(
      'maxRetryDelayMs',
      resolved.maxRetryDelayMs,
      `Event consumer limit "maxRetryDelayMs" (${resolved.maxRetryDelayMs}) must be >= "retryBaseDelayMs" (${resolved.retryBaseDelayMs})`,
    );
  }

  return resolved;
}

/**
 * Authorization check for applying event consumer limit overrides.
 *
 * Only operators with the `events:configure` scope may tune limits at runtime.
 * Returns `true` when the caller is authorized, `false` otherwise. Callers
 * should surface an explicit authorization failure to the user/operator.
 */
export function canConfigureEventConsumerLimits(scopes: readonly string[] | undefined | null): boolean {
  if (!scopes || scopes.length === 0) {
    return false;
  }
  return scopes.includes('events:configure');
}

/**
 * Apply event consumer limit overrides, enforcing authorization.
 *
 * Throws {@link EventConsumerLimitsError} when the caller is not authorized
 * or when the provided limits are invalid.
 */
export function applyEventConsumerLimits(
  scopes: readonly string[] | undefined | null,
  overrides: Partial<EventConsumerLimits> = {},
): EventConsumerLimits {
  if (!canConfigureEventConsumerLimits(scopes)) {
    throw new EventConsumerLimitsError(
      'maxQueueSize',
      undefined,
      'Not authorized to configure event consumer limits: missing "events:configure" scope',
    );
  }
  return resolveEventConsumerLimits(overrides);
}

/**
 * Stellar SDK server options for the web app.
 * Plain HTTP is only enabled in non-production builds against loopback hosts.
 */
export function getStellarServerOptions(url: string): { allowHttp: boolean } {
  const isDev = process.env.NODE_ENV !== 'production';
  return { allowHttp: isDev && isLoopbackHttpUrl(url) };
}

/**
 * Combined RPC connection options for the web app, including bounded
 * event consumer limits. Use this at the connection boundary so backpressure
 * configuration is validated once and shared by all consumers.
 */
export function getRpcConnectionOptions(
  url: string,
  limits: Partial<EventConsumerLimits> = {},
): { allowHttp: boolean; eventConsumerLimits: EventConsumerLimits } {
  return {
    ...getStellarServerOptions(url),
    eventConsumerLimits: resolveEventConsumerLimits(limits),
  };
}