/**
 * Authoritative Ledger Validation & Metric Definitions (issue #82)
 *
 * Documents the authoritative data source and deterministic formula for each
 * platform and stream analytics metric, and validates computed analytics
 * snapshots against authoritative Stellar/Soroban ledger state.
 *
 * When authoritative ledger state is missing, unreachable, stale, or disagrees
 * with off-chain aggregated metrics, this module produces an explicit
 * `AnalyticsAuthorityReport` so API consumers and UI views can surface
 * freshness or unavailable states rather than silently displaying unverified
 * figures.
 */

export type AnalyticsMetricKey =
  | "activeCampaigns"
  | "totalTreesPlanted"
  | "totalCo2SequesteredKg"
  | "totalSponsors"
  | "sponsorGrowthPercent"
  | "campaignCompletionRate"
  | "revenue"
  | "totalStreams"
  | "activeStreams"
  | "totalVolumeUsd"
  | "uniqueAssets"
  | "uniqueRegions"
  | "uniqueCategories"
  | "averageStreamAmount"
  | "sponsorImpact";

export type AuthorityOriginType =
  | "on-chain-ledger"
  | "indexed-ledger-events"
  | "derived-estimate";

export type MetricUnit =
  | "count"
  | "trees"
  | "kg_co2e"
  | "percent"
  | "stroops"
  | "usd";

export interface AnalyticsMetricDefinition {
  key: AnalyticsMetricKey;
  label: string;
  dataSource: string;
  authorityType: AuthorityOriginType;
  unit: MetricUnit;
  formula: string;
  knownFixtureExample: {
    inputs: Record<string, string | number>;
    expected: string | number;
  };
}

export const CO2_PER_TREE_PER_YEAR_KG = 21;
export const DEFAULT_MAX_AUTHORITY_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Authoritative catalog of data sources and deterministic formulas per metric.
 */
export const ANALYTICS_METRIC_DEFINITIONS: Readonly<
  Record<AnalyticsMetricKey, AnalyticsMetricDefinition>
