/**
 * Dependency & License Audit Policy Gate — issue #98
 *
 * Enforces vulnerability severity thresholds, SPDX license allow/deny gates,
 * time-bounded expiring suppressions, and remediation ownership assignment
 * across both `pnpm` (Node/TypeScript workspaces) and `Cargo` (Soroban Rust
 * smart contract workspaces).
 */

export type AuditEcosystem = "pnpm" | "cargo";

export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export const SEVERITY_RANK: Record<AuditSeverity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export interface SuppressionEntry {
  /** Advisory or license rule identifier (e.g. "GHSA-xxxx-xxxx-xxxx", "RUSTSEC-2026-0001", "LICENSE:pkg"). */
  id: string;
  /** Package or crate name to which the suppression applies. */
  package: string;
  /** Target package ecosystem. */
  ecosystem: AuditEcosystem;
  /** Explicit engineering justification for temporary risk acceptance. */
  reason: string;
  /** Accountable team or maintainer handle (must start with `@`). */
  owner: string;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
  /** ISO-8601 expiration timestamp (hard deadline for remediation). */
  expiresAt: string;
  /** Tracking issue reference (e.g. "#98" or URL). */
  trackingIssue?: string;
}

export interface DependencyAuditPolicy {
  version: string;
  vulnerabilityPolicy: {
    failOnSeverity: AuditSeverity;
    maxSuppressionDays: number;
    remediationSlaDays: Record<AuditSeverity, number>;
  };
  licensePolicy: {
    allowedLicenses: string[];
    deniedLicenses: string[];
    failOnUnknownLicense: boolean;
  };
  ownership: {
    defaultOwner: string;
    ecosystems: Record<AuditEcosystem, string>;
    packages: Record<string, string>;
  };
  suppressions: SuppressionEntry[];
}

export interface VulnerabilityFinding {
  id: string;
  package: string;
  version?: string;
  ecosystem: AuditEcosystem;
  severity: AuditSeverity;
  title: string;
  url?: string;
  workspacePackage?: string;
  patchedVersions?: string;
}

export interface LicenseFinding {
  package: string;
  version?: string;
  ecosystem: AuditEcosystem;
  license: string;
  workspacePackage?: string;
}

export interface EnrichedVulnerabilityFinding extends VulnerabilityFinding {
  owner: string;
  slaDays: number;
  remediationDueAt: string;
  suppressed: boolean;
  suppression?: SuppressionEntry;
}

export interface LicenseViolation {
  package: string;
  version?: string;
  ecosystem: AuditEcosystem;
  license: string;
  reason: "DENIED_LICENSE" | "UNKNOWN_OR_UNAPPROVED_LICENSE" | "MISSING_LICENSE";
  owner: string;
}

export interface SuppressionViolation {
  suppressionId: string;
  package: string;
  ecosystem: AuditEcosystem;
  owner: string;
  reason:
    | "EXPIRED_SUPPRESSION"
    | "SUPPRESSION_TTL_EXCEEDED"
    | "INVALID_SUPPRESSION_METADATA";
  message: string;
}

export interface AuditGateEvaluationResult {
  passed: boolean;
  evaluatedAt: string;
  thresholdSeverity: AuditSeverity;
  blockingVulnerabilities: EnrichedVulnerabilityFinding[];
  nonBlockingVulnerabilities: EnrichedVulnerabilityFinding[];
  suppressedFindings: EnrichedVulnerabilityFinding[];
  licenseViolations: LicenseViolation[];
  suppressionViolations: SuppressionViolation[];
  summaryMarkdown: string;
}

/**
 * Normalize severity strings from pnpm/npm/Cargo/RustSec advisories.
 */
export function normalizeSeverity(raw: string | undefined | null): AuditSeverity {
  const lower = (raw ?? "info").toLowerCase().trim();
  if (lower === "critical") return "critical";
  if (lower === "high") return "high";
  if (lower === "moderate" || lower === "medium") return "moderate";
  if (lower === "low") return "low";
  return "info";
}

/**
 * Returns true when `severity` is greater than or equal to `threshold`.
 */
