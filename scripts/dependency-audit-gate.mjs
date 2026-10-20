#!/usr/bin/env node
/**
 * CLI runner for the pnpm and Cargo dependency & license policy gate — issue #98
 *
 * Usage:
 *   node scripts/dependency-audit-gate.mjs [--pnpm-audit <file>] [--cargo-audit <file>]
 */

import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const policyPath = path.join(rootDir, "security", "dependency-audit-policy.json");

if (!fs.existsSync(policyPath)) {
  console.error(`❌ Policy file not found: ${policyPath}`);
  process.exit(1);
}

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const now = new Date();

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const threshold = policy.vulnerabilityPolicy?.failOnSeverity ?? "high";
const maxSuppressionDays = policy.vulnerabilityPolicy?.maxSuppressionDays ?? 90;

const suppressionViolations = [];
const activeSuppressions = new Map();

for (const sup of policy.suppressions ?? []) {
  if (!sup.id || !sup.package || !sup.reason || !sup.owner?.startsWith("@")) {
    suppressionViolations.push(
      `Invalid suppression metadata for ${sup.id ?? "<missing>"}`
    );
    continue;
  }
  const expiresMs = Date.parse(sup.expiresAt);
  if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) {
    suppressionViolations.push(
      `Expired suppression ${sup.id} (${sup.package}) owned by ${sup.owner} (expired ${sup.expiresAt})`
    );
    continue;
  }
  const createdMs = sup.createdAt ? Date.parse(sup.createdAt) : now.getTime();
  if (expiresMs - createdMs > maxSuppressionDays * 86_400_000) {
    suppressionViolations.push(
      `Suppression ${sup.id} exceeds max window of ${maxSuppressionDays} days`
    );
    continue;
  }
  activeSuppressions.set(`${sup.ecosystem}:${sup.package}:${sup.id}`, sup);
}

// Check Cargo workspace license declaration
const cargoTomlPath = path.join(rootDir, "contracts", "Cargo.toml");
const licenseViolations = [];
if (fs.existsSync(cargoTomlPath)) {
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const licenseMatch = cargoToml.match(/^\s*license\s*=\s*"([^"]+)"/m);
  const cargoLicense = licenseMatch?.[1] ?? "UNKNOWN";
  if (!policy.licensePolicy.allowedLicenses.includes(cargoLicense)) {
    licenseViolations.push(
      `Cargo workspace license "${cargoLicense}" is not in allowedLicenses`
    );
  }
}

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

const blockingVulnerabilities = [];
const pnpmAuditFile = getArg("--pnpm-audit");
if (pnpmAuditFile && fs.existsSync(pnpmAuditFile)) {
  const report = JSON.parse(fs.readFileSync(pnpmAuditFile, "utf8"));
  for (const [key, adv] of Object.entries(report.advisories ?? {})) {
    const id = String(adv.github_advisory_id || adv.id || key);
    const pkg = adv.module_name ?? "unknown";
    const sev = (adv.severity ?? "info").toLowerCase();
    const rank = SEVERITY_RANK[sev] ?? 0;
    if (
      rank >= SEVERITY_RANK[threshold] &&
      !activeSuppressions.has(`pnpm:${pkg}:${id}`)
    ) {
      blockingVulnerabilities.push(`pnpm:${pkg} (${id}, severity=${sev})`);
    }
  }
}

const cargoAuditFile = getArg("--cargo-audit");
if (cargoAuditFile && fs.existsSync(cargoAuditFile)) {
  const report = JSON.parse(fs.readFileSync(cargoAuditFile, "utf8"));
  for (const item of report.vulnerabilities?.list ?? []) {
    const id = item.advisory?.id ?? "RUSTSEC-UNKNOWN";
    const pkg = item.package?.name ?? "unknown";
    const sev = (item.advisory?.severity ?? "high").toLowerCase();
    const rank = SEVERITY_RANK[sev] ?? 3;
    if (
      rank >= SEVERITY_RANK[threshold] &&
      !activeSuppressions.has(`cargo:${pkg}:${id}`)
    ) {
      blockingVulnerabilities.push(`cargo:${pkg} (${id}, severity=${sev})`);
    }
  }
}

const passed =
  suppressionViolations.length === 0 &&
  licenseViolations.length === 0 &&
  blockingVulnerabilities.length === 0;

console.log(`=== Dependency & License Policy Gate (${passed ? "PASSED" : "FAILED"}) ===`);
console.log(`Threshold severity : ${threshold}`);
console.log(`Active suppressions: ${activeSuppressions.size}`);
console.log(`Blocking vulns     : ${blockingVulnerabilities.length}`);
console.log(`License violations : ${licenseViolations.length}`);
console.log(`Suppression errors : ${suppressionViolations.length}`);

if (!passed) {
  for (const err of [
    ...suppressionViolations,
    ...licenseViolations,
    ...blockingVulnerabilities,
  ]) {
    console.error(`  ❌ ${err}`);
  }
  process.exit(1);
}