> = {
  activeCampaigns: {
    key: "activeCampaigns",
    label: "Active campaigns",
    dataSource: "Soroban campaign contract instance storage (status == ACTIVE)",
    authorityType: "on-chain-ledger",
    unit: "count",
    formula: "count(c in campaigns where c.status === 'ACTIVE')",
    knownFixtureExample: {
      inputs: { totalCampaigns: 4, activeCount: 2, completedCount: 1, draftCount: 1 },
      expected: 2,
    },
  },
  totalTreesPlanted: {
    key: "totalTreesPlanted",
    label: "Trees planted",
    dataSource: "Soroban campaign contract verified tree counter (campaign.treeCount)",
    authorityType: "on-chain-ledger",
    unit: "trees",
    formula: "sum(c.treeCount for c in campaigns)",
    knownFixtureExample: {
      inputs: { campaignATrees: 120, campaignBTrees: 80, campaignCTrees: 50 },
      expected: 250,
    },
  },
  totalCo2SequesteredKg: {
    key: "totalCo2SequesteredKg",
    label: "CO2 sequestered",
    dataSource:
      "Derived from Soroban verified tree count using standard annual uptake factor (21 kg CO2/tree/yr)",
    authorityType: "derived-estimate",
    unit: "kg_co2e",
    formula: "sum(c.treeCount * 21 for c in campaigns)",
    knownFixtureExample: {
      inputs: { totalTreesPlanted: 250, co2PerTreePerYearKg: 21 },
      expected: 5250,
    },
  },
  totalSponsors: {
    key: "totalSponsors",
    label: "Total sponsors",
    dataSource: "Soroban campaign contract sponsorship ledger (campaign.sponsorCount)",
    authorityType: "on-chain-ledger",
    unit: "count",
    formula: "sum(c.sponsorCount for c in campaigns)",
    knownFixtureExample: {
      inputs: { campaignASponsors: 10, campaignBSponsors: 15, campaignCSponsors: 5 },
      expected: 30,
    },
  },
  sponsorGrowthPercent: {
    key: "sponsorGrowthPercent",
    label: "Sponsor growth",
    dataSource:
      "Soroban campaign sponsorship ledger windowed over trailing 30d vs prior 30d [now - 60d, now - 30d)",
    authorityType: "indexed-ledger-events",
    unit: "percent",
    formula:
      "previousSponsors === 0 ? (recentSponsors > 0 ? 100 : 0) : round(((recentSponsors - previousSponsors) / previousSponsors) * 1000) / 10",
    knownFixtureExample: {
      inputs: { recentSponsors: 15, previousSponsors: 10 },
      expected: 50,
    },
  },
  campaignCompletionRate: {
    key: "campaignCompletionRate",
    label: "Completion rate",
    dataSource: "Soroban campaign contract status ledger (COMPLETED vs total campaigns)",
    authorityType: "on-chain-ledger",
    unit: "percent",
    formula:
      "campaigns.length === 0 ? 0 : round((count(c.status === 'COMPLETED') / campaigns.length) * 1000) / 10",
    knownFixtureExample: {
      inputs: { completedCampaigns: 1, totalCampaigns: 3 },
      expected: 33.3,
    },
  },
  revenue: {
    key: "revenue",
    label: "Revenue",
    dataSource: "Soroban campaign escrow & contribution ledger (campaign.raisedAmount in stroops)",
    authorityType: "on-chain-ledger",
    unit: "stroops",
    formula: "sum(BigInt(c.raisedAmount) for c in campaigns where /^\\d+$/.test(c.raisedAmount))",
    knownFixtureExample: {
      inputs: { campaignARaisedStroops: "150000000", campaignBRaisedStroops: "250000000" },
      expected: "400000000",
    },
  },
  totalStreams: {
    key: "totalStreams",
    label: "Total payment streams",
    dataSource: "Soroban payment_stream contract getEvents / stream state entries",
    authorityType: "on-chain-ledger",
    unit: "count",
    formula: "count(s in streams)",
    knownFixtureExample: {
      inputs: { active: 2, completed: 1, paused: 1, canceled: 1 },
      expected: 5,
    },
  },
  activeStreams: {
    key: "activeStreams",
    label: "Active payment streams",
    dataSource: "Soroban payment_stream contract instance storage (status == Active)",
    authorityType: "on-chain-ledger",
    unit: "count",
    formula: "count(s in streams where s.status === 'Active')",
    knownFixtureExample: {
      inputs: { totalStreams: 5, activeCount: 2 },
      expected: 2,
    },
  },
  totalVolumeUsd: {
    key: "totalVolumeUsd",
    label: "Total stream volume (USD)",
    dataSource:
      "Soroban payment_stream contract totalAmount normalized via oracle USD equivalent",
    authorityType: "indexed-ledger-events",
    unit: "usd",
    formula: "sum(BigInt(s.usdEquivalent ?? s.totalAmount) for s in streams)",
    knownFixtureExample: {
      inputs: { stream1Usd: "100", stream2Usd: "200", stream3Usd: "50" },
      expected: "350",
    },
  },
  uniqueAssets: {
    key: "uniqueAssets",
    label: "Unique streamed assets",
    dataSource: "Soroban payment_stream contract token contract addresses (s.asset)",
    authorityType: "on-chain-ledger",
    unit: "count",
    formula: "cardinality(set(s.asset for s in streams))",
    knownFixtureExample: {
      inputs: { usdcStreams: 3, xlmStreams: 2 },
      expected: 2,
    },
  },
  uniqueRegions: {
    key: "uniqueRegions",
    label: "Unique regions",
    dataSource: "Off-chain campaign/stream indexer ISO 3166-1 alpha-2 region tags (fallback 'GLOBAL')",
    authorityType: "indexed-ledger-events",
    unit: "count",
    formula: "cardinality(set((s.region ?? 'GLOBAL') for s in streams))",
    knownFixtureExample: {
      inputs: { ngStreams: 2, ghStreams: 2, untaggedStreams: 1 },
      expected: 3,
    },
  },
  uniqueCategories: {
    key: "uniqueCategories",
    label: "Unique categories",
    dataSource: "Off-chain campaign/stream indexer category tags (excluding untagged)",
    authorityType: "indexed-ledger-events",
    unit: "count",
    formula: "cardinality(set(s.category for s in streams where Boolean(s.category)))",
    knownFixtureExample: {
      inputs: { climate: 2, education: 1, health: 1, untagged: 1 },
      expected: 3,
    },
  },
  averageStreamAmount: {
    key: "averageStreamAmount",
    label: "Average stream amount",
    dataSource: "Soroban payment_stream contract per-asset totalAmount in stroops",
    authorityType: "on-chain-ledger",
    unit: "stroops",
    formula: "streamCount > 0 ? (sum(BigInt(s.totalAmount)) / BigInt(streamCount)).toString() : '0'",
    knownFixtureExample: {
      inputs: { totalVolumeStroops: "3750000000", streamCount: 3 },
      expected: "1250000000",
    },
  },
  sponsorImpact: {
    key: "sponsorImpact",
    label: "Sponsor CO2 & percentile impact",
    dataSource:
      "Soroban payment_stream sender volume aggregated by sender address + CO2_PER_USD_KG conversion",
    authorityType: "derived-estimate",
    unit: "kg_co2e",
    formula:
      "myCo2OffsetKg = round(Number(myVolumeUsd) * CO2_PER_USD_KG * 10) / 10; percentile = round(((globalSponsorCount - 1 - strictlyGreaterCount) / (globalSponsorCount - 1)) * 100)",
    knownFixtureExample: {
      inputs: { myVolumeUsd: "175", globalSponsorCount: 4, strictlyGreaterCount: 1, co2PerUsdKg: 1 },
      expected: 67,
    },
  },
};

