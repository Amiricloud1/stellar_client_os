/**
 * Analytics Service — Aggregate Funding Analytics (issue #538)
 *
 * Data layer for the GraphQL gateway. Aggregates payment stream data
 * from the Stellar contract events / service layer into metrics by
 * region, category, and asset.
 *
 * In production this service queries:
 *   a) The Soroban RPC `getEvents` API for on-chain stream events
 *   b) An optional off-chain indexer database for richer metadata
 *      (region tags, category labels, USD price oracles)
 *
 * For testability, the data source is injected via a `StreamDataSource`
 * interface so tests can provide deterministic fixtures without hitting
 * the network.
 *
 * ── Cache semantics (issue #235) ─────────────────────────────────────────────
 *
 * Cold reads are coalesced and bounded so a burst of identical requests
 * cannot stampede the backing data source:
 *
 *  - **Scope keying.** Every cache entry is keyed by
 *    `(tenant, principal scope, normalized filters)`. Entries are never
 *    shared across tenants or principals, so a cached aggregate can never
 *    leak data across permission boundaries. Filters are normalized
 *    (sorted keys, dropped `undefined`s) so semantically identical queries
 *    share one entry.
 *  - **Single-flight.** Concurrent cold reads for the same key are
 *    coalesced into one in-flight computation. A cross-process Redis-style
 *    lock (`CacheLock`) is acquired before computing; if the lock is held
 *    elsewhere we wait briefly for the winner to publish, then fall back to
 *    computing locally rather than failing the request.
 *  - **Stale-while-revalidate.** Entries are served fresh until `ttlMs`.
 *    Between `ttlMs` and `ttlMs + staleMs` they are served with
 *    `stale: true` while a background revalidation is kicked off. Beyond
 *    the stale bound an entry is never served.
 *  - **Failure & recovery.** If the backend fails and a last-known entry is
 *    still within the stale bound, that entry is returned with
 *    `stale: true` and `degraded: true` so callers/operators can surface a
 *    warning. If no entry is within bounds, the error is propagated as an
 *    explicit `AnalyticsUnavailableError` (never a silent empty result).
 *
 * Callers surface the cache state via the `x-analytics-cache` response
 * header (`hit` | `miss` | `stale` | `coalesced`) and, when degraded, the
 * `x-analytics-degraded` header carrying the failure reason.
 */

import {
  DEFAULT_MAX_AUTHORITY_STALENESS_MS,
  getAnalyticsMetricDefinitions,
  validateStreamMetricsAgainstLedger,
  type AnalyticsAuthorityReport,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricKey,
  type AuthoritativeLedgerSnapshot,
} from "@/lib/analytics-authority";

// ── Types ─────────────────────────────────────────────────────────────────────

export type StreamStatusFilter = "Active" | "Paused" | "Canceled" | "Completed";

/** Minimal stream record consumed by the analytics service. */
export interface StreamRecord {
  id: string;
  sender: string;
  recipient: string;
  /** Token contract address */
  asset: string;
  /** Optional human-readable ticker (USDC, XLM, etc.) */
  symbol?: string;
  /** Total stream amount in stroops (as string to avoid BigInt issues) */
  totalAmount: string;
  status: StreamStatusFilter;
  /** Unix timestamp (seconds) when the stream was created */
  createdAt: number;
  /** Optional geographic region tag (ISO 3166-1 alpha-2) */
  region?: string;
  /** Optional funding category tag */
  category?: string;
  /** USD-equivalent value of the stream (for cross-asset aggregation) */
  usdEquivalent?: string;
}

export interface AssetMetrics {
  asset: string;
  symbol: string;
  totalVolume: string;
  streamCount: number;
  uniqueSenders: number;
  uniqueRecipients: number;
  averageStreamAmount: string;
}

export interface RegionMetrics {
  region: string;
  totalStreams: number;
  totalVolumeUsd: string;
  projectCount: number;
  assetBreakdown: AssetMetrics[];
}

export interface CategoryMetrics {
  category: string;
  totalStreams: number;
  totalVolumeUsd: string;
  sharePercent: number;
  assetBreakdown: AssetMetrics[];
}

export interface GlobalMetrics {
  totalStreams: number;
  activeStreams: number;
  totalVolumeUsd: string;
  uniqueAssets: number;
  uniqueRegions: number;
  uniqueCategories: number;
  latestStreamAt: number | null;
}

