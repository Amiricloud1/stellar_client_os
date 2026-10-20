/**
 * Campaign Progress Caching Layer — issue #976
 *
 * Reduces database query load by caching frequently-accessed campaign progress metrics:
 *   - Tree count
 *   - Sponsor count
 *   - CO2 impact
 *   - Total raised amount
 *
 * # Cache Strategy
 * Uses a cache-aside pattern with a 5-minute TTL (300 seconds) to balance
 * freshness with reduced database load during high traffic periods.
 *
 * # Key Design (schema v1)
 * Keys are namespaced as `campaign:progress:v1:{campaignId}` for individual
 * campaign metrics. The `v1` segment is a schema version: bump it whenever the
 * shape of {@link CampaignProgressMetrics} changes so that entries written by
 * an older deployment can never be deserialized into the new shape. Old
 * versions are simply abandoned and expire via their TTL.
 *
 * # Freshness Budget
 * Every entry carries a `calculatedAt` timestamp. An entry is considered
 * *fresh* while `now - calculatedAt <= freshnessBudgetMs`. The freshness
 * budget is derived from the TTL (see {@link CampaignProgressCache.getFreshnessBudgetMs})
 * and is always <= the TTL, so an entry can never be served beyond its budget
 * even if the Redis TTL has not yet elapsed (e.g. clock skew, TTL drift, or a
 * writer that used a longer TTL). Stale entries are treated as misses and are
 * deleted on read.
 *
 * # TTL Configuration
 * Default TTL: 300 seconds (5 minutes)
 * Override via: CAMPAIGN_PROGRESS_CACHE_TTL_SECONDS environment variable
 * Override freshness budget via: CAMPAIGN_PROGRESS_CACHE_FRESHNESS_SECONDS
 * (clamped to [0, TTL]).
 *
 * # Invalidation Semantics
 * Authoritative totals must never remain stale. Callers MUST call
 * {@link CampaignProgressCache.invalidate} (or {@link CampaignProgressCache.invalidateMany})
 * after any mutation that affects progress metrics, including:
 *   - new contributions / sponsorships
 *   - tree planting events
 *   - refunds or reversals
 *   - chain corrections / reorgs (see {@link CampaignProgressCache.invalidateForChainCorrection})
 * Invalidation is best-effort: on Redis failure the error is logged and the
 * entry is left to expire via TTL, which bounds staleness to the freshness budget.
 *
 * # Graceful Degradation
 * All methods return `null` on cache miss or Redis unavailability,
 * allowing the caller to fall through to the database without errors.
 *
 * @module campaign-progress-cache
 */

import { getRedisClient, type RedisClient } from "./redis";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Campaign progress metrics cached to reduce database load */
export interface CampaignProgressMetrics {
  /** Unique campaign identifier */
  campaignId: string;
  /** Total number of trees planted */
  treeCount: number;
  /** Total number of unique sponsors/contributors */
  sponsorCount: number;
  /** Total amount raised in token stroops */
  raisedAmount: string;
  /** Calculated CO2 impact in kilograms */
  co2ImpactKg: number;
  /** Unix timestamp (ms) when these metrics were calculated */
  calculatedAt: number;
}

/** Options for cache operations */
export interface CacheOptions {
  /** TTL in seconds. If not provided, uses default from env or 300s */
  ttlSeconds?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const KEY_PREFIX = "campaign:progress";
/** Schema version segment embedded in every key. Bump on shape changes. */
const KEY_SCHEMA_VERSION = "v1";
/** Default cache TTL: 5 minutes (300 seconds) */
const DEFAULT_TTL_SECONDS = 300;

// ── Key builders ──────────────────────────────────────────────────────────────

/** Build a cache key for campaign progress metrics */
export function buildProgressKey(campaignId: string): string {
  return `${KEY_PREFIX}:${KEY_SCHEMA_VERSION}:${campaignId}`;
}

/** Build a cache key pattern for bulk invalidation */
export function buildProgressKeyPattern(): string {
  return `${KEY_PREFIX}:${KEY_SCHEMA_VERSION}:*`;
}

/** Build a cache key pattern covering all schema versions (migration/cleanup) */
export function buildAllVersionsProgressKeyPattern(): string {
  return `${KEY_PREFIX}:*`;
}

// ── Core cache class ──────────────────────────────────────────────────────────

export class CampaignProgressCache {
  constructor(private readonly redis: RedisClient | null) {}

