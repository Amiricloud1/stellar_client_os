/**
 * scripts/validate-manifest.ts
 *
 * Validates one or more deployment manifest JSON files against the schema
 * described in docs/deployment-manifest.md.
 *
 * Usage:
 *   npx tsx scripts/validate-manifest.ts                    # validates all deployments/*.json
 *   npx tsx scripts/validate-manifest.ts deployments/mainnet.json
 *   pnpm validate-manifest
 *
 * Exit codes:
 *   0 – all manifests valid
 *   1 – one or more manifests invalid or file not found
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractEntry {
  contractId: string;
  wasmHash: string;
  version: string;
  ledger: number;
  txHash: string;
  initTxHash?: string;
  sourceCommit?: string;
}

export interface DeploymentManifest {
  $schema?: string;
  network: "testnet" | "mainnet" | "custom";
  networkPassphrase: string;
  rpcUrl?: string;
  deployedAt: string;
  deployer?: string;
  contracts: Record<string, ContractEntry>;
}

export interface ManifestValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.+-]+)?(\+[A-Za-z0-9.+-]+)?$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Detects whether a manifest is in the legacy flat format
 * (e.g. `{ "payment_stream": "C...", "distributor": "C..." }`).
 *
 * The legacy format is still accepted by initialize.sh but is not the
 * canonical manifest format. We warn rather than fail.
 */
function isLegacyFlatFormat(m: Record<string, unknown>): boolean {
  // A manifest in the legacy format has no top-level "network" key and all
  // values are either strings (contract IDs starting with C) or null.
  if (m.network || m.networkPassphrase || m.contracts) return false;
  const values = Object.values(m);
  return (
    values.length > 0 &&
    values.every(
      (v) =>
        v === null ||
        (typeof v === "string" && (v.startsWith("C") || v === ""))
    )
  );
}

/**
 * Validates a single deployment manifest object.
 */