export interface GlobalMetricsWithAuthority extends GlobalMetrics {
  authority: AnalyticsAuthorityReport;
  metricDefinitions: Record<AnalyticsMetricKey, AnalyticsMetricDefinition>;
}

export interface RegionFilter {
  region?: string;
  asset?: string;
  status?: StreamStatusFilter;
  fromTimestamp?: number;
  toTimestamp?: number;
}

export interface CategoryFilter {
  category?: string;
  asset?: string;
  status?: StreamStatusFilter;
}

export interface AssetFilter {
  asset?: string;
  status?: StreamStatusFilter;
  fromTimestamp?: number;
  toTimestamp?: number;
}

export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/**
 * Shared pagination contract (issue #59).
 *
 * All list endpoints (campaigns, backers, audit, analytics) accept the same
 * `PaginationInput` shape and return a `PageInfo` alongside their items so
 * clients can page deterministically.
 */
export interface PageInfo {
  /** Number of items requested (after clamping to the shared bounds). */
  limit: number;
  /** Number of items skipped. */
  offset: number;
  /** Total number of items available before pagination. */
  totalCount: number;
  /** Whether more items exist after this page. */
  hasNextPage: boolean;
  /** Whether items exist before this page. */
  hasPreviousPage: boolean;
}

/** A paginated list result: items plus shared page metadata. */
export interface PaginatedResult<T> {
  items: T[];
  pageInfo: PageInfo;
}

/** Default page size when the caller does not specify a limit. */
export const DEFAULT_PAGE_LIMIT = 20;
/** Maximum page size a caller may request. */
export const MAX_PAGE_LIMIT = 100;

/** Sort direction shared by all list endpoints. */
export type SortDirection = "ASC" | "DESC";

/** Normalize a requested limit into the shared [1, MAX_PAGE_LIMIT] bounds. */
export function normalizeLimit(limit?: number): number {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_PAGE_LIMIT);
}

/** Normalize a requested offset into a non-negative integer. */
export function normalizeOffset(offset?: number): number {
  if (offset === undefined || offset === null || !Number.isFinite(offset)) return 0;
  const floored = Math.floor(offset);
  return floored < 0 ? 0 : floored;
}

/**
 * Apply the shared pagination contract to an already-sorted list.
 *
 * Returns the page of items plus `PageInfo` metadata. Callers are
 * responsible for sorting deterministically before calling this helper.
 */
export function paginateWithInfo<T>(
  items: T[],
  pagination?: PaginationInput
): PaginatedResult<T> {
  const limit = normalizeLimit(pagination?.limit);
  const offset = normalizeOffset(pagination?.offset);
  const totalCount = items.length;
  const pageItems = items.slice(offset, offset + limit);
  return {
    items: pageItems,
    pageInfo: {
      limit,
      offset,
      totalCount,
      hasNextPage: offset + pageItems.length < totalCount,
      hasPreviousPage: offset > 0 && totalCount > 0,
    },
  };
}

/**
 * Stable comparator helper: compares two string keys, applying direction.
 * Used to guarantee deterministic ordering for equal primary sort keys.
 */
export function compareStrings(a: string, b: string, direction: SortDirection = "ASC"): number {
  const cmp = a < b ? -1 : a > b ? 1 : 0;
  return direction === "ASC" ? cmp : -cmp;
}

/**
 * Stable comparator helper for bigint values (e.g. volumes), applying
 * direction. Falls back to a string tiebreaker supplied by the caller.
 */
export function compareBigInts(a: bigint, b: bigint, direction: SortDirection = "DESC"): number {
  const cmp = a < b ? -1 : a > b ? 1 : 0;
  return direction === "ASC" ? cmp : -cmp;
}

// ── Sponsor impact comparison (issue #639) ───────────────────────────────────

/**
 * Ranking band for a sponsor based on their percentile within the global
 * sponsor population. Mirrors common leaderboard buckets ("top 10%", etc.).
 */
export type RankingBand =
  | "top_1"
  | "top_5"
  | "top_10"
  | "top_25"
  | "top_50"
  | "below_average";

/**
 * A single sponsor's impact compared with the global average sponsor.
 *
 * All monetary amounts are USD-equivalent strings (same convention as the
 * other analytics metrics). CO2 figures are estimates derived from the
 * volume-to-CO2 conversion factor (see {@link CO2_PER_USD_KG}).
 */
