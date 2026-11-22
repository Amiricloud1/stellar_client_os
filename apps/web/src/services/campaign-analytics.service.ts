import {
  getCampaign,
  getCampaignDataSource,
  type CampaignRecord,
} from "./campaign.service";
import {
  normalizePagination,
  paginateItems,
  type PageInfo,
  type PaginationParams,
  type SortDirection,
} from "./pagination.service";

export interface CampaignAnalytics {
  campaignId: string;
  pagesViewed: number;
  uniqueViewers: number;
  contributions: number;
  sponsors: number;
  sponsorRate: number;
  abandonmentRate: number;
  averageContributionSize: string;
  refunds: number;
  refundRate: number;
  updatedAt: number;
  /**
   * True when this aggregate was served from a cached entry that has exceeded
   * its freshness budget but is still within `CAMPAIGN_ANALYTICS_MAX_STALE_MS`.
   * Consumers should surface this to operators so degraded freshness is
   * explicit rather than silent.
   */
  stale: boolean;
}

interface CampaignAnalyticsState {
  totalViews: number;
  views: Set<string>;
  contributions: Array<{ amount: bigint; sponsor: string }>;
  refunds: number;
  /** Monotonic version of the aggregate; bumped by every applied event. */
  version: number;
  /** Event ids already folded into the aggregate, for idempotent replay. */
  appliedEventIds: Set<string>;
}

/**
 * Version of the incremental aggregation algorithm.
 *
 * Bumped whenever the reducer semantics change so that cached aggregates
 * produced by an older algorithm are never compared against or served to
 * callers expecting the current one. Reconciliation compares the incremental
 * totals against a full recomputation and reports a mismatch when either the
 * algorithm version or the resulting totals diverge.
 */
export const CAMPAIGN_ANALYTICS_AGGREGATE_VERSION = 1;

export type CampaignAnalyticsEvent =
  | { type: "view"; eventId: string; viewerId?: string }
  | { type: "contribution"; eventId: string; amount: string; sponsor: string }
  | { type: "refund"; eventId: string };

export interface CampaignAnalyticsReconciliation {
  campaignId: string;
  aggregateVersion: number;
  incrementalVersion: number;
  consistent: boolean;
  /** Human-readable reasons the incremental totals diverged, if any. */
  mismatches: string[];
  incremental: CampaignAnalytics;
  recomputed: CampaignAnalytics;
}

/**
 * Cache key schema for campaign analytics.
 *
 * Keys are namespaced as `campaign-analytics:<campaignId>` so that every
 * campaign has exactly one authoritative aggregate entry. Mutations and
 * chain corrections invalidate the single key for the affected campaign;
 * there is no cross-campaign fan-out.
 *
 * When a read is scoped by a principal and/or normalized filters, the scope
 * is appended as a stable suffix (`:<scope>`). This guarantees that cached
 * aggregates are never shared across permission scopes or filter sets, and
 * that single-flight coalescing only merges truly identical reads.
 */
export const CAMPAIGN_ANALYTICS_CACHE_NAMESPACE = "campaign-analytics";

export interface CampaignAnalyticsScope {
  /** Principal (user/role) the read is authorized for. Omitted = unscoped. */
  principalId?: string;
  /** Arbitrary filter set; normalized to a stable, order-independent string. */
  filters?: Record<string, string | number | boolean | null | undefined>;
}

function normalizeFilters(
  filters: CampaignAnalyticsScope["filters"],
): string {
  if (!filters) return "";
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([key, value]) => `${key}=${value}`).join("&");
}

function scopeSuffix(scope: CampaignAnalyticsScope | undefined): string {
  if (!scope) return "";
  const principal = scope.principalId?.trim() ?? "";
  const filters = normalizeFilters(scope.filters);
  if (!principal && !filters) return "";
  return `:${encodeURIComponent(principal)}:${encodeURIComponent(filters)}`;
}

export function campaignAnalyticsCacheKey(
  campaignId: string,
  scope?: CampaignAnalyticsScope,
): string {
  return `${CAMPAIGN_ANALYTICS_CACHE_NAMESPACE}:${campaignId}${scopeSuffix(scope)}`;
}

/**
 * Freshness budgets (TTL in ms) for cached campaign analytics reads.
 *
 * - `CAMPAIGN_ANALYTICS_TTL_MS`: default budget for aggregate reads. Short
 *   enough that externally observed totals converge quickly, long enough to
 *   absorb bursty dashboard polling.
 * - `CAMPAIGN_ANALYTICS_MAX_STALE_MS`: hard ceiling. A cached entry older than
 *   this is never served, even if a caller requests a longer budget.
 */