export function validateManifest(
  manifest: unknown,
  filePath: string
): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return {
      file: filePath,
      valid: false,
      errors: ["Manifest must be a JSON object"],
      warnings,
    };
  }

  const m = manifest as Record<string, unknown>;

  // ── Legacy flat format detection ──
  if (isLegacyFlatFormat(m)) {
    warnings.push(
      "File uses the legacy flat format ({ contractName: contractId }). " +
        "Migrate to the full manifest format described in docs/deployment-manifest.md."
    );
    // Validate that every present value is a valid contract ID or null
    for (const [key, val] of Object.entries(m)) {
      if (val === null) continue;
      if (typeof val !== "string" || !CONTRACT_ID_RE.test(val)) {
        errors.push(
          `Legacy entry '${key}': value must be a valid contract address (C…) or null, got '${val}'`
        );
      }
    }
    return { file: filePath, valid: errors.length === 0, errors, warnings };
  }

  // ── network ──
  const allowedNetworks = ["testnet", "mainnet", "custom"];
  if (!m.network || typeof m.network !== "string") {
    errors.push("Missing or invalid field 'network' (expected string)");
  } else if (!allowedNetworks.includes(m.network)) {
    errors.push(
      `Invalid 'network': '${m.network}'. Must be one of: ${allowedNetworks.join(", ")}`
    );
  }

  // ── networkPassphrase ──
  if (!m.networkPassphrase || typeof m.networkPassphrase !== "string") {
    errors.push("Missing or invalid field 'networkPassphrase' (expected string)");
  } else if (m.networkPassphrase.trim().length < 10) {
    errors.push("'networkPassphrase' must be at least 10 characters");
  }

  // ── deployedAt ──
  if (m.deployedAt === undefined || m.deployedAt === null) {
    errors.push("Missing field 'deployedAt' (expected ISO 8601 date-time string)");
  } else if (typeof m.deployedAt !== "string") {
    errors.push("'deployedAt' must be a string");
  } else if (m.deployedAt.trim() === "") {
    // Empty string = unfilled template — warn only
    warnings.push("'deployedAt' is empty — fill in after deployment");
  } else if (!ISO8601_RE.test(m.deployedAt)) {
    errors.push(
      `'deployedAt' must be an ISO 8601 UTC date-time string (e.g. '2026-01-01T00:00:00Z'), got: '${m.deployedAt}'`
    );
  }

  // ── rpcUrl (optional) ──
  if (m.rpcUrl !== undefined) {
    if (typeof m.rpcUrl !== "string") {
      errors.push("'rpcUrl' must be a string");
    } else if (m.rpcUrl.trim() !== "" && !m.rpcUrl.startsWith("https://") && !m.rpcUrl.startsWith("http://")) {
      warnings.push(`'rpcUrl' does not start with http(s)://: '${m.rpcUrl}'`);
    } else if (m.rpcUrl.trim() === "") {
      warnings.push("'rpcUrl' is empty — fill in after deployment");
    }
  }

  // ── deployer (optional in schema, but required for mainnet with a real value) ──
  if (m.deployer !== undefined && m.deployer !== "") {
    if (typeof m.deployer !== "string") {
      errors.push("'deployer' must be a string");
    } else if (!ACCOUNT_RE.test(m.deployer)) {
      errors.push(
        `'deployer' must be a valid Stellar public key matching /^G[A-Z2-7]{55}$/, got: '${m.deployer}'`
      );
    }
  } else if (m.deployer === "" || m.deployer === undefined) {
    if (m.network === "mainnet" && m.contracts && Object.keys(m.contracts as object).length > 0) {
      // Only error when contracts are actually filled in (not a blank template)
      errors.push("'deployer' is required for mainnet manifests once contracts are deployed");
    } else {
      warnings.push("'deployer' is not set — fill in after deployment");
    }
  }

  // ── contracts ──
  if (m.contracts === undefined || m.contracts === null) {
    errors.push("Missing field 'contracts' (expected object)");
    return { file: filePath, valid: errors.length === 0, errors, warnings };
  }
  if (typeof m.contracts !== "object" || Array.isArray(m.contracts)) {
    errors.push("'contracts' must be an object");
    return { file: filePath, valid: errors.length === 0, errors, warnings };
  }

  const contracts = m.contracts as Record<string, unknown>;
  const contractNames = Object.keys(contracts);

  if (contractNames.length === 0) {
    // Empty contracts is acceptable for a blank template
    warnings.push("'contracts' is empty — fill in after deployment");
  }

  for (const [name, entry] of Object.entries(contracts)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`contracts.${name}: must be an object`);
      continue;
    }

    const e = entry as Record<string, unknown>;

    // contractId
    if (!e.contractId || typeof e.contractId !== "string") {
      errors.push(`contracts.${name}.contractId: missing or not a string`);
    } else if (!CONTRACT_ID_RE.test(e.contractId)) {
      errors.push(
        `contracts.${name}.contractId: must match /^C[A-Z2-7]{55}$/, got '${e.contractId}'`
      );
    }

    // wasmHash
    if (!e.wasmHash || typeof e.wasmHash !== "string") {
      errors.push(`contracts.${name}.wasmHash: missing or not a string`);
    } else if (!HEX64_RE.test(e.wasmHash)) {
      errors.push(
        `contracts.${name}.wasmHash: must be 64 lowercase hex characters, got '${e.wasmHash}'`
      );
    }

    // version
    if (!e.version || typeof e.version !== "string") {
      errors.push(`contracts.${name}.version: missing or not a string`);
    } else if (!SEMVER_RE.test(e.version)) {
      warnings.push(
        `contracts.${name}.version: '${e.version}' does not look like a semver version`
      );
    }

    // ledger
    if (e.ledger === undefined || e.ledger === null) {
      errors.push(`contracts.${name}.ledger: missing`);
    } else if (typeof e.ledger !== "number" || !Number.isInteger(e.ledger) || e.ledger < 1) {
      errors.push(
        `contracts.${name}.ledger: must be an integer >= 1, got '${e.ledger}'`
      );
    }

    // txHash
    if (!e.txHash || typeof e.txHash !== "string") {
      errors.push(`contracts.${name}.txHash: missing or not a string`);
    } else if (!HEX64_RE.test(e.txHash)) {
      errors.push(
        `contracts.${name}.txHash: must be 64 lowercase hex characters, got '${e.txHash}'`
      );
    }

    // initTxHash (optional)
    if (e.initTxHash !== undefined) {
      if (typeof e.initTxHash !== "string" || !HEX64_RE.test(e.initTxHash)) {
        errors.push(
          `contracts.${name}.initTxHash: must be 64 lowercase hex characters`
        );
      }
    }

    // sourceCommit (optional)
    if (e.sourceCommit !== undefined) {
      if (typeof e.sourceCommit !== "string" || !HEX40_RE.test(e.sourceCommit)) {
        errors.push(
          `contracts.${name}.sourceCommit: must be 40 lowercase hex characters (full git SHA)`
        );
      }
    }
  }

  return {
    file: filePath,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolves paths to validate. Defaults to all JSON files in deployments/.
 */
function resolveTargetPaths(args: string[], rootDir: string): string[] {
  const filtered = args.filter((a) => !a.startsWith("--"));
  if (filtered.length > 0) {
    return filtered.map((f) => path.resolve(f));
  }
  const deploymentsDir = path.join(rootDir, "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    return [];
  }
  return fs
    .readdirSync(deploymentsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(deploymentsDir, f));
}

export function run(args: string[] = process.argv.slice(2)): { exitCode: number; message: string } {
  const rootDir = path.resolve(__dirname, "..");
  const targets = resolveTargetPaths(args, rootDir);

  if (targets.length === 0) {
    return {
      exitCode: 1,
      message: "No manifest files found. Pass a path or ensure deployments/*.json exists.",
    };
  }

  let allValid = true;
  const summaryLines: string[] = [];

  for (const filePath of targets) {
    const relative = path.relative(rootDir, filePath);

    if (!fs.existsSync(filePath)) {
      console.error(`✗ File not found: ${relative}`);
      allValid = false;
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err: any) {
      console.error(`✗ ${relative}: JSON parse error — ${err.message}`);
      allValid = false;
      continue;
    }

    const result = validateManifest(raw, relative);

    for (const warning of result.warnings) {
      console.warn(`  [warn] ${relative}: ${warning}`);
    }

    if (result.valid) {
      console.log(`✓ ${relative} is valid`);
      summaryLines.push(`  ✓ ${relative}`);
    } else {
      console.error(`✗ ${relative}: validation failed`);
      for (const err of result.errors) {
        console.error(`    - ${err}`);
      }
      allValid = false;
      summaryLines.push(`  ✗ ${relative} (${result.errors.length} error(s))`);
    }
  }

  if (allValid) {
    return {
      exitCode: 0,
      message: `All ${targets.length} manifest(s) valid.\n${summaryLines.join("\n")}`,
    };
  }
  return {
    exitCode: 1,
    message: `One or more manifests failed validation.\n${summaryLines.join("\n")}`,
  };
}

// Execute when run directly
if (
  process.argv[1] &&
  (process.argv[1].endsWith("validate-manifest.ts") ||
    process.argv[1].endsWith("validate-manifest.js"))
) {
  const result = run();
  console.log(result.message);
  process.exit(result.exitCode);
}