export interface SponsorImpact {
  /** The sponsor's Stellar address. */
  address: string;
  /** Total volume funded by this sponsor (USDC-equivalent, as string). */
  myVolumeUsd: string;
  /** Estimated CO2 offset from this sponsor's funding (kg CO2e). */
  myCo2OffsetKg: number;
  /** Average volume funded per sponsor (USDC-equivalent, as string). */
  globalAverageVolumeUsd: string;
  /** Estimated CO2 offset of the average sponsor (kg CO2e). */
  globalAverageCo2OffsetKg: number;
  /** Number of unique sponsors (senders) in the dataset. */
  globalSponsorCount: number;
  /**
   * Percentage of sponsors this sponsor beats (0–100).
   * `null` when there is no sponsor data to compare against.
   */
  percentile: number | null;
  /** Ranking band ("top 10%", etc.). `null` when there is no data. */
  rankingBand: RankingBand | null;
  /** CO2 conversion factor applied (kg CO2e per 1 USD funded). */
  co2PerUsdKg: number;
}

/**
 * Default estimated CO2 offset per 1 USD funded (kg CO2e).
 *
 * This is a platform-level estimate used to translate on-chain funding
 * volume into an approximate climate impact figure. The default assumes
 * ~1 kg CO2e offset per $1 funded, a conservative figure within the
 * range cited for nature-based / carbon-offset projects. It is purely
 * illustrative and can be tuned per deployment via the `CO2_PER_USD_KG`
 * environment variable (see `.env.example`).
 */
export const DEFAULT_CO2_PER_USD_KG = 1;

function readCo2PerUsdKg(): number {
  const raw = process.env.CO2_PER_USD_KG;
  if (raw === undefined || raw === "") return DEFAULT_CO2_PER_USD_KG;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CO2_PER_USD_KG;
}

/** Resolved CO2 conversion factor (kg CO2e per 1 USD funded). */
export const CO2_PER_USD_KG = readCo2PerUsdKg();

/**
 * Maps a percentile (percentage of sponsors beaten) to a leaderboard band.
 *
 * @example
 * rankingBandForPercentile(96) // → "top_5"
 * rankingBandForPercentile(30) // → "below_average"
 */
export function rankingBandForPercentile(percentile: number): RankingBand {
  if (percentile >= 99) return "top_1";
  if (percentile >= 95) return "top_5";
  if (percentile >= 90) return "top_10";
  if (percentile >= 75) return "top_25";
  if (percentile >= 50) return "top_50";
  return "below_average";
}

/** Convert a USD volume (bigint) into an estimated kg CO2e figure. */
function toCo2Kg(volumeUsd: bigint): number {
  return Math.round(Number(volumeUsd) * CO2_PER_USD_KG * 10) / 10;
}

/** Pluggable data source interface — swap for a real DB/RPC in production. */
export interface StreamDataSource {
  getStreams(network: string): Promise<StreamRecord[]>;
  getLedgerSnapshot?(network: string): Promise<AuthoritativeLedgerSnapshot | null>;
}

// ── Cache primitives (issue #235) ────────────────────────────────────────────

/** Default fresh window for a cached analytics aggregate. */
export const DEFAULT_ANALYTICS_CACHE_TTL_MS = 30_000;
/** Default window past the TTL during which stale entries may be served. */
export const DEFAULT_ANALYTICS_STALE_MS = 5 * 60_000;
/** How long a single-flight waiter blocks for the lock winner to publish. */
export const DEFAULT_ANALYTICS_LOCK_WAIT_MS = 2_000;

/**
 * Cross-process lock abstraction. The production implementation is backed by
 * Redis (`SET key token NX PX ttl`); tests inject an in-memory implementation.
 */
export interface CacheLock {
  /** Attempt to acquire the lock. Resolves `true` when acquired. */
  acquire(key: string, ttlMs: number): Promise<boolean>;
  /** Release a lock previously acquired with the same key. */
  release(key: string): Promise<void>;
}

/** In-process lock used by default and by tests. */
export class InMemoryCacheLock implements CacheLock {
  private readonly held = new Map<string, number>();

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = this.held.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.held.set(key, now + ttlMs);
    return true;
  }

  async release(key: string): Promise<void> {
    this.held.delete(key);
  }
}

