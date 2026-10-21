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
}

const states = new Map<string, CampaignAnalyticsState>();
const cache = new Map<string, CampaignAnalyticsCacheEntry>();
const invalidatedAt = new Map<string, number>();

function stateFor(campaignId: string): CampaignAnalyticsState {
  let state = states.get(campaignId);
  if (!state) {
    state = { totalViews: 0, views: new Set(), contributions: [], refunds: 0 };
    states.set(campaignId, state);
  }
  return state;
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
): Promise<void> {
  if (!(await getCampaign(campaignId, dataSource))) throw new Error("Campaign not found");
  const state = stateFor(campaignId);
  state.totalViews += 1;
  state.views.add(viewerId?.trim() || `anonymous:${crypto.randomUUID()}`);
  invalidateCampaignAnalyticsCache(campaignId);
}

export async function recordCampaignContribution(
  campaignId: string,
  amount: string,
  sponsor: string,
  dataSource = getCampaignDataSource(),
): Promise<void> {
  if (!(await getCampaign(campaignId, dataSource))) throw new Error("Campaign not found");
  if (!sponsor?.trim()) throw new Error("sponsor is required");
  stateFor(campaignId).contributions.push({ amount: parseAmount(amount), sponsor: sponsor.trim() });
  invalidateCampaignAnalyticsCache(campaignId);
}

export async function recordCampaignRefund(
  campaignId: string,
  dataSource = getCampaignDataSource(),
): Promise<void> {
  if (!(await getCampaign(campaignId, dataSource))) throw new Error("Campaign not found");
  stateFor(campaignId).refunds += 1;
  invalidateCampaignAnalyticsCache(campaignId);
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
    if (cached && isFresh(cached, now, ttlMs)) return cached.value;
  }

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

  const analytics: CampaignAnalytics = {
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

  cache.set(cacheKey, { value: analytics, cachedAt: now });
  return analytics;
}

export function seedCampaignAnalytics(campaignId: string, state: Partial<CampaignAnalyticsState>): void {
  states.set(campaignId, {
    totalViews: state.totalViews ?? state.views?.size ?? 0,
    views: state.views ?? new Set(),
    contributions: state.contributions ?? [],
    refunds: state.refunds ?? 0,
  });
  invalidateCampaignAnalyticsCache(campaignId);
}

export type { CampaignRecord, PageInfo };
