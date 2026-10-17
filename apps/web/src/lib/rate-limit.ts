/**
 * Sliding-window rate limiter — issue #534
 *
 * Uses a Redis sorted-set per key to implement a precise sliding-window
 * counter. Each request adds a timestamped member; members older than the
 * window are pruned atomically via a Lua script.
 *
 * # Why sliding window vs fixed window?
 * Fixed windows allow up to 2× the stated limit at window boundaries.
 * Sliding windows give a uniform guarantee: at most `limit` requests
 * in any rolling `windowMs` period.
 *
 * # Atomic execution
 * The Lua script runs as a single Redis command — no TOCTOU races even
 * under high concurrency across multiple app instances.
 *
 * # Graceful degradation
 * When Redis is unavailable `check()` returns `allowed: true` so the app
 * keeps serving requests rather than entering a hard-fail state.
 *
 * # Storage
 * Each key holds a sorted set where score = timestamp (ms).
 * TTL is set to `ceil(windowMs / 1000) + 1` seconds so keys auto-expire.
 *
 * @module rate-limit
 */

import type { RedisClient } from "./redis";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RateLimitTier = "free" | "tier1" | "tier2" | "enterprise";

export interface TierConfig {
  id: RateLimitTier;
  name: string;
  dailyLimit: number;
  monthlyPriceUsd: number;
  burstLimitPerMin: number;
  description: string;
  hourlyLimit?: number;
  windowMs?: number;
}

export type CampaignApiTier = "basic" | "pro" | "enterprise";
export interface CampaignApiTierConfig {
  id: CampaignApiTier;
  hourlyLimit: number;
  windowMs: number;
  description: string;
}

export const CAMPAIGN_API_RATE_LIMIT_TIERS: Record<CampaignApiTier, CampaignApiTierConfig> = {
  basic: {
    id: "basic",
    hourlyLimit: 100,
    windowMs: 3_600_000,
    description: "Basic campaign tier (<$10,000 funding): 100 req/hr",
  },
  pro: {
    id: "pro",
    hourlyLimit: 1_000,
    windowMs: 3_600_000,
    description: "Pro campaign tier ($10,000 - $50,000 funding): 1,000 req/hr",
  },
  enterprise: {
    id: "enterprise",
    hourlyLimit: 10_000,
    windowMs: 3_600_000,
    description: "Enterprise campaign tier (>$50,000 funding): 10,000 req/hr",
  },
};

/**
 * Resolves the campaign API rate limit tier based on campaign funding size (USD/XLM equivalent).
 * - basic: < 10,000 USD (100 req/hr)
 * - pro: 10,000 - 50,000 USD (1,000 req/hr)
 * - enterprise: > 50,000 USD (10,000 req/hr)
 */
export function resolveCampaignApiTierByFunding(fundingAmountUsd: number): CampaignApiTierConfig {
  if (fundingAmountUsd >= 50_000) return CAMPAIGN_API_RATE_LIMIT_TIERS.enterprise;
  if (fundingAmountUsd >= 10_000) return CAMPAIGN_API_RATE_LIMIT_TIERS.pro;
  return CAMPAIGN_API_RATE_LIMIT_TIERS.basic;
}

export function resolveCampaignApiTier(
  identifierOrKey?: string | null,
  fundingAmount?: number | null
): CampaignApiTierConfig {
  if (fundingAmount !== undefined && fundingAmount !== null && !isNaN(fundingAmount)) {
    return resolveCampaignApiTierByFunding(fundingAmount);
  }
  if (!identifierOrKey) return CAMPAIGN_API_RATE_LIMIT_TIERS.basic;
  const lower = identifierOrKey.toLowerCase();
  if (lower === "enterprise" || lower.startsWith("pk_live_enterprise_") || lower.startsWith("enterprise_")) {
    return CAMPAIGN_API_RATE_LIMIT_TIERS.enterprise;
  }
  if (lower === "pro" || lower.startsWith("pk_live_pro_") || lower.startsWith("pro_")) {
    return CAMPAIGN_API_RATE_LIMIT_TIERS.pro;
  }
  if (lower === "basic" || lower.startsWith("pk_live_basic_") || lower.startsWith("basic_")) {
    return CAMPAIGN_API_RATE_LIMIT_TIERS.basic;
  }
  return CAMPAIGN_API_RATE_LIMIT_TIERS.basic;
}

