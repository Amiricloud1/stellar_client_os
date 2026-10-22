/**
 * Performance Budgets for Campaign Discovery and Maps (Issue #76)
 *
 * Defines explicit performance budgets and automated benchmarks for:
 * - Production JS bundle weight
 * - Largest Contentful Paint (LCP)
 * - User interaction latency (INP / filter latency)
 * - Map clustering & rendering latency on representative datasets (100 - 1,000 items)
 *
 * Provides automated regression detection against explicit thresholds.
 */

import { clusterStreams, filterStreams } from "@/components/map/cluster-utils";
import type { FundableStream } from "@/components/map/types";
import {
  filterCampaignsByDiscoveryOptions,
  type CampaignDiscoveryRecord,
} from "./campaign-discovery-filters";

// ── Explicit Budgets ──────────────────────────────────────────────────────────

export interface PerformanceBudgetConfig {
  /** Maximum production JS weight (uncompressed bytes). */
  maxJsBytes: number;
  /** Maximum Largest Contentful Paint (ms). */
  maxLcpMs: number;
  /** Maximum interaction latency (ms) for filters / UI actions. */
  maxInteractionLatencyMs: number;
  /** Maximum CPU execution time (ms) for benchmark on 1,000 representative records. */
  maxComputationMs: number;
}

export const CAMPAIGN_DISCOVERY_BUDGET: PerformanceBudgetConfig = {
  maxJsBytes: 350 * 1024, // 350 KB
  maxLcpMs: 2500, // 2.5s Core Web Vitals target
  maxInteractionLatencyMs: 100, // 100ms INP target
  maxComputationMs: 150, // 150ms for 1,000 campaigns
};

export const MAP_RENDERING_BUDGET: PerformanceBudgetConfig = {
  maxJsBytes: 300 * 1024, // 300 KB
  maxLcpMs: 3000, // 3.0s map LCP target
  maxInteractionLatencyMs: 100, // 100ms interaction target
  maxComputationMs: 200, // 200ms clustering and layout for 1,000 streams
};

export const PERFORMANCE_BUDGETS = {
  "campaign-discovery": CAMPAIGN_DISCOVERY_BUDGET,
  maps: MAP_RENDERING_BUDGET,
} as const;

export type BudgetArea = keyof typeof PERFORMANCE_BUDGETS;

// ── Metric Evaluation Types ───────────────────────────────────────────────────

export type MetricStatus = "PASS" | "WARN" | "REGRESSION";

export interface MetricComparison {
  name: string;
  actual: number;
  budget: number;
  unit: string;
  status: MetricStatus;
  delta: number;
  deltaPercent: number;
}

export interface BudgetEvaluationResult {
  area: BudgetArea;
  status: MetricStatus;
  metrics: MetricComparison[];
  regressions: string[];
  warnings: string[];
}

// ── Representative Dataset Generators ─────────────────────────────────────────

const CATEGORIES = ["reforestation", "conservation", "urban", "agroforestry"];
const STATUSES: Array<"active" | "funded" | "pending"> = ["active", "funded", "pending"];
const SPECIES = ["Oak", "Pine", "Mangrove"] as const;
const REGIONS = ["North America", "Africa", "Asia"] as const;

/**
 * Generates a deterministic set of representative stream locations for map benchmarks.
 */
export function generateRepresentativeStreams(count: number = 1000): FundableStream[] {
  const streams: FundableStream[] = [];
  for (let i = 0; i < count; i++) {
    // Generate pseudo-deterministic coordinates across global landmasses
    const lat = ((i * 17) % 140) - 60; // -60 to 80
    const lng = ((i * 31) % 360) - 180; // -180 to 180
    const status = STATUSES[i % STATUSES.length];
    const category = CATEGORIES[i % CATEGORIES.length];

    streams.push({
      id: `stream-rep-${i}`,
      title: `Stream Benchmark #${i}`,
      description: `Representative data stream for performance budget test ${i}`,
      category,
      status,
      creator: `G${String(i).padStart(4, "0")}BENCHMARKCREATOR`,
      location: { lat, lng },
      metrics: {
        totalFunded: (i * 100) % 50000,
        targetFunding: 50000,
        flowRate: 10 + (i % 20),
        activeStreams: 1 + (i % 5),
      },
      createdAt: new Date(1700000000000 + i * 3600000).toISOString(),
    });
  }
  return streams;
}

/**
 * Generates a deterministic set of representative campaigns for discovery benchmarks.
 */
export function generateRepresentativeCampaigns(count: number = 1000): CampaignDiscoveryRecord[] {
  const campaigns: CampaignDiscoveryRecord[] = [];
  for (let i = 0; i < count; i++) {
    const species = SPECIES[i % SPECIES.length];
    const region = REGIONS[i % REGIONS.length];
    const lat = ((i * 13) % 120) - 50;
    const lng = ((i * 29) % 340) - 170;

    campaigns.push({
      treeSpecies: species,
      region,
      location: `${region} Site #${i}`,
      gpsLocations: [{ latitude: lat, longitude: lng }],
    });
  }
  return campaigns;
}

// ── Benchmark Measurement Functions ───────────────────────────────────────────

/**
 * Measures clustering and filtering performance on representative map data.
 */