/** Identity of the caller, used to scope cache entries. */
export interface AnalyticsCacheScope {
  /** Tenant / organization id. Entries never cross tenants. */
  tenantId: string;
  /**
   * Principal scope — a stable string describing what the caller may see
   * (e.g. `user:123`, `role:admin`, `anon`). Entries never cross scopes.
   */
  principalScope: string;
}

/** Cache state surfaced to callers via headers / logs. */
export type AnalyticsCacheState = "hit" | "miss" | "stale" | "coalesced";

/** Result wrapper carrying the cache state alongside the value. */
export interface CachedAnalyticsResult<T> {
  value: T;
  cache: {
    state: AnalyticsCacheState;
    /** True when the value is past its fresh TTL (served stale). */
    stale: boolean;
    /** True when the value was served because the backend failed. */
    degraded: boolean;
    /** Failure reason when `degraded` is true. */
    degradedReason?: string;
    /** Age of the served entry in milliseconds. */
    ageMs: number;
  };
}

/**
 * Raised when the backend failed and no entry within the stale bound exists.
 * Callers must surface this as an explicit "analytics unavailable" state.
 */
export class AnalyticsUnavailableError extends Error {
  readonly code = "ANALYTICS_UNAVAILABLE";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AnalyticsUnavailableError";
  }
}

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  /** Scope key the entry was stored under — guards against cross-scope reuse. */
  scopeKey: string;
}

/**
 * Build a deterministic cache key from the scope and normalized filters.
 * Filter keys are sorted and `undefined` values dropped so equivalent
 * queries map to the same entry.
 */
export function buildAnalyticsCacheKey(
  namespace: string,
  scope: AnalyticsCacheScope,
  filters: Record<string, unknown> = {}
): string {
  const normalizedFilters = Object.keys(filters)
    .filter((k) => filters[k] !== undefined && filters[k] !== null)
    .sort()
    .map((k) => `${k}=${String(filters[k])}`)
    .join("&");
  return [
    "analytics",
    namespace,
    `tenant:${scope.tenantId}`,
    `scope:${scope.principalScope}`,
    normalizedFilters || "filters:none",
  ].join("|");
}

/**
 * Single-flight cache with bounded stale-while-revalidate.
 *
 * One instance is shared per process; entries are scoped so they can never
 * be reused across tenants or principals.
 */
