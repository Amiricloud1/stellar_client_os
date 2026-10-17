/**
 * Unified rate-limit policy — issue #56
 *
 * A single route-class policy governs every API route. Routes are grouped
 * into three classes (`public`, `authenticated`, `privileged`) and each class
 * has exactly one limit/window pair defined in `ROUTE_CLASS_LIMITS`. This
 * replaces the previously conflicting tier models (daily/burst tiers, campaign
 * tiers, per-endpoint sliding windows) with one source of truth.
 *
 * # Atomic counters
 * Each identity gets a fixed-window counter backed by a single Lua script that
 * performs `INCR` + (conditional) `PEXPIRE` atomically. There is no TOCTOU
 * race between reading the count and setting the expiry, even across multiple
 * app instances.
 *
 * # Identity keys
 * Identities are normalised into a single key namespace (`rl:<class>:<id>`)
 * so the same caller cannot bypass limits by presenting different header
 * spellings. See `buildIdentityKey`.
 *
 * # Response headers
 * `buildRateLimitHeaders` emits the standard `RateLimit-Limit`,
 * `RateLimit-Remaining`, `RateLimit-Reset` headers plus `Retry-After` on 429.
 * `RateLimit-Reset` and `Retry-After` are computed from the window's actual
 * reset time, so they stay correct as the window elapses.
 *
 * # Graceful degradation
 * When Redis is unavailable checks return `allowed: true` so the app keeps
 * serving requests rather than entering a hard-fail state.
 *
 * # Compatibility
 * `RateLimiter`, `createRateLimiter`, and the legacy tier helpers are kept as
 * thin deprecated wrappers so existing call sites keep compiling. New code
 * should use `checkRouteLimit` / `buildRateLimitHeaders`.
 *
 * @module rate-limit
 */

import type { RedisClient } from "./redis";

// ── Route-class policy ────────────────────────────────────────────────────────

/** Route classes that share a single rate-limit policy. */
export type RouteClass = "public" | "authenticated" | "privileged";

export interface RouteClassLimit {
  /** Max requests allowed within `windowMs`. */
  limit: number;
  /** Fixed window size in milliseconds. */
  windowMs: number;
}

/**
 * The single source of truth for rate limits. Every route must map to one of
 * these classes; do not introduce per-endpoint limits elsewhere.
 *
 * | Class         | Limit | Window | Typical routes                          |
 * |---------------|-------|--------|-----------------------------------------|
 * | public        | 60    | 60 s   | unauthenticated reads, health, listings |
 * | authenticated | 300   | 60 s   | reads/writes with a valid API key       |
 * | privileged    | 1000  | 60 s   | admin / mutation endpoints              |
 */
export const ROUTE_CLASS_LIMITS: Record<RouteClass, RouteClassLimit> = {
  public: { limit: 60, windowMs: 60_000 },
  authenticated: { limit: 300, windowMs: 60_000 },
  privileged: { limit: 1_000, windowMs: 60_000 },
};

/** Resolve the policy for a route class, falling back to `public`. */
export function getRouteClassLimit(routeClass: RouteClass): RouteClassLimit {
  return ROUTE_CLASS_LIMITS[routeClass] ?? ROUTE_CLASS_LIMITS.public;
}

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
}

export interface RateLimitResult {
  /** Whether this request is allowed through. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Total limit for the window. */
  limit: number;
  /** Unix timestamp (ms) when the current window resets. */
  resetAt: number;
  /** How many requests have been made in the current window. */
  count: number;
  /** Rate limit tier applied (optional, legacy). */
  tier?: RateLimitTier;
}

// ── Identity keys ─────────────────────────────────────────────────────────────

/**
 * Normalise an identity (IP, user ID, API key) into a single Redis key.
 *
 * - Trims whitespace and lowercases so header casing/spacing cannot be used to
 *   obtain a fresh bucket.
 * - Strips IPv6 brackets and collapses IPv4-mapped IPv6 (`::ffff:1.2.3.4`) to
 *   the bare IPv4 form so the same client is counted once regardless of how
 *   the proxy reports it.
 * - Falls back to `"anonymous"` for empty identities.
 */
export function buildIdentityKey(routeClass: RouteClass, identity: string): string {
  let id = (identity ?? "").trim().toLowerCase();
  if (id.startsWith("[") && id.endsWith("]")) id = id.slice(1, -1);
  if (id.startsWith("::ffff:")) id = id.slice("::ffff:".length);
  if (!id) id = "anonymous";
  return `rl:${routeClass}:${id}`;
}

// ── Lua script ────────────────────────────────────────────────────────────────

/**
 * Atomic fixed-window counter Lua script.
 *
 * KEYS[1] — counter key (e.g. "rl:public:127.0.0.1")
 * ARGV[1] — window size in ms
 *
 * Returns: { count, pttl } as a two-element array
 *   count — value of the counter AFTER this increment
 *   pttl  — remaining TTL of the key in ms (window reset time)
 *
 * The `INCR` and the conditional `PEXPIRE` run in one atomic step, so a key
 * can never be incremented without an expiry (the classic INCR/EXPIRE race).
 */
