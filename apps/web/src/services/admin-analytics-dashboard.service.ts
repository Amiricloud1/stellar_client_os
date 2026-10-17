import { getCampaignDataSource, type CampaignRecord } from "./campaign.service";

const CO2_PER_TREE_PER_YEAR_KG = 21;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Shared pagination/sorting contract (issue #59).
 *
 * All list endpoints (campaigns, backers, audit, analytics) expose the same
 * request shape and the same `PageInfo` response metadata so clients can page
 * through results deterministically. Ordering is always stable: ties are
 * broken by a secondary key so repeated requests return identical pages.
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export type SortDirection = "asc" | "desc";

export interface PaginationParams {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Page size, clamped to [1, MAX_PAGE_LIMIT]. Defaults to DEFAULT_PAGE_LIMIT. */
  limit?: number;
  /** Field to sort by; must be one of the endpoint's allowed sort fields. */
  sortBy?: string;
  /** Sort direction. Defaults to "desc". */
  sortDirection?: SortDirection;
}

export interface PageInfo {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  sortBy: string;
  sortDirection: SortDirection;
}

export interface PaginatedResult<T> {
  items: T[];
  pageInfo: PageInfo;
}

export interface NormalizedPagination {
  page: number;
  limit: number;
  sortBy: string;
  sortDirection: SortDirection;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const truncated = Math.trunc(parsed);
  return truncated >= 1 ? truncated : fallback;
}

/**
 * Normalizes pagination params against an endpoint's allowed sort fields.
 * Unknown sort fields fall back to `defaultSortBy`; invalid page/limit values
 * fall back to safe defaults and limits are clamped to MAX_PAGE_LIMIT.
 */
export function normalizePagination(
  params: PaginationParams = {},
  allowedSortFields: readonly string[],
  defaultSortBy: string,
): NormalizedPagination {
  const sortBy = params.sortBy && allowedSortFields.includes(params.sortBy)
    ? params.sortBy
    : defaultSortBy;
  const sortDirection: SortDirection = params.sortDirection === "asc" ? "asc" : "desc";
  return {
    page: toPositiveInt(params.page, 1),
    limit: Math.min(toPositiveInt(params.limit, DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT),
    sortBy,
    sortDirection,
  };
}

export function buildPageInfo(
  totalItems: number,
  pagination: NormalizedPagination,
): PageInfo {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pagination.limit);
  return {
    page: pagination.page,
    limit: pagination.limit,
    totalItems,
    totalPages,
    hasNextPage: pagination.page < totalPages,
    hasPreviousPage: pagination.page > 1 && totalPages > 0,
    sortBy: pagination.sortBy,
    sortDirection: pagination.sortDirection,
  };
}

/**
 * Slices an already-sorted array into a page and attaches PageInfo metadata.
 * Callers must sort with a stable comparator before calling this.
 */
export function paginateSorted<T>(
  sortedItems: readonly T[],
  pagination: NormalizedPagination,
): PaginatedResult<T> {
  const start = (pagination.page - 1) * pagination.limit;
  return {
    items: sortedItems.slice(start, start + pagination.limit),
    pageInfo: buildPageInfo(sortedItems.length, pagination),
  };
}

export interface AdminAnalyticsDashboard {
  updatedAt: number;
  currencyUnit: "stroops";
  period: "all-time";
  metrics: {
    activeCampaigns: number;
    totalTreesPlanted: number;
    totalCo2SequesteredKg: number;
    totalSponsors: number;
    sponsorGrowthPercent: number;
    campaignCompletionRate: number;
    revenue: string;
  };
  monthlyTrend: Array<{
    month: string;
    campaigns: number;
    sponsors: number;
    revenue: string;
  }>;
}

export interface AdminAnalyticsMonthlyTrendItem {
  month: string;
  campaigns: number;
  sponsors: number;
  revenue: string;
}

export type AdminAnalyticsMonthlyTrendSortField = "month" | "campaigns" | "sponsors" | "revenue";

export const ADMIN_ANALYTICS_TREND_SORT_FIELDS: readonly AdminAnalyticsMonthlyTrendSortField[] = [
  "month",
  "campaigns",
  "sponsors",
  "revenue",
];

export interface AdminAnalyticsTrendQuery extends PaginationParams {
  sortBy?: AdminAnalyticsMonthlyTrendSortField;
}

export type AdminAnalyticsTrendPage = PaginatedResult<AdminAnalyticsMonthlyTrendItem>;

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10;
}