export const RATE_LIMIT_TIERS: Record<RateLimitTier, TierConfig> = {
  free: {
    id: "free",
    name: "Free Tier",
    dailyLimit: 100,
    monthlyPriceUsd: 0,
    burstLimitPerMin: 10,
    description: "100 req/day ($0/mo) - Ideal for development and casual testing",
  },
  tier1: {
    id: "tier1",
    name: "Paid Tier 1",
    dailyLimit: 1000,
    monthlyPriceUsd: 10,
    burstLimitPerMin: 60,
    description: "1,000 req/day ($10/mo) - Designed for production dApps and community bots",
  },
  tier2: {
    id: "tier2",
    name: "Paid Tier 2",
    dailyLimit: 10000,
    monthlyPriceUsd: 50,
    burstLimitPerMin: 300,
    description: "10,000 req/day ($50/mo) - High volume data indexing, analytics, and enterprise integrations",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise Tier",
    dailyLimit: 100000,
    monthlyPriceUsd: 250,
    burstLimitPerMin: 1000,
    description: "Custom / Unlimited high-throughput dedicated capacity",
  },
};

/** Get TierConfig by tier identifier with fallback to free tier */
export function getTierConfig(tier?: string | null): TierConfig {
  if (tier && tier in RATE_LIMIT_TIERS) {
    return RATE_LIMIT_TIERS[tier as RateLimitTier];
  }
  return RATE_LIMIT_TIERS.free;
}

/** Resolve appropriate rate limit tier from an API key or header */
export function resolveTier(apiKey?: string | null): TierConfig {
  if (!apiKey) return RATE_LIMIT_TIERS.free;
  if (apiKey.startsWith("pk_live_t2_") || apiKey.startsWith("tier2_")) {
    return RATE_LIMIT_TIERS.tier2;
  }
  if (apiKey.startsWith("pk_live_t1_") || apiKey.startsWith("tier1_") || apiKey.startsWith("pk_live_")) {
    return RATE_LIMIT_TIERS.tier1;
  }
  return RATE_LIMIT_TIERS.free;
}

export type RateLimitFailurePolicy = "fail-open" | "fail-closed" | "fallback-memory";

export type RouteSensitivityClass =
  | "public-read"
  | "standard-write"
  | "sensitive-mutation"
  | "financial-submission"
  | "admin-privileged";

export interface RouteClassPolicyConfig {
  routeClass: RouteSensitivityClass;
  failurePolicy: RateLimitFailurePolicy;
  defaultLimit: number;
  defaultWindowMs: number;
  keyPrefix: string;
  description: string;
}

export const ROUTE_CLASS_POLICIES: Record<RouteSensitivityClass, RouteClassPolicyConfig> = {
  "public-read": {
    routeClass: "public-read",
    failurePolicy: "fail-open",
    defaultLimit: 60,
    defaultWindowMs: 60_000,
    keyPrefix: "rl:read",
    description: "Public read endpoints — fail-open during Redis outages to preserve read availability",
  },
  "standard-write": {
    routeClass: "standard-write",
    failurePolicy: "fallback-memory",
    defaultLimit: 30,
    defaultWindowMs: 60_000,
    keyPrefix: "rl:write",
    description: "Standard write/creation endpoints — falls back to bounded in-memory atomic counters on Redis outage",
  },
  "sensitive-mutation": {
    routeClass: "sensitive-mutation",
    failurePolicy: "fail-closed",
    defaultLimit: 15,
    defaultWindowMs: 60_000,
    keyPrefix: "rl:mutation",
    description: "Sensitive state mutations (webhooks, grants, verifications) — fail-closed on Redis outage",
  },
  "financial-submission": {
    routeClass: "financial-submission",
    failurePolicy: "fail-closed",
    defaultLimit: 10,
    defaultWindowMs: 60_000,
    keyPrefix: "rl:submit",
    description: "Financial/payment submission and tax generation routes — fail-closed on Redis outage",
  },
  "admin-privileged": {
    routeClass: "admin-privileged",
    failurePolicy: "fail-closed",
    defaultLimit: 10,
    defaultWindowMs: 60_000,
    keyPrefix: "rl:admin",
    description: "Privileged administrative operations — fail-closed on Redis outage",
  },
};

export function resolveRouteClassPolicy(routeClass: RouteSensitivityClass): RouteClassPolicyConfig {
  return ROUTE_CLASS_POLICIES[routeClass] ?? ROUTE_CLASS_POLICIES["public-read"];
}