export function meetsOrExceedsSeverity(
  severity: AuditSeverity,
  threshold: AuditSeverity
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

/**
 * Resolve the accountable remediation owner for a package or workspace target.
 */
export function resolveRemediationOwner(
  policy: DependencyAuditPolicy,
  ecosystem: AuditEcosystem,
  workspaceOrPackage?: string
): string {
  if (workspaceOrPackage) {
    if (policy.ownership.packages[workspaceOrPackage]) {
      return policy.ownership.packages[workspaceOrPackage];
    }
    if (
      workspaceOrPackage.startsWith("contracts/") &&
      policy.ownership.packages["contracts/*"]
    ) {
      return policy.ownership.packages["contracts/*"];
    }
  }
  return (
    policy.ownership.ecosystems[ecosystem] ??
    policy.ownership.defaultOwner ??
    "@Fundable-Protocol/security"
  );
}

/**
 * Validate a suppression entry for required ownership, justification, and expiration bounds.
 */
export function validateSuppressionEntry(
  entry: SuppressionEntry,
  maxSuppressionDays: number,
  now: Date = new Date()
): SuppressionViolation | null {
  if (
    !entry.id?.trim() ||
    !entry.package?.trim() ||
    !entry.reason?.trim() ||
    !entry.owner?.trim() ||
    !entry.owner.trim().startsWith("@")
  ) {
    return {
      suppressionId: entry.id || "<missing-id>",
      package: entry.package || "<missing-package>",
      ecosystem: entry.ecosystem,
      owner: entry.owner || "<unassigned>",
      reason: "INVALID_SUPPRESSION_METADATA",
      message: `Suppression for ${entry.package || "unknown"} must specify a non-empty id, package, reason, and @owner handle`,
    };
  }

  const expiresMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiresMs)) {
    return {
      suppressionId: entry.id,
      package: entry.package,
      ecosystem: entry.ecosystem,
      owner: entry.owner,
      reason: "INVALID_SUPPRESSION_METADATA",
      message: `Suppression ${entry.id} has an invalid ISO-8601 expiresAt timestamp: ${entry.expiresAt}`,
    };
  }

  if (expiresMs <= now.getTime()) {
    return {
      suppressionId: entry.id,
      package: entry.package,
      ecosystem: entry.ecosystem,
      owner: entry.owner,
      reason: "EXPIRED_SUPPRESSION",
      message: `Suppression ${entry.id} for ${entry.package} (${entry.owner}) expired at ${entry.expiresAt}`,
    };
  }

  const anchorMs = entry.createdAt ? Date.parse(entry.createdAt) : now.getTime();
  const baseMs = Number.isNaN(anchorMs) ? now.getTime() : anchorMs;
  const maxHorizonMs = maxSuppressionDays * 24 * 60 * 60 * 1_000;
  if (expiresMs - baseMs > maxHorizonMs) {
    return {
      suppressionId: entry.id,
      package: entry.package,
      ecosystem: entry.ecosystem,
      owner: entry.owner,
      reason: "SUPPRESSION_TTL_EXCEEDED",
      message: `Suppression ${entry.id} for ${entry.package} exceeds maximum allowed suppression window of ${maxSuppressionDays} days`,
    };
  }

  return null;
}

/**
 * Evaluate an SPDX license string or compound expression (`MIT OR Apache-2.0`,
 * `(MIT AND BSD-3-Clause)`) against the license policy.
 */
