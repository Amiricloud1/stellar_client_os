import { getCampaignDataSource, type CampaignDataSource, type CampaignRecord } from "./campaign.service";
import {
  CO2_PER_TREE_PER_YEAR_KG,
  DEFAULT_MAX_AUTHORITY_STALENESS_MS,
  getAnalyticsMetricDefinitions,
  validateCampaignMetricsAgainstLedger,
  type AnalyticsAuthorityReport,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricKey,
  type AuthoritativeLedgerDataSource,
  type AuthoritativeLedgerSnapshot,
} from "@/lib/analytics-authority";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
  authority: AnalyticsAuthorityReport;
  metricDefinitions: Record<AnalyticsMetricKey, AnalyticsMetricDefinition>;
}

export interface AdminAnalyticsDashboardOptions {
  /**
   * Optional authoritative ledger source or snapshot.
   * Pass `null` to explicitly simulate missing ledger authority.
   */
  authoritySource?: AuthoritativeLedgerDataSource | AuthoritativeLedgerSnapshot | null;
  /** Maximum allowed ledger age in milliseconds before marking as stale. */
  maxStalenessMs?: number;
  /** Network identifier passed to the authority data source. */
  network?: "testnet" | "mainnet";
}

let defaultAuthoritySource: AuthoritativeLedgerDataSource | AuthoritativeLedgerSnapshot | null | undefined;

export function setAdminAnalyticsAuthoritySource(
  source: AuthoritativeLedgerDataSource | AuthoritativeLedgerSnapshot | null | undefined,
): void {
  defaultAuthoritySource = source;
}

export function getAdminAnalyticsAuthoritySource():
  | AuthoritativeLedgerDataSource
  | AuthoritativeLedgerSnapshot
  | null
  | undefined {
  return defaultAuthoritySource;
}

function isLedgerDataSource(
  source: AuthoritativeLedgerDataSource | AuthoritativeLedgerSnapshot,
): source is AuthoritativeLedgerDataSource {
  return typeof (source as AuthoritativeLedgerDataSource).getLatestLedgerSnapshot === "function";
}

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

async function resolveAuthorityReport(
  metrics: AdminAnalyticsDashboard["metrics"],
  campaigns: CampaignRecord[],
  dataSource: CampaignDataSource,
  now: number,
  options: AdminAnalyticsDashboardOptions,
): Promise<AnalyticsAuthorityReport> {
  const maxStalenessMs = options.maxStalenessMs ?? DEFAULT_MAX_AUTHORITY_STALENESS_MS;
  const configuredSource =
    options.authoritySource !== undefined ? options.authoritySource : defaultAuthoritySource;

  if (configuredSource !== undefined) {
    if (configuredSource === null) {
      return validateCampaignMetricsAgainstLedger(metrics, null, { now, maxStalenessMs });
    }
    try {
      const snapshot = isLedgerDataSource(configuredSource)
        ? await configuredSource.getLatestLedgerSnapshot(options.network ?? "testnet")
        : configuredSource;
      return validateCampaignMetricsAgainstLedger(metrics, snapshot, { now, maxStalenessMs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Authority source unreachable";
      return {
        state: "unavailable",
        isAuthoritative: false,
        isFresh: false,
        ledgerSequence: null,
        ledgerClosedAt: null,
        checkedAt: now,
        stalenessMs: null,
        maxStalenessMs,
        reason: "authority_error",
        message: `Authoritative ledger query failed: ${detail}`,
        discrepancies: [],
      };
    }
  }

  const maybeLedgerCapable = dataSource as CampaignDataSource &
    Partial<AuthoritativeLedgerDataSource>;
  if (typeof maybeLedgerCapable.getLatestLedgerSnapshot === "function") {
    try {
      const snapshot = await maybeLedgerCapable.getLatestLedgerSnapshot(options.network ?? "testnet");
      return validateCampaignMetricsAgainstLedger(metrics, snapshot, { now, maxStalenessMs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Authority source unreachable";
      return {
        state: "unavailable",
        isAuthoritative: false,
        isFresh: false,
        ledgerSequence: null,
        ledgerClosedAt: null,
        checkedAt: now,
        stalenessMs: null,
        maxStalenessMs,
        reason: "authority_error",
        message: `Authoritative ledger query failed: ${detail}`,
        discrepancies: [],
      };
    }
  }

  if (campaigns.length === 0) {
    return validateCampaignMetricsAgainstLedger(metrics, null, { now, maxStalenessMs });
  }

  const latestCampaignTimestamp = Math.max(
    ...campaigns.map((c) => Math.max(c.updatedAt || 0, c.createdAt || 0)),
  );
  const derivedSnapshot: AuthoritativeLedgerSnapshot = {
    ledgerSequence: campaigns.length,
    ledgerClosedAt: latestCampaignTimestamp > 0 ? latestCampaignTimestamp : now,
    network: options.network ?? "testnet",
    campaigns: campaigns.map((c) => ({
      id: c.id,
      status: c.status,
      raisedAmount: c.raisedAmount,
      sponsorCount: c.sponsorCount,
      treeCount: c.treeCount,
    })),
  };

  return validateCampaignMetricsAgainstLedger(metrics, derivedSnapshot, { now, maxStalenessMs });
}

export async function getAdminAnalyticsDashboard(
  dataSource = getCampaignDataSource(),
  now = Date.now(),
  options: AdminAnalyticsDashboardOptions = {},
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

  const metrics: AdminAnalyticsDashboard["metrics"] = {
    activeCampaigns,
    totalTreesPlanted: campaigns.reduce((total, campaign) => total + campaign.treeCount, 0),
    totalCo2SequesteredKg: campaigns.reduce((total, campaign) => total + campaign.treeCount * CO2_PER_TREE_PER_YEAR_KG, 0),
    totalSponsors,
    sponsorGrowthPercent,
    campaignCompletionRate: percentage(completedCampaigns, campaigns.length),
    revenue: sumAmounts(campaigns).toString(),
  };

  const authority = await resolveAuthorityReport(metrics, campaigns, dataSource, now, options);

  return {
    updatedAt: now,
    currencyUnit: "stroops",
    period: "all-time",
    metrics,
    monthlyTrend,
    authority,
    metricDefinitions: getAnalyticsMetricDefinitions(),
  };
}