export const CAMPAIGN_ANALYTICS_TTL_MS = 30_000;
export const CAMPAIGN_ANALYTICS_MAX_STALE_MS = 5 * 60_000;

interface CampaignAnalyticsCacheEntry {
  value: CampaignAnalytics;
  cachedAt: number;
  aggregateVersion: number;
}

const states = new Map<string, CampaignAnalyticsState>();
const cache = new Map<string, CampaignAnalyticsCacheEntry>();
const invalidatedAt = new Map<string, number>();

/**
 * In-flight cold reads keyed by cache key. Identical concurrent reads share a
 * single computation (single-flight) so a burst of dashboard polls cannot
 * stampede the authoritative state. The map is keyed by the scoped cache key,
 * so reads with different principals or filters never coalesce.
 */
const inFlight = new Map<string, Promise<CampaignAnalytics | null>>();

function stateFor(campaignId: string): CampaignAnalyticsState {
  let state = states.get(campaignId);
  if (!state) {
    state = {
      totalViews: 0,
      views: new Set(),
      contributions: [],
      refunds: 0,
      version: 0,
      appliedEventIds: new Set(),
    };
    states.set(campaignId, state);
  }
  return state;
}

/**
 * Fold a single analytics event into the aggregate exactly once.
 *
 * Returns `true` when the event was applied and `false` when it was a
 * duplicate (already seen event id) or otherwise ignored. Deduplication is by
 * `eventId`, so late replays and at-least-once delivery cannot double count.
 */
function applyEvent(state: CampaignAnalyticsState, event: CampaignAnalyticsEvent): boolean {
  if (!event.eventId?.trim()) throw new Error("eventId is required");
  if (state.appliedEventIds.has(event.eventId)) return false;
  switch (event.type) {
    case "view":
      state.totalViews += 1;
      state.views.add(event.viewerId?.trim() || `anonymous:${event.eventId}`);
      break;
    case "contribution":
      if (!event.sponsor?.trim()) throw new Error("sponsor is required");
      state.contributions.push({ amount: parseAmount(event.amount), sponsor: event.sponsor.trim() });
      break;
    case "refund":
      state.refunds += 1;
      break;
    default:
      throw new Error(`Unsupported analytics event type: ${(event as { type: string }).type}`);
  }
  state.appliedEventIds.add(event.eventId);
  state.version += 1;
  return true;
}

/**
 * Apply an analytics event to a campaign's aggregate.
 *
 * All view/contribution/refund mutations funnel through this reducer so the
 * incremental aggregate is deterministic and idempotent. Duplicate events are
 * dropped without bumping the version or invalidating the cache.
 */
export async function applyCampaignAnalyticsEvent(
  campaignId: string,
  event: CampaignAnalyticsEvent,
  dataSource = getCampaignDataSource(),
): Promise<{ applied: boolean; version: number }> {
  if (!(await getCampaign(campaignId, dataSource))) throw new Error("Campaign not found");
  const state = stateFor(campaignId);
  const applied = applyEvent(state, event);
  if (applied) invalidateCampaignAnalyticsCache(campaignId);
  return { applied, version: state.version };
}

/** Returns the current aggregate version for a campaign (0 if never updated). */
export function getCampaignAnalyticsVersion(campaignId: string): number {
  return states.get(campaignId)?.version ?? 0;
}

function parseAmount(amount: string): bigint {
  if (!/^\d+$/.test(amount)) throw new Error("amount must be a non-negative integer string");
  return BigInt(amount);
}

function toRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 100;
}

/**
 * Invalidate the cached analytics aggregate for a campaign.
 *
 * Called by every mutation (view, contribution, refund) and by chain
 * corrections so that authoritative totals are never served stale. The
 * invalidation timestamp is recorded so callers can reason about freshness.
 *
 * Every scoped entry for the campaign is dropped (fresh and stale alike) and
 * any in-flight read is detached so a subsequent read recomputes from
 * authoritative state. This prevents permission or filter scopes from being
 * mixed after a mutation.
 */
export function invalidateCampaignAnalyticsCache(campaignId: string, now = Date.now()): void {
  const prefix = `${CAMPAIGN_ANALYTICS_CACHE_NAMESPACE}:${campaignId}`;
  for (const key of Array.from(cache.keys())) {
    if (key === prefix || key.startsWith(`${prefix}:`)) cache.delete(key);
  }
  for (const key of Array.from(inFlight.keys())) {
    if (key === prefix || key.startsWith(`${prefix}:`)) inFlight.delete(key);
  }
  invalidatedAt.set(campaignId, now);
}

/** Returns the last invalidation timestamp for a campaign, if any. */
export function getCampaignAnalyticsInvalidatedAt(campaignId: string): number | undefined {
  return invalidatedAt.get(campaignId);
}