export interface RateLimitOptions {
  /** Max requests allowed within `windowMs`. */
  limit: number;
  /** Rolling window size in milliseconds. Default: 60 000 (1 min). */
  windowMs?: number;
  /**
   * Key prefix prepended before the identifier.
   * Useful for scoping different endpoints: "rl:stream", "rl:submit", etc.
   */
  keyPrefix?: string;
  /**
   * Route sensitivity classification that determines default Redis outage behavior.
   */
  routeClass?: RouteSensitivityClass;
  /**
   * Explicit Redis outage policy override ("fail-open" | "fail-closed" | "fallback-memory").
   * Defaults to the policy of `routeClass` if specified, or `"fail-open"` otherwise.
   */
  failurePolicy?: RateLimitFailurePolicy;
  /**
   * Optional shared or per-instance atomic fallback store for `"fallback-memory"` mode.
   */
  fallbackStore?: SharedAtomicCounterStore;
}

export type RateLimitDecisionReason =
  | "OK"
  | "RATE_LIMIT_EXCEEDED"
  | "REDIS_UNAVAILABLE_FAIL_OPEN"
  | "REDIS_UNAVAILABLE_FAIL_CLOSED"
  | "REDIS_UNAVAILABLE_FALLBACK_MEMORY";

export interface RateLimitResult {
  /** Whether this request is allowed through. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Total limit for the window. */
  limit: number;
  /** Unix timestamp (ms) when the oldest request in the window expires. */
  resetAt: number;
  /** How many requests have been made in the current window. */
  count: number;
  /** Rate limit tier applied (optional). */
  tier?: RateLimitTier;
  /** True when Redis was unreachable or errored and fail-safe logic was triggered. */
  degraded?: boolean;
  /** Effective failure policy applied to this check. */
  failurePolicy?: RateLimitFailurePolicy;
  /** Route sensitivity class when configured. */
  routeClass?: RouteSensitivityClass;
  /** Machine-readable decision reason. */
  reason?: RateLimitDecisionReason;
}

// ── Shared Atomic Counter Store (Multi-Instance & Emergency Fallback) ─────────

interface WindowEntry {
  score: number;
  member: string;
}

/**
 * Deterministic atomic sliding-window counter store.
 *
 * Uses a monotonic sequence counter (`seq`) per key alongside a sorted window
 * list, mirroring the Redis Lua script semantics without `math.random` collisions.
 * Can be shared across multiple `RateLimiter` instances in tests to verify
 * multi-instance coordination, or used per-instance as a bounded emergency
 * fallback during Redis outages (`failurePolicy: "fallback-memory"`).
 */
export class SharedAtomicCounterStore {
  private readonly windows = new Map<string, WindowEntry[]>();
  private readonly sequences = new Map<string, number>();
  private readonly expiries = new Map<string, number>();
  private readonly maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /**
   * Atomically prune expired entries, increment the shared sequence counter,
   * record the request if within `limit`, and return `[count, oldestScore]`.
   */
  evaluate(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    ttlSeconds: number
  ): [number, number] {
    this.evictExpiredKeys(now);

    const cutoff = now - windowMs;
    const existing = this.windows.get(key) ?? [];
    const active = existing.filter((entry) => entry.score > cutoff);

    const nextSeq = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, nextSeq);

    const countBefore = active.length;
    const count = countBefore + 1;

    if (countBefore < limit) {
      active.push({ score: now, member: `${now}:${nextSeq}` });
    }

    this.windows.set(key, active);
    this.expiries.set(key, now + ttlSeconds * 1_000);

    const oldestScore = active.length > 0 ? active[0].score : 0;
    return [count, oldestScore];
  }

  /**
   * Create a Redis-compatible client interface backed by this shared atomic store.
   * Multiple `RateLimiter` instances given clients from the same store share
   * atomic counters identically to multiple app instances connected to Redis.
   */
  asRedisClient(): RedisClient {
    const evalFn = async (
      _script: string | Buffer,
      _numKeys: number | string,
      key: string,
      nowStr: string,
      windowMsStr: string,
      limitStr: string,
      ttlSecsStr: string
    ): Promise<[number, number]> => {
      return this.evaluate(
        String(key),
        Number(nowStr),
        Number(windowMsStr),
        Number(limitStr),
        Number(ttlSecsStr)
      );
    };

    return {
      eval: evalFn,
      quit: async () => "OK",
    } as unknown as RedisClient;
  }

  clear(): void {
    this.windows.clear();
    this.sequences.clear();
    this.expiries.clear();
  }

  private evictExpiredKeys(now: number): void {
    for (const [key, expiresAt] of this.expiries.entries()) {
      if (expiresAt <= now) {
        this.windows.delete(key);
        this.sequences.delete(key);
        this.expiries.delete(key);
      }
    }
    while (this.windows.size >= this.maxKeys) {
      const oldestKey = this.windows.keys().next().value;
      if (!oldestKey) break;
      this.windows.delete(oldestKey);
      this.sequences.delete(oldestKey);
      this.expiries.delete(oldestKey);
    }
  }
}