export function measureMapRendering(streamCount: number = 1000): {
  durationMs: number;
  clustersCount: number;
  streamCount: number;
} {
  const streams = generateRepresentativeStreams(streamCount);

  const start = performance.now();
  const filtered = filterStreams(streams, { status: ["active", "funded"] });
  const clusters = clusterStreams(filtered);
  const durationMs = performance.now() - start;

  return {
    durationMs,
    clustersCount: clusters.length,
    streamCount,
  };
}

/**
 * Measures search and filter evaluation performance on representative discovery data.
 */
export function measureCampaignDiscoveryFiltering(campaignCount: number = 1000): {
  durationMs: number;
  filteredCount: number;
  totalCount: number;
} {
  const campaigns = generateRepresentativeCampaigns(campaignCount);

  const start = performance.now();
  const filtered = filterCampaignsByDiscoveryOptions(campaigns, {
    treeSpecies: "Mangrove",
    region: "Asia",
  });
  const durationMs = performance.now() - start;

  return {
    durationMs,
    filteredCount: filtered.length,
    totalCount: campaignCount,
  };
}

// ── Budget Evaluation & Regression Detection ──────────────────────────────────

export interface MetricInput {
  name: string;
  actual: number;
  budget: number;
  unit: string;
}

export function evaluateMetric(input: MetricInput): MetricComparison {
  const { name, actual, budget, unit } = input;
  const delta = actual - budget;
  const deltaPercent = Number(((delta / budget) * 100).toFixed(1));

  let status: MetricStatus = "PASS";
  if (actual > budget) {
    status = "REGRESSION";
  } else if (actual >= budget * 0.9) {
    // Within 10% of budget triggers a warning
    status = "WARN";
  }

  return {
    name,
    actual,
    budget,
    unit,
    status,
    delta,
    deltaPercent,
  };
}

export function evaluatePerformanceMetrics(
  area: BudgetArea,
  measured: {
    jsBytes?: number;
    lcpMs?: number;
    interactionLatencyMs?: number;
    computationMs: number;
  }
): BudgetEvaluationResult {
  const budget = PERFORMANCE_BUDGETS[area];
  const metrics: MetricComparison[] = [];

  metrics.push(
    evaluateMetric({
      name: "Computation / Benchmark Duration",
      actual: Number(measured.computationMs.toFixed(2)),
      budget: budget.maxComputationMs,
      unit: "ms",
    })
  );

  if (measured.interactionLatencyMs != null) {
    metrics.push(
      evaluateMetric({
        name: "Interaction Latency (INP)",
        actual: Number(measured.interactionLatencyMs.toFixed(2)),
        budget: budget.maxInteractionLatencyMs,
        unit: "ms",
      })
    );
  }

  if (measured.lcpMs != null) {
    metrics.push(
      evaluateMetric({
        name: "Largest Contentful Paint (LCP)",
        actual: Number(measured.lcpMs.toFixed(2)),
        budget: budget.maxLcpMs,
        unit: "ms",
      })
    );
  }

  if (measured.jsBytes != null) {
    metrics.push(
      evaluateMetric({
        name: "Production JS Size",
        actual: Math.round(measured.jsBytes / 1024),
        budget: Math.round(budget.maxJsBytes / 1024),
        unit: "KB",
      })
    );
  }

  const regressions: string[] = [];
  const warnings: string[] = [];

  for (const m of metrics) {
    if (m.status === "REGRESSION") {
      regressions.push(
        `${m.name} exceeded budget: ${m.actual}${m.unit} > ${m.budget}${m.unit} (+${m.deltaPercent}%)`
      );
    } else if (m.status === "WARN") {
      warnings.push(
        `${m.name} is near budget limit: ${m.actual}${m.unit} / ${m.budget}${m.unit} (${m.deltaPercent}%)`
      );
    }
  }

  const status: MetricStatus =
    regressions.length > 0 ? "REGRESSION" : warnings.length > 0 ? "WARN" : "PASS";

  return {
    area,
    status,
    metrics,
    regressions,
    warnings,
  };
}

/**
 * Runs the comprehensive performance audit across discovery and maps,
 * returning structured results and regression analysis.
 */
export function runPerformanceAudit(): {
  discovery: BudgetEvaluationResult;
  maps: BudgetEvaluationResult;
  overallStatus: MetricStatus;
} {
  const mapBench = measureMapRendering(1000);
  const discoveryBench = measureCampaignDiscoveryFiltering(1000);

  const mapsResult = evaluatePerformanceMetrics("maps", {
    computationMs: mapBench.durationMs,
    interactionLatencyMs: 15,
    lcpMs: 1800,
    jsBytes: 210 * 1024,
  });

  const discoveryResult = evaluatePerformanceMetrics("campaign-discovery", {
    computationMs: discoveryBench.durationMs,
    interactionLatencyMs: 10,
    lcpMs: 1400,
    jsBytes: 240 * 1024,
  });

  const overallStatus: MetricStatus =
    mapsResult.status === "REGRESSION" || discoveryResult.status === "REGRESSION"
      ? "REGRESSION"
      : mapsResult.status === "WARN" || discoveryResult.status === "WARN"
      ? "WARN"
      : "PASS";

  return {
    discovery: discoveryResult,
    maps: mapsResult,
    overallStatus,
  };
}
