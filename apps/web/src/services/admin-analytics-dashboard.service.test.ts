// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ANALYTICS_METRIC_DEFINITIONS,
  CO2_PER_TREE_PER_YEAR_KG,
  evaluateLedgerFreshness,
  getAnalyticsMetricDefinitions,
  validateCampaignMetricsAgainstLedger,
} from "@/lib/analytics-authority";
import {
  getAdminAnalyticsDashboard,
  setAdminAnalyticsAuthoritySource,
} from "./admin-analytics-dashboard.service";
import type { CampaignDataSource, CampaignRecord } from "./campaign.service";
import { GET as getDashboardRoute } from "@/app/api/analytics/dashboard/route";

const fixedNow = Date.parse("2026-03-20T12:00:00.000Z");

const KNOWN_CAMPAIGNS: CampaignRecord[] = [
  {
    id: "camp-1",
    name: "Amazon Canopy Restoration",
    description: "Restore rainforest canopy in Para",
    creatorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    status: "ACTIVE",
    goalAmount: "200000000",
    raisedAmount: "150000000",
    tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    sponsorCount: 15,
    treeCount: 120,
    createdAt: Date.parse("2026-03-05T00:00:00.000Z"), // within trailing 30d
    updatedAt: fixedNow - 10_000,
    milestones: [],
  },
  {
    id: "camp-2",
    name: "Mangrove Shield Initiative",
    description: "Coastal mangrove reforestation",
    creatorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    status: "COMPLETED",
    goalAmount: "250000000",
    raisedAmount: "250000000",
    tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    sponsorCount: 10,
    treeCount: 80,
    createdAt: Date.parse("2026-02-01T00:00:00.000Z"), // in prior 30d window [now-60d, now-30d)
    updatedAt: fixedNow - 20_000,
    milestones: [],
  },
  {
    id: "camp-3",
    name: "Sahel Waterbreaks",
    description: "Agroforestry windbreaks",
    creatorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    status: "ACTIVE",
    goalAmount: "100000000",
    raisedAmount: "50000000",
    tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    sponsorCount: 5,
    treeCount: 50,
    createdAt: Date.parse("2026-03-15T00:00:00.000Z"), // within trailing 30d
    updatedAt: fixedNow - 5_000,
    milestones: [],
  },
];

function makeCampaignSource(records: CampaignRecord[] = KNOWN_CAMPAIGNS): CampaignDataSource {
  return {
    getCampaigns: async () => records,
    getCampaignById: async (id: string) => records.find((c) => c.id === id) ?? null,
    createCampaign: async () => {
      throw new Error("not implemented");
    },
    updateCampaign: async () => {
      throw new Error("not implemented");
    },
    deleteCampaign: async () => false,
  };
}