// ── Lua script ────────────────────────────────────────────────────────────────

/**
 * Atomic sliding-window Lua script with shared monotonic sequence counter.
 *
 * KEYS[1] — sorted-set key (e.g. "rl:stream:127.0.0.1")
 * ARGV[1] — current timestamp in ms (string)
 * ARGV[2] — window size in ms
 * ARGV[3] — request limit
 * ARGV[4] — TTL for the key in seconds
 *
 * Uses a companion atomic counter (`KEYS[1] .. ":seq"`) via `INCR` instead of
 * `math.random` so concurrent requests across multiple app instances within the
 * same millisecond never collide on sorted-set member names. Only admits new
 * members when `count < limit` so blocked DoS traffic cannot infinitely expand
 * the sorted set or perpetually extend the sliding window.
 *
 * Returns: { count, oldest_score }  as a two-element array
 *   count        — number of requests in the window including this attempt
 *   oldest_score — score (ms) of the oldest entry still in the window
 *                  (0 when the set is empty)
 */
export const SLIDING_WINDOW_SCRIPT = `
local key        = KEYS[1]
local seq_key    = key .. ':seq'
local now        = tonumber(ARGV[1])
local window_ms  = tonumber(ARGV[2])
local limit      = tonumber(ARGV[3])
local ttl_secs   = tonumber(ARGV[4])
local cutoff     = now - window_ms

-- Remove entries outside the rolling window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Count existing admitted entries in the window
local count = redis.call('ZCARD', key)

-- Increment shared atomic sequence counter across all app instances
local seq = redis.call('INCR', seq_key)
redis.call('EXPIRE', seq_key, ttl_secs)

-- Only admit into the sliding window if within limit
if count < limit then
  local member = tostring(now) .. ':' .. tostring(seq)
  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, ttl_secs)
end
count = count + 1

-- Oldest entry still in window
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldest_score = 0
if #oldest > 0 then
  oldest_score = tonumber(oldest[2])
end

return { count, oldest_score }
`;

