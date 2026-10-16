import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_DISCOVERY_BUDGET,
  MAP_RENDERING_BUDGET,
  evaluateMetric,
  evaluatePerformanceMetrics,
  generateRepresentativeCampaigns,
  generateRepresentativeStreams,
  measureCampaignDiscoveryFiltering,
  measureMapRendering,
  runPerformanceAudit,
} from "./performance-budgets";

describe("Performance Budgets for Discovery & Maps (Issue #76)", () => {
  describe("Representative Data Generators", () => {
    it("generates deterministic representative stream markers for map benchmarking", () => {
      const streams = generateRepresentativeStreams(100);
      expect(streams).toHaveLength(100);
      expect(streams[0]).toHaveProperty("location.lat");
      expect(streams[0]).toHaveProperty("location.lng");
      expect(streams[0]).toHaveProperty("status");
      expect(streams[0]).toHaveProperty("category");
    });

    it("generates deterministic representative campaigns for discovery benchmarking", () => {
      const campaigns = generateRepresentativeCampaigns(100);
      expect(campaigns).toHaveLength(100);
      expect(campaigns[0]).toHaveProperty("treeSpecies");
      expect(campaigns[0]).toHaveProperty("region");
    });
  });

  describe("Benchmark Execution on Representative Datasets", () => {
    it("measures map rendering and clustering duration within explicit budget for 1,000 streams", () => {
      const result = measureMapRendering(1000);
      expect(result.streamCount).toBe(1000);
      expect(result.clustersCount).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThan(MAP_RENDERING_BUDGET.maxComputationMs);
    });

    it("measures campaign discovery filtering duration within explicit budget for 1,000 campaigns", () => {
      const result = measureCampaignDiscoveryFiltering(1000);
      expect(result.totalCount).toBe(1000);
      expect(result.filteredCount).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThan(CAMPAIGN_DISCOVERY_BUDGET.maxComputationMs);
    });
  });

  describe("evaluateMetric boundary and status logic", () => {
    it("reports PASS when metric is safely below budget", () => {
      const metric = evaluateMetric({
        name: "LCP",
        actual: 1500,
        budget: 2500,
        unit: "ms",
      });
      expect(metric.status).toBe("PASS");
      expect(metric.delta).toBe(-1000);
    });

    it("reports WARN when metric reaches 90% of budget limit", () => {
      const metric = evaluateMetric({
        name: "JS Size",
        actual: 280,
        budget: 300,
        unit: "KB",
      });
      expect(metric.status).toBe("WARN");
      expect(metric.delta).toBe(-20);
    });

    it("reports REGRESSION when metric exceeds budget limit", () => {
      const metric = evaluateMetric({
        name: "Interaction Latency",
        actual: 140,
        budget: 100,
        unit: "ms",
      });
      expect(metric.status).toBe("REGRESSION");
      expect(metric.delta).toBe(40);
      expect(metric.deltaPercent).toBe(40);
    });

    it("handles boundary condition (metric exactly equal to budget)", () => {
      const metric = evaluateMetric({
        name: "Computation",
        actual: 150,
        budget: 150,
        unit: "ms",
      });
      // Exactly at budget is WARN (since >= 90% and <= budget)
      expect(metric.status).toBe("WARN");
    });
  });

  describe("evaluatePerformanceMetrics area evaluation", () => {
    it("evaluates campaign discovery metrics and returns PASS when all are green", () => {
      const evaluation = evaluatePerformanceMetrics("campaign-discovery", {
        computationMs: 45,
        interactionLatencyMs: 30,
        lcpMs: 1600,
        jsBytes: 250 * 1024,
      });

      expect(evaluation.area).toBe("campaign-discovery");
      expect(evaluation.status).toBe("PASS");
      expect(evaluation.regressions).toHaveLength(0);
      expect(evaluation.metrics).toHaveLength(4);
    });

    it("detects and flags regressions in map rendering", () => {
      const evaluation = evaluatePerformanceMetrics("maps", {
        computationMs: 350, // Exceeds 200ms budget
        interactionLatencyMs: 150, // Exceeds 100ms budget
        lcpMs: 3500, // Exceeds 3000ms budget
        jsBytes: 320 * 1024, // Exceeds 300KB budget
      });

      expect(evaluation.area).toBe("maps");
      expect(evaluation.status).toBe("REGRESSION");
      expect(evaluation.regressions.length).toBeGreaterThanOrEqual(1);
      expect(evaluation.regressions[0]).toContain("exceeded budget");
    });
  });

  describe("runPerformanceAudit", () => {
    it("runs complete audit on representative data without live funds or network dependencies", () => {
      const audit = runPerformanceAudit();
      expect(audit).toHaveProperty("discovery");
      expect(audit).toHaveProperty("maps");
      expect(["PASS", "WARN"]).toContain(audit.overallStatus);
    });
  });
});