export function evaluateLicenseCompliance(
  licenseExpr: string | undefined | null,
  licensePolicy: DependencyAuditPolicy["licensePolicy"]
): { allowed: boolean; reason?: LicenseViolation["reason"] } {
  const raw = (licenseExpr ?? "").trim();
  if (!raw || raw.toUpperCase() === "UNKNOWN") {
    return { allowed: false, reason: "MISSING_LICENSE" };
  }

  const allowedSet = new Set(licensePolicy.allowedLicenses);
  const deniedSet = new Set(licensePolicy.deniedLicenses);

  const cleaned = raw.replace(/[()]/g, " ").trim();

  // Handle OR expressions: satisfied if at least one branch is allowed and none is unconditionally required denied
  if (/\s+OR\s+/i.test(cleaned) && !/\s+AND\s+/i.test(cleaned)) {
    const alternatives = cleaned.split(/\s+OR\s+/i).map((s) => s.trim()).filter(Boolean);
    if (alternatives.some((alt) => allowedSet.has(alt))) {
      return { allowed: true };
    }
    if (alternatives.every((alt) => deniedSet.has(alt))) {
      return { allowed: false, reason: "DENIED_LICENSE" };
    }
    return {
      allowed: !licensePolicy.failOnUnknownLicense,
      reason: licensePolicy.failOnUnknownLicense
        ? "UNKNOWN_OR_UNAPPROVED_LICENSE"
        : undefined,
    };
  }

  // Handle AND or single license tokens: every required license token must be allowed and none denied
  const tokens = cleaned
    .split(/\s+(?:AND|OR|\/)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const token of tokens) {
    if (deniedSet.has(token) || /^(?:A?GPL|SSPL)-/i.test(token)) {
      return { allowed: false, reason: "DENIED_LICENSE" };
    }
  }

  for (const token of tokens) {
    if (!allowedSet.has(token)) {
      if (licensePolicy.failOnUnknownLicense) {
        return { allowed: false, reason: "UNKNOWN_OR_UNAPPROVED_LICENSE" };
      }
    }
  }

  return { allowed: true };
}

/**
 * Parse `pnpm audit --json` output into normalized `VulnerabilityFinding[]`.
 */
export function parsePnpmAuditReport(report: unknown): VulnerabilityFinding[] {
  if (!report || typeof report !== "object") return [];
  const findings: VulnerabilityFinding[] = [];
  const obj = report as {
    advisories?: Record<
      string,
      {
        id?: number | string;
        github_advisory_id?: string;
        module_name?: string;
        severity?: string;
        title?: string;
        url?: string;
        patched_versions?: string;
        findings?: Array<{ version?: string; paths?: string[] }>;
      }
    >;
  };

  if (obj.advisories && typeof obj.advisories === "object") {
    for (const [key, adv] of Object.entries(obj.advisories)) {
      const id = String(adv.github_advisory_id || adv.id || key);
      const pkg = adv.module_name ?? "unknown";
      const version = adv.findings?.[0]?.version;
      const firstPath = adv.findings?.[0]?.paths?.[0] ?? "";
      const workspacePkg = firstPath.startsWith("apps/web")
        ? "@fundable/web"
        : firstPath.startsWith("packages/sdk")
          ? "@fundable/sdk"
          : firstPath.startsWith("apps/mobile")
            ? "@fundable/mobile"
            : undefined;

      findings.push({
        id,
        package: pkg,
        version,
        ecosystem: "pnpm",
        severity: normalizeSeverity(adv.severity),
        title: adv.title ?? `Advisory ${id}`,
        url: adv.url,
        workspacePackage: workspacePkg,
        patchedVersions: adv.patched_versions,
      });
    }
  }

  return findings;
}

/**
 * Parse `cargo audit --json` output into normalized `VulnerabilityFinding[]`.
 */
export function parseCargoAuditReport(report: unknown): VulnerabilityFinding[] {
  if (!report || typeof report !== "object") return [];
  const findings: VulnerabilityFinding[] = [];
  const obj = report as {
    vulnerabilities?: {
      list?: Array<{
        advisory?: {
          id?: string;
          package?: string;
          title?: string;
          url?: string;
          severity?: string;
          cvss?: string;
        };
        package?: {
          name?: string;
          version?: string;
        };
        versions?: {
          patched?: string[];
        };
      }>;
    };
  };

  const list = obj.vulnerabilities?.list;
  if (Array.isArray(list)) {
    for (const item of list) {
      const id = item.advisory?.id ?? "RUSTSEC-UNKNOWN";
      const pkg = item.package?.name ?? item.advisory?.package ?? "unknown";
      const severity = normalizeSeverity(item.advisory?.severity ?? "high");
      findings.push({
        id,
        package: pkg,
        version: item.package?.version,
        ecosystem: "cargo",
        severity,
        title: item.advisory?.title ?? `RustSec advisory ${id}`,
        url: item.advisory?.url,
        workspacePackage: "contracts/*",
        patchedVersions: item.versions?.patched?.join(", "),
      });
    }
  }

  return findings;
}

/**
 * Evaluate all vulnerability and license findings against the policy gate.
 */
