// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeSeverity,
  meetsOrExceedsSeverity,
  resolveRemediationOwner,
  validateSuppressionEntry,
  evaluateLicenseCompliance,
  parsePnpmAuditReport,
  parseCargoAuditReport,
  evaluateDependencyAuditGate,
  type DependencyAuditPolicy,
  type VulnerabilityFinding,
  type LicenseFinding,
} from "./dependency-audit-policy";

const canonicalPolicyPath = path.resolve(
  __dirname,
  "../../../../../security/dependency-audit-policy.json"
);
const canonicalPolicy = JSON.parse(
  fs.readFileSync(canonicalPolicyPath, "utf8")
) as DependencyAuditPolicy;

const fixedNow = new Date("2026-10-17T12:00:00.000Z");

function clonePolicy(overrides?: Partial<DependencyAuditPolicy>): DependencyAuditPolicy {
  return {
    ... structuredClone(canonicalPolicy),
    ...overrides,
  };
}

describe("Dependency & License Policy Gate (Issue #98)", () => {
  it("loads valid canonical policy with severity thresholds, allowed/denied licenses, and ownership", () => {
    expect(canonicalPolicy.vulnerabilityPolicy.failOnSeverity).toBe("high");
    expect(canonicalPolicy.vulnerabilityPolicy.maxSuppressionDays).toBe(90);
    expect(canonicalPolicy.licensePolicy.allowedLicenses).toContain("MIT");
    expect(canonicalPolicy.licensePolicy.allowedLicenses).toContain("Apache-2.0");
    expect(canonicalPolicy.licensePolicy.deniedLicenses).toContain("GPL-3.0-only");
    expect(canonicalPolicy.licensePolicy.deniedLicenses).toContain("AGPL-3.0-only");
  });

  it("compares severity levels accurately at and around the threshold boundary", () => {
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
    expect(normalizeSeverity("Medium")).toBe("moderate");
    expect(meetsOrExceedsSeverity("critical", "high")).toBe(true);
    expect(meetsOrExceedsSeverity("high", "high")).toBe(true);
    expect(meetsOrExceedsSeverity("moderate", "high")).toBe(false);
    expect(meetsOrExceedsSeverity("low", "high")).toBe(false);
  });

  it("resolves remediation ownership by workspace package, wildcard contract path, ecosystem, and default", () => {
    expect(resolveRemediationOwner(canonicalPolicy, "pnpm", "@fundable/web")).toBe(
      "@Fundable-Protocol/web-team"
    );
    expect(resolveRemediationOwner(canonicalPolicy, "pnpm", "@fundable/sdk")).toBe(
      "@Fundable-Protocol/sdk-team"
    );
    expect(
      resolveRemediationOwner(canonicalPolicy, "cargo", "contracts/payment-stream")
    ).toBe("@Fundable-Protocol/contracts-team");
    expect(resolveRemediationOwner(canonicalPolicy, "pnpm", "unmapped-pkg")).toBe(
      "@Fundable-Protocol/frontend-sdk-team"
    );
  });

  it("passes when pnpm and Cargo findings are below the severity threshold and licenses are permissive", () => {
    const vulnerabilities: VulnerabilityFinding[] = [
      {
        id: "GHSA-low-1111",
        package: "postcss",
        version: "8.4.0",
        ecosystem: "pnpm",
        severity: "low",
        title: "Minor regex complexity in dev build",
        workspacePackage: "@fundable/web",
      },
      {
        id: "RUSTSEC-2026-0010",
        package: "wee_alloc",
        version: "0.4.5",
        ecosystem: "cargo",
        severity: "moderate",
        title: "Unmaintained crate warning",
        workspacePackage: "contracts/payment-stream",
      },
    ];

    const licenses: LicenseFinding[] = [
      { package: "react", ecosystem: "pnpm", license: "MIT" },
      { package: "soroban-sdk", ecosystem: "cargo", license: "Apache-2.0" },
      { package: "dual-licensed-crate", ecosystem: "cargo", license: "(MIT OR Apache-2.0)" },
      { package: "compound-permissive", ecosystem: "pnpm", license: "MIT AND BSD-3-Clause" },
    ];

    const result = evaluateDependencyAuditGate({
      policy: clonePolicy(),
      vulnerabilities,
      licenses,
      now: fixedNow,
    });

    expect(result.passed).toBe(true);
    expect(result.blockingVulnerabilities).toHaveLength(0);
    expect(result.nonBlockingVulnerabilities).toHaveLength(2);
    expect(result.licenseViolations).toHaveLength(0);
    expect(result.suppressionViolations).toHaveLength(0);
    expect(result.summaryMarkdown).toContain("PASSED");
  });

  it("fails when unsuppressed high or critical vulnerabilities exist in pnpm or Cargo", () => {
    const pnpmReport = {
      advisories: {
        "1099": {
          id: 1099,
          github_advisory_id: "GHSA-crit-9999",
          module_name: "ws",
          severity: "critical",
          title: "Remote DoS in frame parser",
          patched_versions: ">=8.17.1",
          findings: [{ version: "8.10.0", paths: ["apps/web>ws"] }],
        },
      },
    };
    const cargoReport = {
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: "RUSTSEC-2026-0099",
              package: "ed25519-dalek",
              title: "Double public key signing oracle",
              severity: "high",
            },
            package: { name: "ed25519-dalek", version: "1.0.1" },
            versions: { patched: [">=2.0.0"] },
          },
        ],
      },
    };

    const parsedVulns = [
      ...parsePnpmAuditReport(pnpmReport),
      ...parseCargoAuditReport(cargoReport),
    ];
    expect(parsedVulns).toHaveLength(2);

    const result = evaluateDependencyAuditGate({
      policy: clonePolicy(),
      vulnerabilities: parsedVulns,
      licenses: [],
      now: fixedNow,
    });

    expect(result.passed).toBe(false);
    expect(result.blockingVulnerabilities).toHaveLength(2);
    expect(result.blockingVulnerabilities[0].owner).toBe("@Fundable-Protocol/web-team");
    expect(result.blockingVulnerabilities[0].slaDays).toBe(1);
    expect(result.blockingVulnerabilities[1].owner).toBe("@Fundable-Protocol/contracts-team");
    expect(result.blockingVulnerabilities[1].slaDays).toBe(7);
  });

  it("allows high/critical findings when covered by an active, non-expired suppression with valid owner", () => {
    const policy = clonePolicy({
      suppressions: [
        {
          id: "GHSA-high-2222",
          package: "xml2js",
          ecosystem: "pnpm",
          reason: "Only invoked on trusted build-time fixtures; upgrade scheduled in Sprint 42",
          owner: "@Fundable-Protocol/sdk-team",
          createdAt: "2026-10-01T00:00:00.000Z",
          expiresAt: "2026-11-15T00:00:00.000Z",
          trackingIssue: "#98",
        },
      ],
    });

    const result = evaluateDependencyAuditGate({
      policy,
      vulnerabilities: [
        {
          id: "GHSA-high-2222",
          package: "xml2js",
          ecosystem: "pnpm",
          severity: "high",
          title: "Prototype pollution in xml2js",
          workspacePackage: "@fundable/sdk",
        },
      ],
      licenses: [],
      now: fixedNow,
    });

    expect(result.passed).toBe(true);
    expect(result.blockingVulnerabilities).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0].suppression?.owner).toBe(
      "@Fundable-Protocol/sdk-team"
    );
  });

  it("fails policy gate when a suppression is expired, at exact expiration boundary, missing owner, or exceeds max TTL", () => {
    // 1. Exact expiration boundary (expiresAt === now) -> EXPIRED_SUPPRESSION
    const boundaryViolation = validateSuppressionEntry(
      {
        id: "GHSA-exp-0001",
        package: "semver",
        ecosystem: "pnpm",
        reason: "Temporary waiver",
        owner: "@Fundable-Protocol/web-team",
        expiresAt: fixedNow.toISOString(),
      },
      90,
      fixedNow
    );
    expect(boundaryViolation?.reason).toBe("EXPIRED_SUPPRESSION");

    // 2. Exceeds maxSuppressionDays (90d) -> SUPPRESSION_TTL_EXCEEDED
    const ttlViolation = validateSuppressionEntry(
      {
        id: "RUSTSEC-2026-0050",
        package: "curve25519-dalek",
        ecosystem: "cargo",
        reason: "Waiting on upstream Soroban SDK bump",
        owner: "@Fundable-Protocol/contracts-team",
        createdAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2027-06-01T00:00:00.000Z",
      },
      90,
      fixedNow
    );
    expect(ttlViolation?.reason).toBe("SUPPRESSION_TTL_EXCEEDED");

    // 3. Missing @owner handle -> INVALID_SUPPRESSION_METADATA
    const metadataViolation = validateSuppressionEntry(
      {
        id: "GHSA-bad-meta",
        package: "axios",
        ecosystem: "pnpm",
        reason: "Temporary",
        owner: "",
        expiresAt: "2026-11-01T00:00:00.000Z",
      },
      90,
      fixedNow
    );
    expect(metadataViolation?.reason).toBe("INVALID_SUPPRESSION_METADATA");
  });

  it("fails policy gate on denied copyleft, unknown, or missing licenses", () => {
    expect(
      evaluateLicenseCompliance("GPL-3.0-only", canonicalPolicy.licensePolicy)
    ).toEqual({ allowed: false, reason: "DENIED_LICENSE" });

    expect(
      evaluateLicenseCompliance("MIT AND AGPL-3.0-only", canonicalPolicy.licensePolicy)
    ).toEqual({ allowed: false, reason: "DENIED_LICENSE" });

    expect(
      evaluateLicenseCompliance("Proprietary-Custom-1.0", canonicalPolicy.licensePolicy)
    ).toEqual({ allowed: false, reason: "UNKNOWN_OR_UNAPPROVED_LICENSE" });

    expect(
      evaluateLicenseCompliance("", canonicalPolicy.licensePolicy)
    ).toEqual({ allowed: false, reason: "MISSING_LICENSE" });

    const gateResult = evaluateDependencyAuditGate({
      policy: clonePolicy(),
      vulnerabilities: [],
      licenses: [
        {
          package: "copyleft-lib",
          version: "1.2.0",
          ecosystem: "pnpm",
          license: "AGPL-3.0-only",
          workspacePackage: "@fundable/web",
        },
      ],
      now: fixedNow,
    });

    expect(gateResult.passed).toBe(false);
    expect(gateResult.licenseViolations).toHaveLength(1);
    expect(gateResult.licenseViolations[0].reason).toBe("DENIED_LICENSE");
    expect(gateResult.licenseViolations[0].owner).toBe("@Fundable-Protocol/web-team");
  });
});