export function getAnalyticsMetricDefinitions(): Record<
  AnalyticsMetricKey,
  AnalyticsMetricDefinition
> {
  return { ...ANALYTICS_METRIC_DEFINITIONS };
}

export interface AuthoritativeLedgerCampaignRecord {
  id: string;
  status: "DRAFT" | "PENDING_VERIFICATION" | "ACTIVE" | "PAUSED" | "COMPLETED" | "FAILED";
  raisedAmount: string;
  sponsorCount: number;
  treeCount: number;
}

export interface AuthoritativeLedgerStreamSummary {
  totalStreams: number;
  activeStreams: number;
  totalVolumeUsd?: string;
  uniqueAssets?: number;
}

export interface AuthoritativeLedgerSnapshot {
  /** Monotonically increasing Stellar ledger sequence number (> 0). */
  ledgerSequence: number;
  /** Unix timestamp in milliseconds when the authoritative ledger closed. */
  ledgerClosedAt: number;
  network?: "testnet" | "mainnet";
  campaigns?: readonly AuthoritativeLedgerCampaignRecord[];
  streams?: AuthoritativeLedgerStreamSummary;
}

export interface AuthoritativeLedgerDataSource {
  getLatestLedgerSnapshot(network?: string): Promise<AuthoritativeLedgerSnapshot | null>;
}

export type AnalyticsAuthorityState = "fresh" | "stale" | "unavailable" | "mismatch";

export type AnalyticsAuthorityReason =
  | "missing_authority"
  | "authority_error"
  | "invalid_ledger_sequence"
  | "future_timestamp"
  | "stale_ledger"
  | "ledger_mismatch";

export interface MetricDiscrepancy {
  metric: AnalyticsMetricKey;
  expected: string | number;
  actual: string | number;
  delta: string;
  message: string;
}

export interface AnalyticsAuthorityReport {
  state: AnalyticsAuthorityState;
  isAuthoritative: boolean;
  isFresh: boolean;
  ledgerSequence: number | null;
  ledgerClosedAt: number | null;
  checkedAt: number;
  stalenessMs: number | null;
  maxStalenessMs: number;
  reason?: AnalyticsAuthorityReason;
  message: string;
  discrepancies: MetricDiscrepancy[];
}

export interface CampaignMetricsCandidate {
  activeCampaigns: number;
  totalTreesPlanted: number;
  totalCo2SequesteredKg: number;
  totalSponsors: number;
  campaignCompletionRate: number;
  revenue: string;
}

export interface StreamMetricsCandidate {
  totalStreams: number;
  activeStreams: number;
  totalVolumeUsd: string;
  uniqueAssets: number;
}

function parseNonNegativeStroops(value: string): bigint {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(trimmed) ? BigInt(trimmed) : 0n;
}