  /**
   * Get the configured TTL in seconds.
   * Reads from CAMPAIGN_PROGRESS_CACHE_TTL_SECONDS env var or uses default.
   */
  private getTTL(options?: CacheOptions): number {
    if (options?.ttlSeconds !== undefined) {
      return options.ttlSeconds;
    }
    const envTTL = process.env.CAMPAIGN_PROGRESS_CACHE_TTL_SECONDS;
    const parsed = envTTL ? Number(envTTL) : DEFAULT_TTL_SECONDS;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_SECONDS;
  }

  /**
   * Get the freshness budget in milliseconds for the given options.
   * Defaults to the TTL (so entries are never served past their TTL) and is
   * clamped to [0, TTL] so a misconfigured budget can never exceed the TTL.
   */
  getFreshnessBudgetMs(options?: CacheOptions): number {
    const ttlMs = this.getTTL(options) * 1000;
    const envFreshness = process.env.CAMPAIGN_PROGRESS_CACHE_FRESHNESS_SECONDS;
    const parsed = envFreshness ? Number(envFreshness) * 1000 : ttlMs;
    if (!Number.isFinite(parsed) || parsed < 0) return ttlMs;
    return Math.min(parsed, ttlMs);
  }

  /** Returns true when the entry is within the freshness budget. */
  private isFresh(
    metrics: CampaignProgressMetrics,
    options?: CacheOptions,
    now: number = Date.now()
  ): boolean {
    if (typeof metrics.calculatedAt !== "number") return false;
    const age = now - metrics.calculatedAt;
    // Reject future-dated entries (clock skew) beyond a small tolerance.
    if (age < -1000) return false;
    return age <= this.getFreshnessBudgetMs(options);
  }

  /**
   * Retrieve cached progress metrics for a campaign.
   * Returns `null` on cache miss, expiry, stale entry, or Redis unavailability.
   * Stale entries are deleted on read so they can never be served again.
   */
  async get(
    campaignId: string,
    options?: CacheOptions
  ): Promise<CampaignProgressMetrics | null> {
    if (!this.redis) return null;
    try {
      const key = buildProgressKey(campaignId);
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const metrics = JSON.parse(raw) as CampaignProgressMetrics;
      if (!this.isFresh(metrics, options)) {
        // Stale beyond freshness budget: drop it and report a miss.
        await this.redis.del(key);
        return null;
      }
      return metrics;
    } catch (err) {
      console.error(
        `[campaign-progress-cache] get error for campaign "${campaignId}":`,
        (err as Error).message
      );
      return null;
    }
  }

  /**
   * Store campaign progress metrics with TTL.
   * Silently no-ops when Redis is unavailable.
   */
  async set(
    metrics: CampaignProgressMetrics,
    options?: CacheOptions
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const key = buildProgressKey(metrics.campaignId);
      const ttl = this.getTTL(options);
      const serialized = JSON.stringify(metrics);
      
      if (ttl > 0) {
        await this.redis.setex(key, ttl, serialized);
      } else {
        await this.redis.set(key, serialized);
      }
    } catch (err) {
      console.error(
        `[campaign-progress-cache] set error for campaign "${metrics.campaignId}":`,
        (err as Error).message
      );
    }
  }