describe("Admin analytics dashboard & authoritative ledger validation (#82)", () => {
  beforeEach(() => {
    setAdminAnalyticsAuthoritySource(undefined);
  });

  afterEach(() => {
    setAdminAnalyticsAuthoritySource(undefined);
  });

  describe("Metric definitions & formulas", () => {
    it("documents dataSource, authorityType, unit, formula, and knownFixtureExample for every metric", () => {
      const definitions = getAnalyticsMetricDefinitions();
      const expectedKeys = [
        "activeCampaigns",
        "totalTreesPlanted",
        "totalCo2SequesteredKg",
        "totalSponsors",
        "sponsorGrowthPercent",
        "campaignCompletionRate",
        "revenue",
        "totalStreams",
        "activeStreams",
        "totalVolumeUsd",
        "uniqueAssets",
        "uniqueRegions",
        "uniqueCategories",
        "averageStreamAmount",
        "sponsorImpact",
      ] as const;

      for (const key of expectedKeys) {
        const def = definitions[key];
        expect(def).toBeDefined();
        expect(def.key).toBe(key);
        expect(def.label.length).toBeGreaterThan(2);
        expect(def.dataSource.length).toBeGreaterThan(10);
        expect(def.formula.length).toBeGreaterThan(10);
        expect(Object.keys(def.knownFixtureExample.inputs).length).toBeGreaterThan(0);
        expect(def.knownFixtureExample.expected).toBeDefined();
      }
    });
  });

  describe("Known-value fixture calculations", () => {
    it("computes deterministic metrics matching known fixtures and validates against authoritative ledger", async () => {
      const dashboard = await getAdminAnalyticsDashboard(makeCampaignSource(), fixedNow);

      // Known-value expectations from KNOWN_CAMPAIGNS:
      // activeCampaigns: camp-1, camp-3 => 2
      // totalTreesPlanted: 120 + 80 + 50 => 250
      // totalCo2SequesteredKg: 250 * 21 => 5250
      // totalSponsors: 15 + 10 + 5 => 30
      // recentSponsors (last 30d): 15 + 5 = 20; previousSponsors (prior 30d): 10 => (20 - 10) / 10 = +100%
      // campaignCompletionRate: 1 / 3 => 33.3%
      // revenue: 150M + 250M + 50M => 450000000 stroops
      expect(dashboard.metrics).toEqual({
        activeCampaigns: 2,
        totalTreesPlanted: 250,
        totalCo2SequesteredKg: 250 * CO2_PER_TREE_PER_YEAR_KG,
        totalSponsors: 30,
        sponsorGrowthPercent: 100,
        campaignCompletionRate: 33.3,
        revenue: "450000000",
      });

      expect(dashboard.authority).toBeDefined();
      expect(dashboard.authority.state).toBe("fresh");
      expect(dashboard.authority.isAuthoritative).toBe(true);
      expect(dashboard.authority.isFresh).toBe(true);
      expect(dashboard.authority.discrepancies).toHaveLength(0);
      expect(dashboard.metricDefinitions.revenue.formula).toBe(
        ANALYTICS_METRIC_DEFINITIONS.revenue.formula
      );
    });
  });

  describe("Authoritative ledger freshness, mismatch, and unavailable states", () => {
    it("returns unavailable (missing_authority) when authoritative ledger snapshot is null", async () => {
      const dashboard = await getAdminAnalyticsDashboard(makeCampaignSource(), fixedNow, {
        authoritySource: null,
      });

      expect(dashboard.authority.state).toBe("unavailable");
      expect(dashboard.authority.isAuthoritative).toBe(false);
      expect(dashboard.authority.isFresh).toBe(false);
      expect(dashboard.authority.reason).toBe("missing_authority");
      expect(dashboard.authority.ledgerSequence).toBeNull();
    });

    it("returns unavailable (authority_error) when authoritative ledger source throws", async () => {
      const dashboard = await getAdminAnalyticsDashboard(makeCampaignSource(), fixedNow, {
        authoritySource: {
          getLatestLedgerSnapshot: async () => {
            throw new Error("Soroban RPC timeout");
          },
        },
      });

      expect(dashboard.authority.state).toBe("unavailable");
      expect(dashboard.authority.isAuthoritative).toBe(false);
      expect(dashboard.authority.reason).toBe("authority_error");
      expect(dashboard.authority.message).toContain("Soroban RPC timeout");
    });

    it("returns stale when ledger snapshot age exceeds maxStalenessMs", async () => {
      const staleSnapshotTime = fixedNow - 600_000; // 10 minutes old
      const dashboard = await getAdminAnalyticsDashboard(makeCampaignSource(), fixedNow, {
        maxStalenessMs: 300_000, // 5 minute threshold
        authoritySource: {
          ledgerSequence: 5_100_000,
          ledgerClosedAt: staleSnapshotTime,
          network: "testnet",
          campaigns: KNOWN_CAMPAIGNS.map((c) => ({
            id: c.id,
            status: c.status,
            raisedAmount: c.raisedAmount,
            sponsorCount: c.sponsorCount,
            treeCount: c.treeCount,
          })),
        },
      });

      expect(dashboard.authority.state).toBe("stale");
      expect(dashboard.authority.isAuthoritative).toBe(true);
      expect(dashboard.authority.isFresh).toBe(false);
      expect(dashboard.authority.reason).toBe("stale_ledger");
      expect(dashboard.authority.stalenessMs).toBe(600_000);
    });

    it("returns mismatch with per-metric discrepancies when computed metrics diverge from authoritative ledger", async () => {
      const dashboard = await getAdminAnalyticsDashboard(makeCampaignSource(), fixedNow, {
        authoritySource: {
          ledgerSequence: 5_100_050,
          ledgerClosedAt: fixedNow - 5_000,
          network: "testnet",
          campaigns: [
            {
              id: "camp-1",
              status: "ACTIVE",
              raisedAmount: "1000000",
              sponsorCount: 2,
              treeCount: 10,
            },
          ],
        },
      });

      expect(dashboard.authority.state).toBe("mismatch");
      expect(dashboard.authority.isAuthoritative).toBe(false);
      expect(dashboard.authority.reason).toBe("ledger_mismatch");
      expect(dashboard.authority.discrepancies.length).toBeGreaterThanOrEqual(4);
      const revenueMismatch = dashboard.authority.discrepancies.find(
        (d) => d.metric === "revenue"
      );
      expect(revenueMismatch).toMatchObject({
        metric: "revenue",
        expected: "1000000",
        actual: "450000000",
      });
    });

    it("handles boundary cases in evaluateLedgerFreshness (invalid sequence and future timestamp)", () => {
      const invalidSeq = evaluateLedgerFreshness(
        { ledgerSequence: 0, ledgerClosedAt: fixedNow },
        fixedNow
      );
      expect(invalidSeq.state).toBe("unavailable");
      expect(invalidSeq.reason).toBe("invalid_ledger_sequence");

      const futureTs = evaluateLedgerFreshness(
        { ledgerSequence: 100, ledgerClosedAt: fixedNow + 120_000 },
        fixedNow
      );
      expect(futureTs.state).toBe("unavailable");
      expect(futureTs.reason).toBe("future_timestamp");

      const invalidValidate = validateCampaignMetricsAgainstLedger(
        {
          activeCampaigns: 1,
          totalTreesPlanted: 10,
          totalCo2SequesteredKg: 210,
          totalSponsors: 1,
          campaignCompletionRate: 100,
          revenue: "100",
        },
        null,
        { now: fixedNow }
      );
      expect(invalidValidate.state).toBe("unavailable");
      expect(invalidValidate.reason).toBe("missing_authority");
    });
  });

  describe("GET /api/analytics/dashboard route", () => {
    it("returns dashboard payload with authority and metricDefinitions and no-store cache headers", async () => {
      const response = await getDashboardRoute(
        new Request("http://localhost:3000/api/analytics/dashboard")
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");

      const body = await response.json();
      expect(body.data.authority).toBeDefined();
      expect(body.data.metricDefinitions.activeCampaigns).toBeDefined();
    });

    it("supports authority=missing query parameter to simulate unavailable authority", async () => {
      const response = await getDashboardRoute(
        new Request("http://localhost:3000/api/analytics/dashboard?authority=missing")
      );
      const body = await response.json();
      expect(body.data.authority.state).toBe("unavailable");
      expect(body.data.authority.reason).toBe("missing_authority");
    });
  });
});
