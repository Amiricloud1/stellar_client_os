import { getCampaign } from "@/services/campaign.service";

/**
 * Current version of the incremental campaign aggregate reducer.
 *
 * Bump this whenever the reducer's math or event handling changes so that
 * cached snapshots produced by an older reducer are never served. Cached
 * entries carry the version they were computed with; a mismatch is treated as
 * a miss and the entry is evicted.
 */
export const CAMPAIGN_AGGREGATE_REDUCER_VERSION = 1;

export interface CampaignProgressMetrics {
  campaignId: string;
  treeCount: number;
  sponsorCount: number;
  co2ImpactKg: number;
  co2SequestrationTonnes: string;
  raisedAmount: string;
  goalAmount: string;
  /** Reducer version that produced these totals. */
  aggregateVersion: number;
  cachedAt: number;
  expiresAt: number;
  ttlSeconds: number;
}

/**
 * Reasons a campaign progress cache entry may be invalidated.
 *
 * - `mutation`: an authoritative write (donation, sponsorship, tree planting)
 *   changed the campaign totals.
 * - `chain-correction`: an on-chain reorg/correction changed previously
 *   confirmed totals, so any cached snapshot is untrustworthy.
 * - `manual`: an operator or admin explicitly requested a refresh.
 * - `reconciliation`: a periodic reconciliation pass detected drift between
 *   incremental aggregates and a full recomputation.
 * - `drift-repair`: a drift repair rewrote aggregate totals.
 * - `version-mismatch`: a cached entry was produced by an older reducer
 *   version and must not be served.
 */
export type CampaignProgressInvalidationReason =
  | "mutation"
  | "chain-correction"
  | "manual"
  | "reconciliation"
  | "drift-repair"
  | "version-mismatch";

export interface CampaignProgressInvalidationResult {
  campaignId: string;
  reason: CampaignProgressInvalidationReason;
  /** Whether an entry was actually present and removed. */
  invalidated: boolean;
  /** Cache key that was targeted, for logging/observability. */
  key: string;
  /** Clock time (ms since epoch) at which invalidation occurred. */
  invalidatedAt: number;
}

interface CacheEntry {
  data: CampaignProgressMetrics;
  expiresAt: number;
}

export interface CampaignProgressCacheOptions {
  /** Default TTL in seconds. Falls back to the environment/default when omitted. */
  ttlSeconds?: number;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Reducer version this cache instance considers current. Defaults to
   * `CAMPAIGN_AGGREGATE_REDUCER_VERSION`.
   */
  aggregateVersion?: number;
}

/**
 * Default TTL for campaign progress metrics: 5 minutes (300 seconds).
 *
 * Overridable at construction time or via the
 * `CAMPAIGN_PROGRESS_CACHE_TTL_SECONDS` environment variable.
 */
export const DEFAULT_CAMPAIGN_PROGRESS_TTL_SECONDS = 300;

/**
 * Namespace for campaign progress cache keys.
 *
 * Keys are built as `campaign:progress:{campaignId}` so that different
 * campaigns (and, if parameters are ever introduced, different parameter
 * sets) never share an entry. Keep the prefix in sync with the Redis-backed
 * cache in `@/lib/campaign-progress-cache`.
 */
export const CAMPAIGN_PROGRESS_CACHE_KEY_PREFIX = "campaign:progress";

/**
 * Freshness budget (seconds) for campaign progress metrics.
 *
 * Authoritative totals (raised amount, tree count, sponsor count) must not
 * remain stale beyond this window even if no mutation event is observed.
 * This is the documented upper bound; per-call TTLs may be shorter but never
 * longer than this budget.
 */
export const CAMPAIGN_PROGRESS_FRESHNESS_BUDGET_SECONDS = DEFAULT_CAMPAIGN_PROGRESS_TTL_SECONDS;

/**
 * Build the isolated cache key for a campaign's progress metrics.
 *
 * The key includes the aggregate reducer version so entries produced by an
 * older reducer can never collide with (or be served to) the current one.
 */
export function buildCampaignProgressCacheKey(
  campaignId: string,
  aggregateVersion: number = CAMPAIGN_AGGREGATE_REDUCER_VERSION
): string {
  return `${CAMPAIGN_PROGRESS_CACHE_KEY_PREFIX}:v${aggregateVersion}:${campaignId}`;
}

/**
 * Clamp a requested TTL to the freshness budget so authoritative totals can
 * never be cached longer than the documented window.
 */
function clampToFreshnessBudget(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_CAMPAIGN_PROGRESS_TTL_SECONDS;
  }
  return Math.min(Math.floor(ttlSeconds), CAMPAIGN_PROGRESS_FRESHNESS_BUDGET_SECONDS);
}

function resolveDefaultTtl(explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }

  const raw = process.env.CAMPAIGN_PROGRESS_CACHE_TTL_SECONDS;
  if (!raw) {
    return DEFAULT_CAMPAIGN_PROGRESS_TTL_SECONDS;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_CAMPAIGN_PROGRESS_TTL_SECONDS;
}

export class CampaignProgressCacheService {
  private cache = new Map<string, CacheEntry>();
  private defaultTtlSeconds: number;
  private now: () => number;
  private aggregateVersion: number;
  private stats = {
    hits: 0,
    misses: 0,
    versionMismatches: 0,
  };