const FIXED_WINDOW_SCRIPT = `
local key       = KEYS[1]
local window_ms = tonumber(ARGV[1])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, window_ms)
end

local pttl = redis.call('PTTL', key)
if pttl < 0 then
  -- Key existed without a TTL (e.g. legacy data); repair it.
  redis.call('PEXPIRE', key, window_ms)
  pttl = window_ms
end

return { count, pttl }
`;

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Check and record a request for `identity` against the policy for
 * `routeClass`.
 *
 * @param routeClass — one of `public` | `authenticated` | `privileged`.
 * @param identity   — IP address, user ID, or API key. Normalised via
 *                     `buildIdentityKey`.
 * @param redis      — Redis client; when `null` the check fails open.
 * @param now        — injectable clock (ms) for deterministic tests.
 *
 * @returns `RateLimitResult` — always resolves, never rejects.
 *          When Redis is unavailable: `allowed: true`, remaining = limit.
 */
export async function checkRouteLimit(
  routeClass: RouteClass,
  identity: string,
  redis: RedisClient | null,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const { limit, windowMs } = getRouteClassLimit(routeClass);
  const key = buildIdentityKey(routeClass, identity);

  if (!redis) {
    return {
      allowed: true,
      remaining: limit,
      limit,
      resetAt: now + windowMs,
      count: 0,
    };
  }

  try {
    const result = (await redis.eval(
      FIXED_WINDOW_SCRIPT,
      1,
      key,
      String(windowMs)
    )) as [number, number];

    const count = Number(result[0]);
    const pttl = Number(result[1]);
    const allowed = count <= limit;
    const resetAt = now + (pttl > 0 ? pttl : windowMs);

    return {
      allowed,
      remaining: Math.max(0, limit - count),
      limit,
      resetAt,
      count,
    };
  } catch (err) {
    console.error(
      "[rate-limit] Redis error — allowing request:",
      (err as Error).message
    );
    return {
      allowed: true,
      remaining: limit,
      limit,
      resetAt: now + windowMs,
      count: 0,
    };
  }
}

// ── Rate limiter class (deprecated) ───────────────────────────────────────────

/**
 * @deprecated Use `checkRouteLimit` with a `RouteClass` instead. This wrapper
 * is retained only for backwards compatibility and will be removed in a future
 * release. It maps its configured limit/window onto the fixed-window counter.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisClient | null,
    options: RateLimitOptions
  ) {
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.keyPrefix = options.keyPrefix ?? "rl";
  }

  /**
   * @deprecated Use `checkRouteLimit`.
   *
   * @returns `RateLimitResult` — always resolves, never rejects.
   *          When Redis is unavailable: `allowed: true`, remaining = limit.
   */
  async check(identifier: string): Promise<RateLimitResult> {
    const now = Date.now();
    const key = `${this.keyPrefix}:${(identifier ?? "").trim().toLowerCase() || "anonymous"}`;

    if (!this.redis) {
      return this.buildResult(true, 0, now);
    }

    try {
      const result = (await this.redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        String(this.windowMs)
      )) as [number, number];

      const count = Number(result[0]);
      const pttl = Number(result[1]);
      const allowed = count <= this.limit;
      const resetAt = now + (pttl > 0 ? pttl : this.windowMs);

      return {
        allowed,
        remaining: Math.max(0, this.limit - count),
        limit: this.limit,
        resetAt,
        count,
      };
    } catch (err) {
      console.error("[rate-limit] Redis error — allowing request:", (err as Error).message);
      return this.buildResult(true, 0, now);
    }
  }

  private buildResult(
    allowed: boolean,
    count: number,
    now: number
  ): RateLimitResult {
    return {
      allowed,
      remaining: Math.max(0, this.limit - count),
      limit: this.limit,
      resetAt: now + this.windowMs,
      count,
    };
  }
}

// ── Preset factory ────────────────────────────────────────────────────────────

/**
 * @deprecated Use `checkRouteLimit` with `ROUTE_CLASS_LIMITS`. Retained for
 * backwards compatibility only.
 *
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
  return new RateLimiter(redis, {
    limit: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 60),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    keyPrefix: process.env.RATE_LIMIT_KEY_PREFIX ?? "rl",
    ...overrides,
  });
}

// ── Response header helpers ───────────────────────────────────────────────────

/**
 * Build the standard rate-limit response headers.
 *
 * Emits the IETF `RateLimit` draft headers:
 *   RateLimit-Limit     — the class limit for the window
 *   RateLimit-Remaining — requests left in the current window
 *   RateLimit-Reset     — seconds until the window resets (>= 0)
 *   Retry-After         — seconds to wait, only present on 429 responses
 *
 * `RateLimit-Reset` and `Retry-After` are derived from `result.resetAt` and the
 * supplied clock, so they shrink as the window elapses and never go negative.
 *
 * @param result — result from `checkRouteLimit`.
 * @param now    — injectable clock (ms) for deterministic tests.
 */
export function buildRateLimitHeaders(
  result: RateLimitResult,
  now: number = Date.now()
): Record<string, string> {
  const resetSeconds = Math.max(0, Math.ceil((result.resetAt - now) / 1_000));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(resetSeconds),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, resetSeconds));
  }
  return headers;
}
