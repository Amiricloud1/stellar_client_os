import fs from "node:fs";
import path from "node:path";

export interface PackageCheckStatus {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationSeconds?: number;
  failureLink?: string;
  errorDetails?: string;
}

export interface ArtifactSizeInfo {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface PrCheckReport {
  packages: PackageCheckStatus[];
  artifacts?: ArtifactSizeInfo[];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Generates a clean Markdown summary for PR check runs.
 * Reports tested/skipped packages, artifact sizes, and actionable failure links
 * without masking failed jobs.
 */
export function generatePrSummary(report: PrCheckReport): {
  markdown: string;
  hasFailures: boolean;
} {
  const hasFailures = report.packages.some((p) => p.status === "failed");
  const passedCount = report.packages.filter((p) => p.status === "passed").length;
  const failedCount = report.packages.filter((p) => p.status === "failed").length;
  const skippedCount = report.packages.filter((p) => p.status === "skipped").length;

  const lines: string[] = [];
  lines.push("## Pull Request Checks Summary");
  lines.push("");
  lines.push(
    `**Status:** ${hasFailures ? "❌ Tests Failed" : "✅ All Checks Passed"} | ` +
      `**Passed:** ${passedCount} | **Failed:** ${failedCount} | **Skipped:** ${skippedCount}`
  );
  lines.push("");

  lines.push("### Package Test Results");
  lines.push("| Package | Status | Duration | Actionable Failure Link |");
  lines.push("|---|:---:|:---:|---|");

  for (const pkg of report.packages) {
    const icon =
      pkg.status === "passed"
        ? "✅ Passed"
        : pkg.status === "failed"
        ? "❌ Failed"
        : "⚪ Skipped";
    const duration = pkg.durationSeconds !== undefined ? `${pkg.durationSeconds}s` : "-";
    const link = pkg.failureLink ? `[View Logs](${pkg.failureLink})` : "-";
    lines.push(`| \`${pkg.name}\` | ${icon} | ${duration} | ${link} |`);
  }
  lines.push("");

  if (report.artifacts && report.artifacts.length > 0) {
    lines.push("### Artifact Sizes");
    lines.push("| Artifact | Path | Size |");
    lines.push("|---|---|:---:|");
    for (const art of report.artifacts) {
      lines.push(`| **${art.name}** | \`${art.path}\` | ${formatBytes(art.sizeBytes)} |`);
    }
    lines.push("");
  }

  if (hasFailures) {
    lines.push("> [!CAUTION]");
    lines.push("> One or more packages failed checks. Review log links above for actionable diagnostic details.");
  }

  return {
    markdown: lines.join("\n"),
    hasFailures,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Demo / CI hook: write to GITHUB_STEP_SUMMARY if available
  const sampleReport: PrCheckReport = {
    packages: [
      { name: "@fundable/sdk", status: "passed", durationSeconds: 4 },
      { name: "@fundable/web", status: "passed", durationSeconds: 12 },
      { name: "@fundable/mobile", status: "skipped" },
      { name: "contracts", status: "passed", durationSeconds: 18 },
    ],
    artifacts: [
      { name: "SDK ESM bundle", path: "packages/sdk/dist/esm", sizeBytes: 154200 },
      { name: "Contracts WASM (opt)", path: "target/wasm32-unknown-unknown/release", sizeBytes: 890400 },
    ],
  };

  const { markdown, hasFailures } = generatePrSummary(sampleReport);
  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }

  if (hasFailures) {
    process.exit(1);
  }
}