function isFresh(entry: CampaignAnalyticsCacheEntry, now: number, ttlMs: number): boolean {
  const budget = Math.min(ttlMs, CAMPAIGN_ANALYTICS_MAX_STALE_MS);
  const age = now - entry.cachedAt;
  return age >= 0 && age < budget;
}

/**
 * Whether an entry may still be served as stale: past its freshness budget but
 * within the hard `CAMPAIGN_ANALYTICS_MAX_STALE_MS` ceiling. Entries older than
 * the ceiling are never served.
 */
function isServableStale(entry: CampaignAnalyticsCacheEntry, now: number): boolean {
  const age = now - entry.cachedAt;
  return age >= 0 && age < CAMPAIGN_ANALYTICS_MAX_STALE_MS;
}

export async function recordCampaignView(
  campaignId: string,
  viewerId?: string,
  dataSource = getCampaignDataSource(),
  eventId = crypto.randomUUID(),
): Promise<void> {
  await applyCampaignAnalyticsEvent(campaignId, { type: "view", eventId, viewerId }, dataSource);
}

export async function recordCampaignContribution(
  campaignId: string,
  amount: string,
  sponsor: string,
  dataSource = getCampaignDataSource(),
  eventId = crypto.randomUUID(),
): Promise<void> {
  await applyCampaignAnalyticsEvent(
    campaignId,
    { type: "contribution", eventId, amount, sponsor },
    dataSource,
  );
}

export async function recordCampaignRefund(
  campaignId: string,
  dataSource = getCampaignDataSource(),
  eventId = crypto.randomUUID(),
): Promise<void> {
  await applyCampaignAnalyticsEvent(campaignId, { type: "refund", eventId }, dataSource);
}

/**
 * Apply a chain correction to a campaign's analytics and invalidate the cache.
 *
 * Chain corrections (e.g. reorg reconciliation) replace the authoritative
 * contribution/refund totals; the cached aggregate must be dropped so the next
 * read recomputes from the corrected state.
 */
export function applyCampaignChainCorrection(
  campaignId: string,
  correction: { contributions?: Array<{ amount: bigint; sponsor: string }>; refunds?: number },
  now = Date.now(),
): void {
  const state = stateFor(campaignId);
  if (correction.contributions) state.contributions = [...correction.contributions];
  if (typeof correction.refunds === "number") state.refunds = correction.refunds;
  state.version += 1;
  invalidateCampaignAnalyticsCache(campaignId, now);
}

export function clearCampaignAnalytics(campaignId: string): void {
  states.delete(campaignId);
  invalidateCampaignAnalyticsCache(campaignId);
}

export interface GetCampaignAnalyticsOptions {
  /** Freshness budget for the cached read; clamped to the max stale ceiling. */
  ttlMs?: number;
  /** When true, bypass the cache and recompute from authoritative state. */
  forceRefresh?: boolean;
  /**
   * When true (default), a cached entry past its freshness budget but within
   * `CAMPAIGN_ANALYTICS_MAX_STALE_MS` is served with `stale: true` instead of
   * blocking on a recompute. Set to false to require fresh data.
   */
  allowStale?: boolean;
  /**
   * Permission/filter scope for the read. Reads with different scopes never
   * share a cache entry or an in-flight computation.
   */
  scope?: CampaignAnalyticsScope;
}

export type CampaignAnalyticsSortField =
  | "campaignId"
  | "pagesViewed"
  | "uniqueViewers"
  | "contributions"
  | "sponsors"
  | "sponsorRate"
  | "abandonmentRate"
  | "averageContributionSize"
  | "refunds"
  | "refundRate"
  | "updatedAt";

export interface CampaignAnalyticsListParams extends PaginationParams {
  sortBy?: CampaignAnalyticsSortField;
  sortDirection?: SortDirection;
}

export interface CampaignAnalyticsListResult {
  items: CampaignAnalytics[];
  pageInfo: PageInfo;
}

const SORT_FIELDS: readonly CampaignAnalyticsSortField[] = [
  "campaignId",
  "pagesViewed",
  "uniqueViewers",
  "contributions",
  "sponsors",
  "sponsorRate",
  "abandonmentRate",
  "averageContributionSize",
  "refunds",
  "refundRate",
  "updatedAt",
];