function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function addMonths(month: string, count: number): string {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}

function sumAmounts(campaigns: CampaignRecord[]): bigint {
  return campaigns.reduce((total, campaign) => {
    return total + (/^\d+$/.test(campaign.raisedAmount) ? BigInt(campaign.raisedAmount) : 0n);
  }, 0n);
}

export async function getAdminAnalyticsDashboard(
  dataSource = getCampaignDataSource(),
  now = Date.now(),
): Promise<AdminAnalyticsDashboard> {
  const campaigns = await dataSource.getCampaigns();
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "ACTIVE").length;
  const completedCampaigns = campaigns.filter((campaign) => campaign.status === "COMPLETED").length;
  const totalSponsors = campaigns.reduce((total, campaign) => total + campaign.sponsorCount, 0);
  const recentSponsors = campaigns
    .filter((campaign) => campaign.createdAt >= now - WINDOW_MS)
    .reduce((total, campaign) => total + campaign.sponsorCount, 0);
  const previousSponsors = campaigns
    .filter((campaign) => campaign.createdAt >= now - WINDOW_MS * 2 && campaign.createdAt < now - WINDOW_MS)
    .reduce((total, campaign) => total + campaign.sponsorCount, 0);
  const sponsorGrowthPercent = previousSponsors === 0
    ? (recentSponsors > 0 ? 100 : 0)
    : percentage(recentSponsors - previousSponsors, previousSponsors);

  const currentMonth = monthKey(now);
  const monthlyTrend = Array.from({ length: 6 }, (_, index) => addMonths(currentMonth, index - 5)).map((month) => {
    const monthCampaigns = campaigns.filter((campaign) => monthKey(campaign.createdAt) === month);
    return {
      month,
      campaigns: monthCampaigns.length,
      sponsors: monthCampaigns.reduce((total, campaign) => total + campaign.sponsorCount, 0),
      revenue: sumAmounts(monthCampaigns).toString(),
    };
  });

  return {
    updatedAt: now,
    currencyUnit: "stroops",
    period: "all-time",
    metrics: {
      activeCampaigns,
      totalTreesPlanted: campaigns.reduce((total, campaign) => total + campaign.treeCount, 0),
      totalCo2SequesteredKg: campaigns.reduce((total, campaign) => total + campaign.treeCount * CO2_PER_TREE_PER_YEAR_KG, 0),
      totalSponsors,
      sponsorGrowthPercent,
      campaignCompletionRate: percentage(completedCampaigns, campaigns.length),
      revenue: sumAmounts(campaigns).toString(),
    },
    monthlyTrend,
  };
}

function compareTrendItems(
  a: AdminAnalyticsMonthlyTrendItem,
  b: AdminAnalyticsMonthlyTrendItem,
  sortBy: AdminAnalyticsMonthlyTrendSortField,
): number {
  if (sortBy === "month") {
    return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
  }
  if (sortBy === "revenue") {
    const left = /^\d+$/.test(a.revenue) ? BigInt(a.revenue) : 0n;
    const right = /^\d+$/.test(b.revenue) ? BigInt(b.revenue) : 0n;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const left = a[sortBy];
  const right = b[sortBy];
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Returns a page of the admin analytics monthly trend series using the shared
 * pagination/sorting contract. Ordering is stable: ties on the requested sort
 * field are broken by `month` ascending so identical requests always return
 * identical pages.
 */
export async function getAdminAnalyticsTrendPage(
  query: AdminAnalyticsTrendQuery = {},
  dataSource = getCampaignDataSource(),
  now = Date.now(),
): Promise<AdminAnalyticsTrendPage> {
  const pagination = normalizePagination(
    query,
    ADMIN_ANALYTICS_TREND_SORT_FIELDS,
    "month",
  ) as NormalizedPagination & { sortBy: AdminAnalyticsMonthlyTrendSortField };

  const dashboard = await getAdminAnalyticsDashboard(dataSource, now);
  const direction = pagination.sortDirection === "asc" ? 1 : -1;
  const sorted = [...dashboard.monthlyTrend].sort((a, b) => {
    const primary = compareTrendItems(a, b, pagination.sortBy) * direction;
    if (primary !== 0) return primary;
    return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
  });

  return paginateSorted(sorted, pagination);
}