function roundOneDecimalPercent(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 1000) / 10;
}

/**
 * Evaluate freshness of an authoritative ledger snapshot at `now` (ms).
 */
export function evaluateLedgerFreshness(
  snapshot: AuthoritativeLedgerSnapshot | null | undefined,
  now = Date.now(),
  maxStalenessMs = DEFAULT_MAX_AUTHORITY_STALENESS_MS,
): Omit<AnalyticsAuthorityReport, "discrepancies"> {
  const effectiveMaxStaleness =
    Number.isFinite(maxStalenessMs) && maxStalenessMs > 0
      ? Math.floor(maxStalenessMs)
      : DEFAULT_MAX_AUTHORITY_STALENESS_MS;

  if (!snapshot) {
    return {
      state: "unavailable",
      isAuthoritative: false,
      isFresh: false,
      ledgerSequence: null,
      ledgerClosedAt: null,
      checkedAt: now,
      stalenessMs: null,
      maxStalenessMs: effectiveMaxStaleness,
      reason: "missing_authority",
      message:
        "Authoritative ledger state is unavailable; metrics cannot be verified against on-chain state.",
    };
  }

  if (
    !Number.isInteger(snapshot.ledgerSequence) ||
    snapshot.ledgerSequence <= 0
  ) {
    return {
      state: "unavailable",
      isAuthoritative: false,
      isFresh: false,
      ledgerSequence: null,
      ledgerClosedAt: Number.isFinite(snapshot.ledgerClosedAt) ? snapshot.ledgerClosedAt : null,
      checkedAt: now,
      stalenessMs: null,
      maxStalenessMs: effectiveMaxStaleness,
      reason: "invalid_ledger_sequence",
      message: "Authoritative ledger sequence is invalid or missing.",
    };
  }

  if (!Number.isFinite(snapshot.ledgerClosedAt) || snapshot.ledgerClosedAt <= 0) {
    return {
      state: "unavailable",
      isAuthoritative: false,
      isFresh: false,
      ledgerSequence: snapshot.ledgerSequence,
      ledgerClosedAt: null,
      checkedAt: now,
      stalenessMs: null,
      maxStalenessMs: effectiveMaxStaleness,
      reason: "missing_authority",
      message: "Authoritative ledger close timestamp is missing.",
    };
  }

  const stalenessMs = now - snapshot.ledgerClosedAt;

  // Reject snapshots claiming to be from the future beyond a small 5s clock skew tolerance.
  if (stalenessMs < -5_000) {
    return {
      state: "unavailable",
      isAuthoritative: false,
      isFresh: false,
      ledgerSequence: snapshot.ledgerSequence,
      ledgerClosedAt: snapshot.ledgerClosedAt,
      checkedAt: now,
      stalenessMs,
      maxStalenessMs: effectiveMaxStaleness,
      reason: "future_timestamp",
      message: `Authoritative ledger #${snapshot.ledgerSequence} timestamp exceeds allowed clock skew.`,
    };
  }

  const clampedStalenessMs = Math.max(0, stalenessMs);
  if (clampedStalenessMs > effectiveMaxStaleness) {
    return {
      state: "stale",
      isAuthoritative: true,
      isFresh: false,
      ledgerSequence: snapshot.ledgerSequence,
      ledgerClosedAt: snapshot.ledgerClosedAt,
      checkedAt: now,
      stalenessMs: clampedStalenessMs,
      maxStalenessMs: effectiveMaxStaleness,
      reason: "stale_ledger",
      message: `Ledger #${snapshot.ledgerSequence} is stale (${Math.round(clampedStalenessMs / 1000)}s old).`,
    };
  }

  return {
    state: "fresh",
    isAuthoritative: true,
    isFresh: true,
    ledgerSequence: snapshot.ledgerSequence,
    ledgerClosedAt: snapshot.ledgerClosedAt,
    checkedAt: now,
    stalenessMs: clampedStalenessMs,
    maxStalenessMs: effectiveMaxStaleness,
    message: `Verified against authoritative ledger #${snapshot.ledgerSequence}.`,
  };
}

/**
 * Validate computed campaign analytics metrics against an authoritative ledger snapshot.
 */