  constructor(options: number | CampaignProgressCacheOptions = {}) {
    if (typeof options === "number") {
      this.defaultTtlSeconds = resolveDefaultTtl(options);
      this.now = () => Date.now();
      this.aggregateVersion = CAMPAIGN_AGGREGATE_REDUCER_VERSION;
    } else {
      this.defaultTtlSeconds = resolveDefaultTtl(options.ttlSeconds);
      this.now = options.now ?? (() => Date.now());
      this.aggregateVersion =
        options.aggregateVersion ?? CAMPAIGN_AGGREGATE_REDUCER_VERSION;
    }
  }

  /** Reducer version this cache instance serves. */
  getAggregateVersion(): number {
    return this.aggregateVersion;
  }

  get(campaignId: string): CampaignProgressMetrics | null {
    const key = buildCampaignProgressCacheKey(campaignId, this.aggregateVersion);
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (this.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }

    // Never serve totals produced by a different reducer version.
    if (entry.data.aggregateVersion !== this.aggregateVersion) {
      this.cache.delete(key);
      this.stats.versionMismatches++;
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry.data;
  }

  set(
    campaignId: string,
    metrics: Omit<
      CampaignProgressMetrics,
      "cachedAt" | "expiresAt" | "ttlSeconds" | "aggregateVersion"
    > & { aggregateVersion?: number },
    ttlSeconds = this.defaultTtlSeconds
  ): CampaignProgressMetrics {
    const key = buildCampaignProgressCacheKey(campaignId, this.aggregateVersion);
    const now = this.now();
    const effectiveTtl = clampToFreshnessBudget(ttlSeconds);
    const expiresAt = now + effectiveTtl * 1000;
    const entryData: CampaignProgressMetrics = {
      ...metrics,
      aggregateVersion: this.aggregateVersion,
      cachedAt: now,
      expiresAt,
      ttlSeconds: effectiveTtl,
    };

    this.cache.set(key, {
      data: entryData,
      expiresAt,
    });

    return entryData;
  }

  async getOrFetch(
    campaignId: string,
    forceRefresh = false,
    ttlSeconds = this.defaultTtlSeconds
  ): Promise<{ metrics: CampaignProgressMetrics; cacheHit: boolean }> {
    if (!forceRefresh) {
      const cached = this.get(campaignId);
      // `get` already enforces the freshness budget: expired entries are
      // evicted and reported as misses, so stale totals are never served.
      if (cached) {
        return { metrics: cached, cacheHit: true };
      }
    }

    const campaign = await getCampaign(campaignId);
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    const treeCount = campaign.treeCount ?? 0;
    const sponsorCount = campaign.sponsorCount ?? 0;
    const co2PerTreeKg = 20;
    const co2ImpactKg = treeCount * co2PerTreeKg;
    const co2Tonnes = (co2ImpactKg / 1000).toFixed(2);

    const saved = this.set(
      campaignId,
      {
        campaignId,
        treeCount,
        sponsorCount,
        co2ImpactKg,
        co2SequestrationTonnes: campaign.co2Sequestration ?? co2Tonnes,
        raisedAmount: campaign.raisedAmount ?? "0",
        goalAmount: campaign.goalAmount ?? "0",
      },
      ttlSeconds
    );

    return { metrics: saved, cacheHit: false };
  }

  invalidate(campaignId: string): boolean {
    return this.cache.delete(
      buildCampaignProgressCacheKey(campaignId, this.aggregateVersion)
    );
  }

  /**
   * Invalidate a campaign's cached progress metrics in response to an
   * authoritative change.
   *
   * Call this on every mutation (donation, sponsorship, tree planting) and on
   * chain corrections/reorgs so the next read re-fetches authoritative totals
   * instead of serving a stale snapshot. Returns structured metadata suitable
   * for logging/observability.
   */
  invalidateForReason(
    campaignId: string,
    reason: CampaignProgressInvalidationReason
  ): CampaignProgressInvalidationResult {
    const key = buildCampaignProgressCacheKey(campaignId, this.aggregateVersion);
    const invalidated = this.cache.delete(key);
    return {
      campaignId,
      reason,
      invalidated,
      key,
      invalidatedAt: this.now(),
    };
  }

  /**
   * Invalidate a campaign's cached totals after a reconciliation pass or a
   * drift repair rewrote the incremental aggregates.
   *
   * This is a thin, explicit wrapper over `invalidateForReason` so callers
   * cannot accidentally use the wrong reason for aggregate rewrites.
   */
  invalidateForReconciliation(
    campaignId: string,
    reason: Extract<
      CampaignProgressInvalidationReason,
      "reconciliation" | "drift-repair" | "version-mismatch"
    > = "reconciliation"
  ): CampaignProgressInvalidationResult {
    return this.invalidateForReason(campaignId, reason);
  }

  /**
   * Invalidate multiple campaigns at once (e.g. a chain correction affecting a
   * batch of campaigns). Returns one result per campaign id.
   */
  invalidateMany(
    campaignIds: readonly string[],
    reason: CampaignProgressInvalidationReason
  ): CampaignProgressInvalidationResult[] {
    return campaignIds.map((campaignId) => this.invalidateForReason(campaignId, reason));
  }

  clear(): void {
    this.cache.clear();
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.versionMismatches = 0;
  }

  getStats() {
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      versionMismatches: this.stats.versionMismatches,
      aggregateVersion: this.aggregateVersion,
    };
  }
}

export const campaignProgressCache = new CampaignProgressCacheService();