  /**
   * Invalidate cached progress metrics for a specific campaign.
   * Call this when a campaign receives a new contribution, tree is planted,
   * or any other action that affects progress metrics.
   */
  async invalidate(campaignId: string): Promise<void> {
    if (!this.redis) return;
    try {
      const key = buildProgressKey(campaignId);
      await this.redis.del(key);
    } catch (err) {
      console.error(
        `[campaign-progress-cache] invalidate error for campaign "${campaignId}":`,
        (err as Error).message
      );
    }
  }

  /**
   * Invalidate cached metrics for multiple campaigns in a single round trip.
   * Use after batch mutations (e.g. bulk tree planting) to keep totals fresh.
   */
  async invalidateMany(campaignIds: string[]): Promise<void> {
    if (!this.redis || campaignIds.length === 0) return;
    try {
      const keys = campaignIds.map(buildProgressKey);
      await this.redis.del(...keys);
    } catch (err) {
      console.error(
        "[campaign-progress-cache] invalidateMany error:",
        (err as Error).message
      );
    }
  }

  /**
   * Invalidate cached metrics after a chain correction / reorg.
   * Chain corrections can rewrite historical totals, so the affected
   * campaigns' entries must be dropped immediately rather than waiting for TTL.
   * When `campaignIds` is omitted, all cached progress entries are invalidated.
   */
  async invalidateForChainCorrection(campaignIds?: string[]): Promise<void> {
    if (campaignIds === undefined) {
      await this.invalidateAll();
      return;
    }
    await this.invalidateMany(campaignIds);
  }

  /**
   * Invalidate all cached campaign progress metrics.
   * Useful for testing or when performing bulk updates.
   */
  async invalidateAll(): Promise<number> {
    if (!this.redis) return 0;
    let cursor = "0";
    let deleted = 0;
    try {
      const pattern = buildProgressKeyPattern();
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          deleted += await this.redis.del(...keys);
        }
      } while (cursor !== "0");
      return deleted;
    } catch (err) {
      console.error(
        "[campaign-progress-cache] invalidateAll error:",
        (err as Error).message
      );
      return deleted;
    }
  }

  /**
   * Get the remaining TTL for a campaign's cached metrics.
   * Returns -1 if no TTL, -2 if key doesn't exist, null on error.
   */
  async ttl(campaignId: string): Promise<number | null> {
    if (!this.redis) return null;
    try {
      const key = buildProgressKey(campaignId);
      return await this.redis.ttl(key);
    } catch {
      return null;
    }
  }

  /**
   * Bulk get cached metrics for multiple campaigns.
   * Returns a Map of campaignId -> metrics for cache hits only.
   */
  async getMany(
    campaignIds: string[],
    options?: CacheOptions
  ): Promise<Map<string, CampaignProgressMetrics>> {
    const result = new Map<string, CampaignProgressMetrics>();
    if (!this.redis || campaignIds.length === 0) return result;

    try {
      const keys = campaignIds.map(buildProgressKey);
      const values = await this.redis.mget(...keys);
      const now = Date.now();
      const staleKeys: string[] = [];

      for (let i = 0; i < values.length; i++) {
        const raw = values[i];
        if (raw !== null) {
          try {
            const metrics = JSON.parse(raw) as CampaignProgressMetrics;
            if (this.isFresh(metrics, options, now)) {
              result.set(campaignIds[i], metrics);
            } else {
              staleKeys.push(keys[i]);
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }

      if (staleKeys.length > 0) {
        await this.redis.del(...staleKeys);
      }
    } catch (err) {
      console.error(
        "[campaign-progress-cache] getMany error:",
        (err as Error).message
      );
    }

    return result;
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _campaignProgressCache: CampaignProgressCache | null = null;

export function getCampaignProgressCache(
  redis?: RedisClient | null
): CampaignProgressCache {
  if (redis !== undefined) return new CampaignProgressCache(redis);
  if (!_campaignProgressCache) {
    _campaignProgressCache = new CampaignProgressCache(getRedisClient());
  }
  return _campaignProgressCache;
}