export function validateCampaignMetricsAgainstLedger(
  metrics: CampaignMetricsCandidate,
  snapshot: AuthoritativeLedgerSnapshot | null | undefined,
  options: { now?: number; maxStalenessMs?: number } = {},
): AnalyticsAuthorityReport {
  const freshness = evaluateLedgerFreshness(
    snapshot,
    options.now ?? Date.now(),
    options.maxStalenessMs,
  );

  if (freshness.state === "unavailable" || !snapshot?.campaigns) {
    if (freshness.state !== "unavailable" && !snapshot?.campaigns) {
      return {
        ...freshness,
        state: "unavailable",
        isAuthoritative: false,
        isFresh: false,
        reason: "missing_authority",
        message: "Authoritative ledger snapshot does not contain campaign records.",
        discrepancies: [],
      };
    }
    return { ...freshness, discrepancies: [] };
  }

  const ledgerCampaigns = snapshot.campaigns;
  const expectedActive = ledgerCampaigns.filter((c) => c.status === "ACTIVE").length;
  const expectedCompleted = ledgerCampaigns.filter((c) => c.status === "COMPLETED").length;
  const expectedTrees = ledgerCampaigns.reduce((sum, c) => sum + c.treeCount, 0);
  const expectedCo2Kg = expectedTrees * CO2_PER_TREE_PER_YEAR_KG;
  const expectedSponsors = ledgerCampaigns.reduce((sum, c) => sum + c.sponsorCount, 0);
  const expectedCompletionRate = roundOneDecimalPercent(
    expectedCompleted,
    ledgerCampaigns.length,
  );
  const expectedRevenueStroops = ledgerCampaigns.reduce(
    (sum, c) => sum + parseNonNegativeStroops(c.raisedAmount),
    0n,
  );

  const discrepancies: MetricDiscrepancy[] = [];

  if (metrics.activeCampaigns !== expectedActive) {
    discrepancies.push({
      metric: "activeCampaigns",
      expected: expectedActive,
      actual: metrics.activeCampaigns,
      delta: String(metrics.activeCampaigns - expectedActive),
      message: `activeCampaigns (${metrics.activeCampaigns}) differs from ledger (${expectedActive}).`,
    });
  }

  if (metrics.totalTreesPlanted !== expectedTrees) {
    discrepancies.push({
      metric: "totalTreesPlanted",
      expected: expectedTrees,
      actual: metrics.totalTreesPlanted,
      delta: String(metrics.totalTreesPlanted - expectedTrees),
      message: `totalTreesPlanted (${metrics.totalTreesPlanted}) differs from ledger (${expectedTrees}).`,
    });
  }

  if (metrics.totalCo2SequesteredKg !== expectedCo2Kg) {
    discrepancies.push({
      metric: "totalCo2SequesteredKg",
      expected: expectedCo2Kg,
      actual: metrics.totalCo2SequesteredKg,
      delta: String(metrics.totalCo2SequesteredKg - expectedCo2Kg),
      message: `totalCo2SequesteredKg (${metrics.totalCo2SequesteredKg}) differs from ledger (${expectedCo2Kg}).`,
    });
  }

  if (metrics.totalSponsors !== expectedSponsors) {
    discrepancies.push({
      metric: "totalSponsors",
      expected: expectedSponsors,
      actual: metrics.totalSponsors,
      delta: String(metrics.totalSponsors - expectedSponsors),
      message: `totalSponsors (${metrics.totalSponsors}) differs from ledger (${expectedSponsors}).`,
    });
  }

  if (metrics.campaignCompletionRate !== expectedCompletionRate) {
    discrepancies.push({
      metric: "campaignCompletionRate",
      expected: expectedCompletionRate,
      actual: metrics.campaignCompletionRate,
      delta: (metrics.campaignCompletionRate - expectedCompletionRate).toFixed(1),
      message: `campaignCompletionRate (${metrics.campaignCompletionRate}%) differs from ledger (${expectedCompletionRate}%).`,
    });
  }

  const actualRevenueStroops = parseNonNegativeStroops(metrics.revenue);
  if (actualRevenueStroops !== expectedRevenueStroops) {
    discrepancies.push({
      metric: "revenue",
      expected: expectedRevenueStroops.toString(),
      actual: metrics.revenue,
      delta: (actualRevenueStroops - expectedRevenueStroops).toString(),
      message: `revenue (${metrics.revenue} stroops) differs from ledger (${expectedRevenueStroops.toString()} stroops).`,
    });
  }

  if (discrepancies.length > 0) {
    return {
      ...freshness,
      state: "mismatch",
      isAuthoritative: false,
      reason: "ledger_mismatch",
      message: `Detected ${discrepancies.length} discrepancy(ies) against authoritative ledger #${snapshot.ledgerSequence}.`,
      discrepancies,
    };
  }

  return {
    ...freshness,
    discrepancies: [],
  };
}

