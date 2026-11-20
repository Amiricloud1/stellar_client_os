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
 */
export const CAMPAIGN_ANALYTICS_CACHE_NAMESPACE = "campaign-analytics";

export function campaignAnalyticsCacheKey(campaignId: string): string {
  return `${CAMPAIGN_ANALYTICS_CACHE_NAMESPACE}:${campaignId}`;
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
 */
export function invalidateCampaignAnalyticsCache(campaignId: string, now = Date.now()): void {
  cache.delete(campaignAnalyticsCacheKey(campaignId));
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

export async function getCampaignAnalytics(
  campaignId: string,
  dataSource = getCampaignDataSource(),
  now = Date.now(),
  options: GetCampaignAnalyticsOptions = {},
): Promise<CampaignAnalytics | null> {
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) return null;

  const cacheKey = campaignAnalyticsCacheKey(campaignId);
  const ttlMs = options.ttlMs ?? CAMPAIGN_ANALYTICS_TTL_MS;
  if (!options.forceRefresh) {
    const cached = cache.get(cacheKey);
    if (
      cached &&
      cached.aggregateVersion === CAMPAIGN_ANALYTICS_AGGREGATE_VERSION &&
      isFresh(cached, now, ttlMs)
    ) {
      return cached.value;
    }
  }

  const analytics = buildAnalytics(campaignId, campaign, stateFor(campaignId), now);
  cache.set(cacheKey, {
    value: analytics,
    cachedAt: now,
    aggregateVersion: CAMPAIGN_ANALYTICS_AGGREGATE_VERSION,
  });
  return analytics;
}

function buildAnalytics(
  campaignId: string,
  campaign: CampaignRecord,
  state: CampaignAnalyticsState,
  now: number,
): CampaignAnalytics {
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
  };
}

/**
 * Rebuild a campaign's aggregate from scratch and compare it against the
 * incrementally maintained totals.
 *
 * This is the authoritative reconciliation path: it replays the supplied event
 * log through a fresh reducer state (deduping by event id, so late and
 * duplicate events are folded exactly once) and reports whether the
 * incremental aggregate matches. When `apply` is true the rebuilt state
 * replaces the incremental state and the cache is invalidated.
 */
export async function recomputeCampaignAnalytics(
  campaignId: string,
  events: readonly CampaignAnalyticsEvent[],
  dataSource = getCampaignDataSource(),
  now = Date.now(),
  options: { apply?: boolean } = {},
): Promise<CampaignAnalyticsReconciliation> {
  const campaign = await getCampaign(campaignId, dataSource);
  if (!campaign) throw new Error("Campaign not found");

  const rebuilt: CampaignAnalyticsState = {
    totalViews: 0,
    views: new Set(),
    contributions: [],
    refunds: 0,
    version: 0,
    appliedEventIds: new Set(),
  };
  for (const event of events) applyEvent(rebuilt, event);

  const incrementalState = stateFor(campaignId);
  const incremental = buildAnalytics(campaignId, campaign, incrementalState, now);
  const recomputed = buildAnalytics(campaignId, campaign, rebuilt, now);

  const mismatches: string[] = [];
  const fields: Array<keyof CampaignAnalytics> = [
    "pagesViewed",
    "uniqueViewers",
    "contributions",
    "sponsors",
    "averageContributionSize",
    "refunds",
  ];
  for (const field of fields) {
    if (incremental[field] !== recomputed[field]) {
      mismatches.push(`${field}: incremental=${incremental[field]} recomputed=${recomputed[field]}`);
    }
  }

  if (options.apply) {
    states.set(campaignId, rebuilt);
    invalidateCampaignAnalyticsCache(campaignId, now);
  }

  return {
    campaignId,
    aggregateVersion: CAMPAIGN_ANALYTICS_AGGREGATE_VERSION,
    incrementalVersion: incrementalState.version,
    consistent: mismatches.length === 0,
    mismatches,
    incremental,
    recomputed,
  };
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

export type { CampaignRecord, PageInfo };
