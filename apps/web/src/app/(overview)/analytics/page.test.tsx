import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnalyticsPage, { type DashboardData } from "./page";
import { ANALYTICS_METRIC_DEFINITIONS } from "@/lib/analytics-authority";

// Mock Recharts ResponsiveContainer so it renders children deterministically in JSDOM
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="recharts-responsive-container">{children}</div>
    ),
  };
});

const baseDashboardFixture: DashboardData = {
  updatedAt: 1774008000000,
  currencyUnit: "stroops",
  metrics: {
    activeCampaigns: 2,
    totalTreesPlanted: 250,
    totalCo2SequesteredKg: 5250,
    totalSponsors: 30,
    sponsorGrowthPercent: 100,
    campaignCompletionRate: 33.3,
    revenue: "450000000",
  },
  monthlyTrend: [
    { month: "2026-01", campaigns: 1, sponsors: 10, revenue: "150000000" },
    { month: "2026-02", campaigns: 1, sponsors: 10, revenue: "250000000" },
    { month: "2026-03", campaigns: 1, sponsors: 10, revenue: "50000000" },
  ],
  authority: {
    state: "fresh",
    isAuthoritative: true,
    isFresh: true,
    ledgerSequence: 5120026,
    ledgerClosedAt: 1774007995000,
    checkedAt: 1774008000000,
    stalenessMs: 5000,
    maxStalenessMs: 300000,
    message: "Verified against authoritative ledger #5120026.",
    discrepancies: [],
  },
  metricDefinitions: ANALYTICS_METRIC_DEFINITIONS,
};

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("AnalyticsPage (#82)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders fresh authoritative ledger state and documented metric formulas", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: baseDashboardFixture }),
    } as Response);

    renderWithQueryClient(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("analytics-authority-banner")).toBeTruthy();
    });

    const banner = screen.getByTestId("analytics-authority-banner");
    expect(banner.getAttribute("data-authority-status")).toBe("fresh");
    expect(banner.textContent).toContain("#5120026");
    expect(screen.getByTestId("analytics-freshness-badge").textContent).toContain("Fresh · 5s ago");
    expect(screen.queryByText("Unverified")).toBeNull();

    // Check metric definitions section
    const definitionsSection = screen.getByTestId("analytics-metric-definitions");
    expect(definitionsSection).toBeTruthy();
    expect(screen.getByTestId("metric-definition-revenue").textContent).toContain(
      ANALYTICS_METRIC_DEFINITIONS.revenue.formula
    );
  });

  it("renders stale state and marks metric cards as Unverified when ledger authority is stale", async () => {
    const stalePayload: DashboardData = {
      ...baseDashboardFixture,
      authority: {
        ...baseDashboardFixture.authority!,
        state: "stale",
        isFresh: false,
        stalenessMs: 600_000,
        reason: "stale_ledger",
        message: "Ledger #5120026 is stale (600s old).",
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: stalePayload }),
    } as Response);

    renderWithQueryClient(<AnalyticsPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("analytics-authority-banner").getAttribute("data-authority-status")
      ).toBe("stale");
    });

    expect(screen.getByTestId("analytics-freshness-badge").textContent).toContain("Stale · 10m ago");
    expect(screen.getAllByText("Unverified").length).toBeGreaterThanOrEqual(6);
  });

  it("renders unavailable state when authoritative ledger snapshot is missing", async () => {
    const unavailablePayload: DashboardData = {
      ...baseDashboardFixture,
      authority: {
        state: "unavailable",
        isAuthoritative: false,
        isFresh: false,
        ledgerSequence: null,
        ledgerClosedAt: null,
        checkedAt: 1774008000000,
        stalenessMs: null,
        maxStalenessMs: 300000,
        reason: "missing_authority",
        message: "Authoritative ledger state is unavailable.",
        discrepancies: [],
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: unavailablePayload }),
    } as Response);

    renderWithQueryClient(<AnalyticsPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("analytics-authority-banner").getAttribute("data-authority-status")
      ).toBe("unavailable");
    });

    expect(screen.getByTestId("analytics-authority-banner").textContent).toContain(
      "Authoritative ledger state is unavailable"
    );
    expect(screen.getByTestId("analytics-freshness-badge").textContent).toContain(
      "Authority unavailable (missing_authority)"
    );
  });

  it("renders mismatch alert when computed metrics diverge from authoritative ledger", async () => {
    const mismatchPayload: DashboardData = {
      ...baseDashboardFixture,
      authority: {
        ...baseDashboardFixture.authority!,
        state: "mismatch",
        isAuthoritative: false,
        reason: "ledger_mismatch",
        message: "Detected 1 discrepancy against authoritative ledger #5120026.",
        discrepancies: [
          {
            metric: "revenue",
            actual: "450000000",
            expected: "400000000",
            delta: "50000000",
            message: "revenue differs from ledger",
          },
        ],
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: mismatchPayload }),
    } as Response);

    renderWithQueryClient(<AnalyticsPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("analytics-authority-banner").getAttribute("data-authority-status")
      ).toBe("mismatch");
    });

    expect(screen.getByTestId("analytics-authority-banner").textContent).toContain(
      "revenue: computed 450000000, authoritative ledger 400000000"
    );
  });
});