export class AnalyticsCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly lock: CacheLock = new InMemoryCacheLock(),
    private readonly options: {
      ttlMs?: number;
      staleMs?: number;
      lockWaitMs?: number;
      now?: () => number;
    } = {}
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_ANALYTICS_CACHE_TTL_MS;
  }

  private get staleMs(): number {
    return this.options.staleMs ?? DEFAULT_ANALYTICS_STALE_MS;
  }

  private get lockWaitMs(): number {
    return this.options.lockWaitMs ?? DEFAULT_ANALYTICS_LOCK_WAIT_MS;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Read an entry, returning it only if it belongs to `scopeKey`. */
  private readEntry<T>(key: string, scopeKey: string): CacheEntry<T> | null {
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    // Defensive: never serve an entry stored under a different scope.
    if (entry.scopeKey !== scopeKey) return null;
    return entry;
  }

  /**
   * Resolve a cached value, computing it via `compute` on a cold read.
   *
   * @param key - Cache key from {@link buildAnalyticsCacheKey}.
   * @param scopeKey - Scope portion of the key, re-checked on read.
   * @param compute - Backend loader invoked at most once per cold burst.
   */
  async getOrCompute<T>(
    key: string,
    scopeKey: string,
    compute: () => Promise<T>
  ): Promise<CachedAnalyticsResult<T>> {
    const now = this.now();
    const existing = this.readEntry<T>(key, scopeKey);

    if (existing) {
      const ageMs = now - existing.storedAt;
      if (ageMs <= this.ttlMs) {
        return {
          value: existing.value,
          cache: { state: "hit", stale: false, degraded: false, ageMs },
        };
      }
      if (ageMs <= this.ttlMs + this.staleMs) {
        // Stale-while-revalidate: serve immediately, refresh in background.
        void this.revalidate(key, scopeKey, compute);
        return {
          value: existing.value,
          cache: { state: "stale", stale: true, degraded: false, ageMs },
        };
      }
      // Past the stale bound — drop it so it can never be served again.
      this.entries.delete(key);
    }

    // Coalesce concurrent cold reads for the same key.
    const pending = this.inflight.get(key) as Promise<CachedAnalyticsResult<T>> | undefined;
    if (pending) {
      const result = await pending;
      return { value: result.value, cache: { ...result.cache, state: "coalesced" } };
    }

    const promise = this.computeWithLock(key, scopeKey, compute);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async computeWithLock<T>(
    key: string,
    scopeKey: string,
    compute: () => Promise<T>
  ): Promise<CachedAnalyticsResult<T>> {
    const lockKey = `${key}|lock`;
    let acquired = false;
    try {
      acquired = await this.lock.acquire(lockKey, this.lockWaitMs);
    } catch {
      acquired = false;
    }

    if (!acquired) {
      // Another process is computing. Wait briefly for it to publish, then
      // fall back to computing locally rather than failing the request.
      const deadline = this.now() + this.lockWaitMs;
      while (this.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        const published = this.readEntry<T>(key, scopeKey);
        if (published) {
          const ageMs = this.now() - published.storedAt;
          if (ageMs <= this.ttlMs + this.staleMs) {
            return {
              value: published.value,
              cache: {
                state: "coalesced",
                stale: ageMs > this.ttlMs,
                degraded: false,
                ageMs,
              },
            };
          }
        }
      }
    }

    try {
      const value = await compute();
      this.entries.set(key, { value, storedAt: this.now(), scopeKey });
      return {
        value,
        cache: { state: "miss", stale: false, degraded: false, ageMs: 0 },
      };
    } catch (error) {
      // Failure path: serve the last known entry if still within bounds.
      const fallback = this.readEntry<T>(key, scopeKey);
      if (fallback) {
        const ageMs = this.now() - fallback.storedAt;
        if (ageMs <= this.ttlMs + this.staleMs) {
          return {
            value: fallback.value,
            cache: {
              state: "stale",
              stale: true,
              degraded: true,
              degradedReason: error instanceof Error ? error.message : "backend_error",
              ageMs,
            },
          };
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new AnalyticsUnavailableError(
        `Analytics backend unavailable and no entry within the stale bound: ${detail}`,
        error
      );
    } finally {
      if (acquired) {
        try {
          await this.lock.release(lockKey);
        } catch {
          // Lock release failures are non-fatal; the TTL will expire it.
        }
      }
    }
  }

  /** Refresh an entry in the background, swallowing failures. */
  private async revalidate<T>(
    key: string,
    scopeKey: string,
    compute: () => Promise<T>
  ): Promise<void> {
    if (this.inflight.has(key)) return;
    const promise = this.computeWithLock(key, scopeKey, compute).catch(() => undefined);
    this.inflight.set(key, promise);
    try {
      await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Drop all entries (used by tests and on tenant offboarding). */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}

// ── Default data source (reads from env-configured Stellar RPC) ───────────────

/**
 * Production data source that fetches stream events from the Stellar RPC.
 * Returns mock data in test / development environments to avoid network calls.
 */
export class DefaultStreamDataSource implements StreamDataSource {
  async getStreams(): Promise<StreamRecord[]> {
    // In production, this would call the Stellar RPC getEvents API and
    // cross-reference with an indexer for metadata tags.
    // Returning a well-typed empty array here so the gateway is functional
    // out of the box — replace with real data fetching in production.
    if (process.env.NODE_ENV === "test") {
      return [];
    }

    // Real implementation sketch:
    // const rpcUrl = network === "mainnet"
    //   ? "https://soroban.stellar.org"
    //   : "https://soroban-testnet.stellar.org";
    // const rpc = new Server(rpcUrl);
    // const events = await rpc.getEvents({ ... });
    // return parseStreamEvents(events);
    return [];
  }
}

// ── Helper functions ──────────────────────────────────────────────────────────

function toBigInt(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}

function toUsd(amount: string, usdEquivalent?: string): bigint {
  if (usdEquivalent) return toBigInt(usdEquivalent);
  return toBigInt(amount); // 1:1 fallback
}

/**
 * Build per-asset aggregate metrics from a list of stream records.
 */
function aggregateByAsset(streams: StreamRecord[]): AssetMetrics[] {
  const map = new Map<string, {
    symbol: string;
    volume: bigint;
    count: number;
    senders: Set<string>;
    recipients: Set<string>;
  }>();

  for (const s of streams) {
    const existing = map.get(s.asset);
    if (existing) {
      existing.volume += toBigInt(s.totalAmount);
      existing.count++;
      existing.senders.add(s.sender);
      existing.recipients.add(s.recipient);
    } else {
      map.set(s.asset, {
        symbol: s.symbol ?? s.asset.slice(0, 8),
        volume: toBigInt(s.totalAmount),
        count: 1,
        senders: new Set([s.sender]),
        recipients: new Set([s.recipient]),
      });
    }
  }

  return Array.from(map.entries()).map(([asset, m]) => ({
    asset,
    symbol: m.symbol,
    totalVolume: m.volume.toString(),
    streamCount: m.count,
    uniqueSenders: m.senders.size,
    uniqueRecipients: m.recipients.size,
    averageStreamAmount: m.count > 0 ? (m.volume / BigInt(m.count)).toString() : "0",
  }));
}

/**
 * Apply common time/status/asset filters to a stream list.
 */
function filterStreams(
  streams: StreamRecord[],
  filter: { asset?: string; status?: string; fromTimestamp?: number; toTimestamp?: number }
): StreamRecord[] {
  return streams.filter((s) => {
    if (filter.asset && s.asset !== filter.asset) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.fromTimestamp && s.createdAt < filter.fromTimestamp) return false;
    if (filter.toTimestamp && s.createdAt > filter.toTimestamp) return false;
    return true;
  });
}



// ── Analytics Service ─────────────────────────────────────────────────────────

export class AnalyticsService {
  private readonly cache: AnalyticsCache;

  constructor(
    private readonly dataSource: StreamDataSource = new DefaultStreamDataSource(),
    cache?: AnalyticsCache
  ) {
    this.cache = cache ?? new AnalyticsCache();
  }

  /**
   * Load streams through the single-flight cache, scoped to the caller.
   *
   * The cache key includes the tenant, principal scope, network and any
   * filters, so entries are never reused across permission boundaries.
   */
  private async loadStreams(
    network: string,
    scope: AnalyticsCacheScope,
    filters: Record<string, unknown> = {}
  ): Promise<CachedAnalyticsResult<StreamRecord[]>> {
    const key = buildAnalyticsCacheKey("streams", scope, { network, ...filters });
    const scopeKey = `${scope.tenantId}|${scope.principalScope}`;
    return this.cache.getOrCompute(key, scopeKey, () => this.dataSource.getStreams(network));
  }

  getMetricDefinitions(): Record<AnalyticsMetricKey, AnalyticsMetricDefinition> {
    return getAnalyticsMetricDefinitions();
  }

  // ── globalMetrics ─────────────────────────────────────────────────────────

  async getGlobalMetrics(
    network = "testnet",
    scope: AnalyticsCacheScope = { tenantId: "default", principalScope: "anon" }
  ): Promise<GlobalMetrics> {
    const { value: streams } = await this.loadStreams(network, scope);

    const activeStreams = streams.filter((s) => s.status === "Active").length;
    const totalVolumeUsd = streams
      .reduce((acc, s) => acc + toUsd(s.totalAmount, s.usdEquivalent), 0n)
      .toString();

    const assets = new Set(streams.map((s) => s.asset));
    const regions = new Set(streams.map((s) => s.region ?? "GLOBAL").filter(Boolean));
    const categories = new Set(streams.map((s) => s.category).filter(Boolean));

    const timestamps = streams.map((s) => s.createdAt).filter(Boolean);
    const latestStreamAt = timestamps.length > 0 ? Math.max(...timestamps) : null;

    return {
      totalStreams: streams.length,
      activeStreams,
      totalVolumeUsd,
      uniqueAssets: assets.size,
      uniqueRegions: regions.size,
      uniqueCategories: categories.size,
      latestStreamAt,
    };
  }

  async getGlobalMetricsWithAuthority(
    network = "testnet",
    options: {
      now?: number;
      maxStalenessMs?: number;
      ledgerSnapshot?: AuthoritativeLedgerSnapshot | null;
    } = {},
  ): Promise<GlobalMetricsWithAuthority> {
    const metrics = await this.getGlobalMetrics(network);
    const now = options.now ?? Date.now();
    const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_MAX_AUTHORITY_STALENESS_MS;

    let authority: AnalyticsAuthorityReport;
    if (options.ledgerSnapshot !== undefined) {
      authority = validateStreamMetricsAgainstLedger(metrics, options.ledgerSnapshot, {
        now,
        maxStalenessMs,
      });
    } else if (typeof this.dataSource.getLedgerSnapshot === "function") {
      try {
        const snapshot = await this.dataSource.getLedgerSnapshot(network);
        authority = validateStreamMetricsAgainstLedger(metrics, snapshot, {
          now,
          maxStalenessMs,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Authority source unreachable";
        authority = {
          state: "unavailable",
          isAuthoritative: false,
          isFresh: false,
          ledgerSequence: null,
          ledgerClosedAt: null,
          checkedAt: now,
          stalenessMs: null,
          maxStalenessMs,
          reason: "authority_error",
          message: `Authoritative stream ledger query failed: ${detail}`,
          discrepancies: [],
        };
      }
    } else {
      authority = validateStreamMetricsAgainstLedger(metrics, null, {
        now,
        maxStalenessMs,
      });
    }

    return {
      ...metrics,
      authority,
      metricDefinitions: getAnalyticsMetricDefinitions(),
    };
  }

  // ── regionMetrics ─────────────────────────────────────────────────────────

  async getRegionMetrics(
    filter?: RegionFilter,
    pagination?: PaginationInput,
    network = "testnet",
    scope: AnalyticsCacheScope = { tenantId: "default", principalScope: "anon" }
  ): Promise<PaginatedResult<RegionMetrics>> {
    const { value: allStreams } = await this.loadStreams(network, scope, {
      kind: "region",
      ...(filter ?? {}),
    });
    const streams = filterStreams(allStreams, filter ?? {});

    // Group by region
    const regionMap = new Map<string, StreamRecord[]>();
    for (const s of streams) {
      const region = s.region ?? "GLOBAL";
      if (filter?.region && region !== filter.region) continue;
      const existing = regionMap.get(region) ?? [];
      existing.push(s);
      regionMap.set(region, existing);
    }

    const results: RegionMetrics[] = Array.from(regionMap.entries()).map(([region, ss]) => {
      const totalVolumeUsd = ss
        .reduce((acc, s) => acc + toUsd(s.totalAmount, s.usdEquivalent), 0n)
        .toString();

      const projectCount = new Set(ss.map((s) => s.recipient)).size;

      return {
        region,
        totalStreams: ss.length,
        totalVolumeUsd,
        projectCount,
        assetBreakdown: aggregateByAsset(ss),
      };
    });

    // Stable ordering: totalStreams desc, then region asc as a tiebreaker.
    results.sort(
      (a, b) =>
        b.totalStreams - a.totalStreams || compareStrings(a.region, b.region, "ASC")
    );

    return paginateWithInfo(results, pagination);
  }

  // ── categoryMetrics ───────────────────────────────────────────────────────

  async getCategoryMetrics(
    filter?: CategoryFilter,
    pagination?: PaginationInput,
    network = "testnet",
    scope: AnalyticsCacheScope = { tenantId: "default", principalScope: "anon" }
  ): Promise<PaginatedResult<CategoryMetrics>> {
    const { value: allStreams } = await this.loadStreams(network, scope, {
      kind: "category",
      ...(filter ?? {}),
    });
    const streams = filterStreams(allStreams, filter ?? {});

    const total = streams.length;

    // Group by category
    const categoryMap = new Map<string, StreamRecord[]>();
    for (const s of streams) {
      const category = s.category ?? "uncategorized";
      if (filter?.category && category !== filter.category) continue;
      const existing = categoryMap.get(category) ?? [];
      existing.push(s);
      categoryMap.set(category, existing);
    }

    const results: CategoryMetrics[] = Array.from(categoryMap.entries()).map(
      ([category, ss]) => {
        const totalVolumeUsd = ss
          .reduce((acc, s) => acc + toUsd(s.totalAmount, s.usdEquivalent), 0n)
          .toString();

        return {
          category,
          totalStreams: ss.length,
          totalVolumeUsd,
          sharePercent: total > 0 ? Number(((ss.length / total) * 100).toFixed(2)) : 0,
          assetBreakdown: aggregateByAsset(ss),
        };
      }
    );

    // Stable ordering: totalStreams desc, then category asc as a tiebreaker.
    results.sort(
      (a, b) =>
        b.totalStreams - a.totalStreams || compareStrings(a.category, b.category, "ASC")
    );
    return paginateWithInfo(results, pagination);
  }

  // ── assetMetrics ──────────────────────────────────────────────────────────

  async getAssetMetrics(
    filter?: AssetFilter,
    pagination?: PaginationInput,
    network = "testnet",
    scope: AnalyticsCacheScope = { tenantId: "default", principalScope: "anon" }
  ): Promise<PaginatedResult<AssetMetrics>> {
    const { value: allStreams } = await this.loadStreams(network, scope, {
      kind: "asset",
      ...(filter ?? {}),
    });
    const streams = filterStreams(allStreams, filter ?? {});

    const results = aggregateByAsset(streams);
    // Stable ordering: totalVolume desc, then asset asc as a tiebreaker.
    results.sort(
      (a, b) =>
        compareBigInts(toBigInt(a.totalVolume), toBigInt(b.totalVolume), "DESC") ||
        compareStrings(a.asset, b.asset, "ASC")
    );
    return paginateWithInfo(results, pagination);
  }

  // ── sponsorImpact ────────────────────────────────────────────────────────

  /**
   * Compute a sponsor's impact (estimated CO2 offset) relative to the global
   * average sponsor, including a percentile ranking (top 10%, etc.).
   *
   * A "sponsor" is any address that has funded streams (a stream sender).
   * Impact is estimated from the sponsor's total funded volume using the
   * platform-wide CO2 conversion factor.
   *
   * @param address - Stellar address of the sponsor to compare.
   * @param network - Stellar network to aggregate over (default `testnet`).
   */
  async getSponsorImpact(
    address: string,
    network = "testnet",
    scope: AnalyticsCacheScope = { tenantId: "default", principalScope: "anon" }
  ): Promise<SponsorImpact> {
    const { value: streams } = await this.loadStreams(network, scope, {
      kind: "sponsor",
      address,
    });

    // Aggregate total funded volume (USDC-equivalent) per sponsor (sender).
    const volumeBySponsor = new Map<string, bigint>();
    for (const s of streams) {
      const usd = toUsd(s.totalAmount, s.usdEquivalent);
      volumeBySponsor.set(s.sender, (volumeBySponsor.get(s.sender) ?? 0n) + usd);
    }

    const globalSponsorCount = volumeBySponsor.size;
    const myVolumeUsd = volumeBySponsor.get(address) ?? 0n;

    const totalVolumeUsd = [...volumeBySponsor.values()].reduce(
      (acc, v) => acc + v,
      0n
    );
    const globalAverageVolumeUsd =
      globalSponsorCount > 0 ? totalVolumeUsd / BigInt(globalSponsorCount) : 0n;

    // Percentile: position-based rank within the descending order of sponsor
    // volumes. The top sponsor scores 100, the bottom scores 0, and tied
    // sponsors share the best position among them (e.g. two tied leaders both
    // score 100 → "top 1%"). With a single sponsor we define it as 100.
    let percentile: number | null = null;
    if (globalSponsorCount > 0) {
      let position = 0; // 0-based index in descending volume order
      for (const volume of volumeBySponsor.values()) {
        if (volume > myVolumeUsd) position++;
      }
      percentile =
        globalSponsorCount > 1
          ? Math.max(
              0,
              Math.min(
                100,
                Math.round(
                  ((globalSponsorCount - 1 - position) /
                    (globalSponsorCount - 1)) *
                    100
                )
              )
            )
          : 100;
    }

    return {
      address,
      myVolumeUsd: myVolumeUsd.toString(),
      myCo2OffsetKg: toCo2Kg(myVolumeUsd),
      globalAverageVolumeUsd: globalAverageVolumeUsd.toString(),
      globalAverageCo2OffsetKg: toCo2Kg(globalAverageVolumeUsd),
      globalSponsorCount,
      percentile,
      rankingBand: percentile === null ? null : rankingBandForPercentile(percentile),
      co2PerUsdKg: CO2_PER_USD_KG,
    };
  }
}

/** Module-level singleton — shared across all requests in the same process. */
let _defaultService: AnalyticsService | null = null;

export function getAnalyticsService(
  dataSource?: StreamDataSource,
  cache?: AnalyticsCache
): AnalyticsService {
  if (dataSource || cache) return new AnalyticsService(dataSource, cache);
  if (!_defaultService) _defaultService = new AnalyticsService();
  return _defaultService;
}
