// @vitest-environment node
import { describe, it, expect } from "vitest";
import { generatePrSummary, formatBytes, type PrCheckReport } from "./pr-check-summary";

describe("generatePrSummary", () => {
  it("formats bytes accurately", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("generates markdown summary for all passed checks", () => {
    const report: PrCheckReport = {
      packages: [
        { name: "@fundable/sdk", status: "passed", durationSeconds: 3 },
        { name: "@fundable/web", status: "passed", durationSeconds: 5 },
      ],
      artifacts: [
        { name: "SDK Dist", path: "packages/sdk/dist", sizeBytes: 10240 },
      ],
    };

    const res = generatePrSummary(report);
    expect(res.hasFailures).toBe(false);
    expect(res.markdown).toContain("✅ All Checks Passed");
    expect(res.markdown).toContain("Passed:** 2");
    expect(res.markdown).toContain("`@fundable/sdk`");
    expect(res.markdown).toContain("10.0 KB");
    expect(res.markdown).not.toContain("CAUTION");
  });

  it("surfaces failures, actionable links, and never masks failed status", () => {
    const report: PrCheckReport = {
      packages: [
        { name: "@fundable/sdk", status: "passed", durationSeconds: 3 },
        {
          name: "@fundable/web",
          status: "failed",
          durationSeconds: 10,
          failureLink: "https://github.com/org/repo/actions/runs/123/job/456",
        },
        { name: "@fundable/mobile", status: "skipped" },
      ],
    };

    const res = generatePrSummary(report);
    expect(res.hasFailures).toBe(true);
    expect(res.markdown).toContain("❌ Tests Failed");
    expect(res.markdown).toContain("Failed:** 1");
    expect(res.markdown).toContain("Skipped:** 1");
    expect(res.markdown).toContain("[View Logs](https://github.com/org/repo/actions/runs/123/job/456)");
    expect(res.markdown).toContain("One or more packages failed checks");
  });
});