// ── Rate limiter class ─────────────────────────────────────────────────────────

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly routeClass?: RouteSensitivityClass;
  private readonly failurePolicy: RateLimitFailurePolicy;
  private readonly fallbackStore: SharedAtomicCounterStore;

  constructor(
    private readonly redis: RedisClient | null,
    options: RateLimitOptions
  ) {
    const classPolicy = options.routeClass
      ? resolveRouteClassPolicy(options.routeClass)
      : undefined;
    this.limit = options.limit ?? classPolicy?.defaultLimit ?? 60;
    this.windowMs = options.windowMs ?? classPolicy?.defaultWindowMs ?? 60_000;
    this.keyPrefix = options.keyPrefix ?? classPolicy?.keyPrefix ?? "rl";
    this.ttlSeconds = Math.ceil(this.windowMs / 1_000) + 1;
    this.routeClass = options.routeClass;
    this.failurePolicy =
      options.failurePolicy ?? classPolicy?.failurePolicy ?? "fail-open";
    this.fallbackStore = options.fallbackStore ?? new SharedAtomicCounterStore();
  }

  /**
   * Check and record a request for `identifier` (typically an IP address
   * or authenticated user ID).
   *
   * @returns `RateLimitResult` — always resolves, never rejects.
   *          When Redis is unavailable, applies the configured `failurePolicy`:
   *          - `"fail-open"`: allows request (`degraded: true`)
   *          - `"fail-closed"`: rejects request (`allowed: false, degraded: true`)
   *          - `"fallback-memory"`: evaluates against bounded in-memory atomic counter
   */
  async check(identifier: string): Promise<RateLimitResult> {
    const key = `${this.keyPrefix}:${identifier}`;
    const now = Date.now();

    if (!this.redis) {
      return this.handleRedisOutage(key, now);
    }

    try {
      const result = (await this.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        String(now),
        String(this.windowMs),
        String(this.limit),
        String(this.ttlSeconds)
      )) as [number, number];

      const count = result[0];
      const oldestScore = result[1];
      const allowed = count <= this.limit;
      const resetAt =
        oldestScore > 0 ? oldestScore + this.windowMs : now + this.windowMs;

      return {
        allowed,
        remaining: Math.max(0, this.limit - count),
        limit: this.limit,
        resetAt,
        count,
        degraded: false,
        failurePolicy: this.failurePolicy,
        ...(this.routeClass ? { routeClass: this.routeClass } : {}),
        reason: allowed ? "OK" : "RATE_LIMIT_EXCEEDED",
      };
    } catch (err) {
      console.error(
        `[rate-limit] Redis error (${this.failurePolicy}) on ${key}:`,
        (err as Error).message
      );
      return this.handleRedisOutage(key, now);
    }
  }

  private handleRedisOutage(key: string, now: number): RateLimitResult {
    if (this.failurePolicy === "fail-closed") {
      return {
        allowed: false,
        remaining: 0,
        limit: this.limit,
        resetAt: now + this.windowMs,
        count: this.limit + 1,
        degraded: true,
        failurePolicy: "fail-closed",
        ...(this.routeClass ? { routeClass: this.routeClass } : {}),
        reason: "REDIS_UNAVAILABLE_FAIL_CLOSED",
      };
    }

    if (this.failurePolicy === "fallback-memory") {
      const [count, oldestScore] = this.fallbackStore.evaluate(
        key,
        now,
        this.windowMs,
        this.limit,
        this.ttlSeconds
      );
      const allowed = count <= this.limit;
      const resetAt =
        oldestScore > 0 ? oldestScore + this.windowMs : now + this.windowMs;

      return {
        allowed,
        remaining: Math.max(0, this.limit - count),
        limit: this.limit,
        resetAt,
        count,
        degraded: true,
        failurePolicy: "fallback-memory",
        ...(this.routeClass ? { routeClass: this.routeClass } : {}),
        reason: allowed
          ? "REDIS_UNAVAILABLE_FALLBACK_MEMORY"
          : "RATE_LIMIT_EXCEEDED",
      };
    }

    return {
      allowed: true,
      remaining: this.limit,
      limit: this.limit,
      resetAt: now + this.windowMs,
      count: 0,
      degraded: true,
      failurePolicy: "fail-open",
      ...(this.routeClass ? { routeClass: this.routeClass } : {}),
      reason: "REDIS_UNAVAILABLE_FAIL_OPEN",
    };
  }
}

// ── Preset factory ────────────────────────────────────────────────────────────

/**
 * Create a `RateLimiter` from environment variables with sensible defaults.
 *
 * Environment variables (all optional):
 * | Variable                   | Default | Description                          |
 * |----------------------------|---------|--------------------------------------|
 * | RATE_LIMIT_MAX_REQUESTS    | 60      | Max requests per window              |
 * | RATE_LIMIT_WINDOW_MS       | 60000   | Window size in ms (default: 1 min)   |
 * | RATE_LIMIT_KEY_PREFIX      | rl      | Key prefix in Redis                  |
 */
export function createRateLimiter(
  redis: RedisClient | null,
  overrides?: Partial<RateLimitOptions>
): RateLimiter {
  const classPolicy = overrides?.routeClass
    ? resolveRouteClassPolicy(overrides.routeClass)
    : undefined;
  return new RateLimiter(redis, {
    limit: Number(
      process.env.RATE_LIMIT_MAX_REQUESTS ?? classPolicy?.defaultLimit ?? 60
    ),
    windowMs: Number(
      process.env.RATE_LIMIT_WINDOW_MS ?? classPolicy?.defaultWindowMs ?? 60_000
    ),
    keyPrefix:
      process.env.RATE_LIMIT_KEY_PREFIX ?? classPolicy?.keyPrefix ?? "rl",
    ...overrides,
  });
}

// ── Response header helpers ───────────────────────────────────────────────────

/**
 * Build the standard rate-limit response headers.
 *
 * Follows the IETF `RateLimit` header draft and the widely-adopted
 * `X-RateLimit-*` convention for compatibility:
 *   RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
 *   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *   Retry-After (only when rejected)
 *   X-RateLimit-Degraded, X-RateLimit-Policy-Mode (when degraded)
 */
export function buildRateLimitHeaders(
  result: RateLimitResult
): Record<string, string> {
  const resetSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1_000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSeconds),
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(resetSeconds),
  };
  if (result.degraded) {
    headers["X-RateLimit-Degraded"] = "true";
    if (result.failurePolicy) {
      headers["X-RateLimit-Policy-Mode"] = result.failurePolicy;
    }
  }
  if (!result.allowed) {
    headers["Retry-After"] = String(resetSeconds);
  }
  return headers;
}