export function evaluateDependencyAuditGate(input: {
  policy: DependencyAuditPolicy;
  vulnerabilities: VulnerabilityFinding[];
  licenses: LicenseFinding[];
  now?: Date;
}): AuditGateEvaluationResult {
  const now = input.now ?? new Date();
  const { policy } = input;
  const threshold = policy.vulnerabilityPolicy.failOnSeverity;

  const suppressionViolations: SuppressionViolation[] = [];
  const activeSuppressions = new Map<string, SuppressionEntry>();

  for (const sup of policy.suppressions) {
    const violation = validateSuppressionEntry(
      sup,
      policy.vulnerabilityPolicy.maxSuppressionDays,
      now
    );
    if (violation) {
      suppressionViolations.push(violation);
    } else {
      activeSuppressions.set(`${sup.ecosystem}:${sup.package}:${sup.id}`, sup);
      activeSuppressions.set(`${sup.ecosystem}:*:${sup.id}`, sup);
    }
  }

  const blockingVulnerabilities: EnrichedVulnerabilityFinding[] = [];
  const nonBlockingVulnerabilities: EnrichedVulnerabilityFinding[] = [];
  const suppressedFindings: EnrichedVulnerabilityFinding[] = [];

  for (const vuln of input.vulnerabilities) {
    const owner = resolveRemediationOwner(
      policy,
      vuln.ecosystem,
      vuln.workspacePackage ?? vuln.package
    );
    const slaDays =
      policy.vulnerabilityPolicy.remediationSlaDays[vuln.severity] ?? 30;
    const remediationDueAt = new Date(
      now.getTime() + slaDays * 24 * 60 * 60 * 1_000
    ).toISOString();

    const matchedSuppression =
      activeSuppressions.get(`${vuln.ecosystem}:${vuln.package}:${vuln.id}`) ??
      activeSuppressions.get(`${vuln.ecosystem}:*:${vuln.id}`);

    const enriched: EnrichedVulnerabilityFinding = {
      ...vuln,
      owner,
      slaDays,
      remediationDueAt,
      suppressed: Boolean(matchedSuppression),
      ...(matchedSuppression ? { suppression: matchedSuppression } : {}),
    };

    if (matchedSuppression) {
      suppressedFindings.push(enriched);
    } else if (meetsOrExceedsSeverity(vuln.severity, threshold)) {
      blockingVulnerabilities.push(enriched);
    } else {
      nonBlockingVulnerabilities.push(enriched);
    }
  }

  const licenseViolations: LicenseViolation[] = [];
  for (const item of input.licenses) {
    const licenseSupKey = `${item.ecosystem}:${item.package}:LICENSE:${item.license}`;
    if (activeSuppressions.has(licenseSupKey)) {
      continue;
    }

    const check = evaluateLicenseCompliance(item.license, policy.licensePolicy);
    if (!check.allowed && check.reason) {
      licenseViolations.push({
        package: item.package,
        version: item.version,
        ecosystem: item.ecosystem,
        license: item.license,
        reason: check.reason,
        owner: resolveRemediationOwner(
          policy,
          item.ecosystem,
          item.workspacePackage ?? item.package
        ),
      });
    }
  }

  const passed =
    blockingVulnerabilities.length === 0 &&
    licenseViolations.length === 0 &&
    suppressionViolations.length === 0;

  const summaryLines = [
    `## Dependency & License Policy Gate: ${passed ? "PASSED" : "FAILED"}`,
    `- **Evaluated At:** \`${now.toISOString()}\``,
    `- **Severity Threshold:** \`${threshold}\``,
    `- **Blocking Vulnerabilities:** ${blockingVulnerabilities.length}`,
    `- **Suppressed Findings:** ${suppressedFindings.length}`,
    `- **Non-Blocking Findings:** ${nonBlockingVulnerabilities.length}`,
    `- **License Violations:** ${licenseViolations.length}`,
    `- **Suppression Policy Violations:** ${suppressionViolations.length}`,
  ];

  return {
    passed,
    evaluatedAt: now.toISOString(),
    thresholdSeverity: threshold,
    blockingVulnerabilities,
    nonBlockingVulnerabilities,
    suppressedFindings,
    licenseViolations,
    suppressionViolations,
    summaryMarkdown: summaryLines.join("\n"),
  };
}