/**
 * Validate computed stream analytics metrics against an authoritative stream ledger summary.
 */
export function validateStreamMetricsAgainstLedger(
  metrics: StreamMetricsCandidate,
  snapshot: AuthoritativeLedgerSnapshot | null | undefined,
  options: { now?: number; maxStalenessMs?: number } = {},
): AnalyticsAuthorityReport {
  const freshness = evaluateLedgerFreshness(
    snapshot,
    options.now ?? Date.now(),
    options.maxStalenessMs,
  );

  if (freshness.state === "unavailable" || !snapshot?.streams) {
    if (freshness.state !== "unavailable" && !snapshot?.streams) {
      return {
        ...freshness,
        state: "unavailable",
        isAuthoritative: false,
        isFresh: false,
        reason: "missing_authority",
        message: "Authoritative ledger snapshot does not contain stream records.",
        discrepancies: [],
      };
    }
    return { ...freshness, discrepancies: [] };
  }

  const expected = snapshot.streams;
  const discrepancies: MetricDiscrepancy[] = [];

  if (metrics.totalStreams !== expected.totalStreams) {
    discrepancies.push({
      metric: "totalStreams",
      expected: expected.totalStreams,
      actual: metrics.totalStreams,
      delta: String(metrics.totalStreams - expected.totalStreams),
      message: `totalStreams (${metrics.totalStreams}) differs from ledger (${expected.totalStreams}).`,
    });
  }

  if (metrics.activeStreams !== expected.activeStreams) {
    discrepancies.push({
      metric: "activeStreams",
      expected: expected.activeStreams,
      actual: metrics.activeStreams,
      delta: String(metrics.activeStreams - expected.activeStreams),
      message: `activeStreams (${metrics.activeStreams}) differs from ledger (${expected.activeStreams}).`,
    });
  }

  if (
    expected.totalVolumeUsd !== undefined &&
    parseNonNegativeStroops(metrics.totalVolumeUsd) !==
      parseNonNegativeStroops(expected.totalVolumeUsd)
  ) {
    const actualUsd = parseNonNegativeStroops(metrics.totalVolumeUsd);
    const expectedUsd = parseNonNegativeStroops(expected.totalVolumeUsd);
    discrepancies.push({
      metric: "totalVolumeUsd",
      expected: expected.totalVolumeUsd,
      actual: metrics.totalVolumeUsd,
      delta: (actualUsd - expectedUsd).toString(),
      message: `totalVolumeUsd (${metrics.totalVolumeUsd}) differs from ledger (${expected.totalVolumeUsd}).`,
    });
  }

  if (
    expected.uniqueAssets !== undefined &&
    metrics.uniqueAssets !== expected.uniqueAssets
  ) {
    discrepancies.push({
      metric: "uniqueAssets",
      expected: expected.uniqueAssets,
      actual: metrics.uniqueAssets,
      delta: String(metrics.uniqueAssets - expected.uniqueAssets),
      message: `uniqueAssets (${metrics.uniqueAssets}) differs from ledger (${expected.uniqueAssets}).`,
    });
  }

  if (discrepancies.length > 0) {
    return {
      ...freshness,
      state: "mismatch",
      isAuthoritative: false,
      reason: "ledger_mismatch",
      message: `Detected ${discrepancies.length} stream metric discrepancy(ies) against ledger #${snapshot.ledgerSequence}.`,
      discrepancies,
    };
  }

  return {
    ...freshness,
    discrepancies: [],
  };
}