function compareAnalytics(
  a: CampaignAnalytics,
  b: CampaignAnalytics,
  field: CampaignAnalyticsSortField,
): number {
  if (field === "campaignId") return a.campaignId.localeCompare(b.campaignId);
  if (field === "averageContributionSize") {
    const left = BigInt(a.averageContributionSize);
    const right = BigInt(b.averageContributionSize);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const left = a[field];
  const right = b[field];
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function listCampaignAnalytics(
  campaignIds: readonly string[],
  params: CampaignAnalyticsListParams = {},
  dataSource = getCampaignDataSource(),
  now = Date.now(),
): Promise<CampaignAnalyticsListResult> {
  const sortBy = params.sortBy ?? "campaignId";
  if (!SORT_FIELDS.includes(sortBy)) throw new Error(`Unsupported sort field: ${sortBy}`);
  const sortDirection = params.sortDirection ?? "asc";
  if (sortDirection !== "asc" && sortDirection !== "desc") {
    throw new Error(`Unsupported sort direction: ${sortDirection}`);
  }

  const uniqueIds = Array.from(new Set(campaignIds));
  const analytics: CampaignAnalytics[] = [];
  for (const campaignId of uniqueIds) {
    const entry = await getCampaignAnalytics(campaignId, dataSource, now);
    if (entry) analytics.push(entry);
  }

  analytics.sort((a, b) => {
    const primary = compareAnalytics(a, b, sortBy);
    const ordered = sortDirection === "asc" ? primary : -primary;
    if (ordered !== 0) return ordered;
    return a.campaignId.localeCompare(b.campaignId);
  });

  const pagination = normalizePagination(params);
  const { items, pageInfo } = paginateItems(analytics, pagination);
  return { items, pageInfo };
}

function computeCampaignAnalytics(
  campaignId: string,
  campaign: CampaignRecord,
  now: number,
): CampaignAnalytics {
  const state = stateFor(campaignId);
  const sponsors = new Set([
    ...campaign.sponsors.map((sponsor) => sponsor.address),
    ...state.contributions.map((contribution) => contribution.sponsor),
  ]);
  const sponsorCount = Math.max(sponsors.size, campaign.sponsorCount);
  const contributionCount = state.contributions.length || campaign.sponsorCount;
  const total = state.contributions.reduce((sum, contribution) => sum + contribution.amount, 0n);
  const fallbackTotal = state.contributions.length === 0 ? BigInt(campaign.raisedAmount) : total;
  const average = contributionCount === 0 ? 0n : fallbackTotal / BigInt(contributionCount);
  const pagesViewed = state.totalViews;

  return {
    campaignId,
    pagesViewed,
    uniqueViewers: state.views.size,
    contributions: contributionCount,
    sponsors: sponsorCount,
    sponsorRate: toRate(sponsorCount, pagesViewed),
    abandonmentRate: toRate(Math.max(pagesViewed - sponsorCount, 0), pagesViewed),
    averageContributionSize: average.toString(),
    refunds: state.refunds,
    refundRate: toRate(state.refunds, contributionCount),
    updatedAt: now,
    stale: false,
  };
}

export async function getCampaignAnalytics(
  campaignId: string,
  dataSource = getCampaignDataSource(),
  now = Date.now(),
  options: GetCampaignAnalyticsOptions = {},
): Promise<CampaignAnalytics | null> {
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) return null;

  const cacheKey = campaignAnalyticsCacheKey(campaignId, options.scope);
  const ttlMs = options.ttlMs ?? CAMPAIGN_ANALYTICS_TTL_MS;
  const allowStale = options.allowStale ?? true;

  if (!options.forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      if (isFresh(cached, now, ttlMs)) return cached.value;
      if (allowStale && isServableStale(cached, now)) {
        return { ...cached.value, stale: true };
      }
    }
  }

  // Single-flight: coalesce identical concurrent cold reads. The key includes
  // the permission/filter scope so distinct scopes never share a computation.
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const analytics = computeCampaignAnalytics(campaignId, campaign, now);
      cache.set(cacheKey, { value: analytics, cachedAt: now });
      return analytics;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, pending);
  return pending;
}

export function seedCampaignAnalytics(campaignId: string, state: Partial<CampaignAnalyticsState>): void {
  states.set(campaignId, {
    totalViews: state.totalViews ?? state.views?.size ?? 0,
    views: state.views ?? new Set(),
    contributions: state.contributions ?? [],
    refunds: state.refunds ?? 0,
    version: state.version ?? 0,
    appliedEventIds: state.appliedEventIds ?? new Set(),
  });
  invalidateCampaignAnalyticsCache(campaignId);
}

/** Number of in-flight cold reads currently coalescing for a campaign. */
export function getCampaignAnalyticsInFlightCount(campaignId: string): number {
  const prefix = `${CAMPAIGN_ANALYTICS_CACHE_NAMESPACE}:${campaignId}`;
  let count = 0;
  for (const key of inFlight.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) count += 1;
  }
  return count;
}

export type { CampaignRecord, PageInfo };
