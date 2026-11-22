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
 *
 * Registry fields
 * ---------------
 * Every contract entry in a manifest is part of the validated deployment
 * registry. Each entry records the following fields:
 *
 *   network          – network the contract is deployed to. Must match the
 *                      manifest-level `network` ("testnet" | "mainnet" |
 *                      "custom"). Optional per entry; when present it must
 *                      agree with the manifest.
 *   address          – the contract's on-chain address (C…). May be supplied
 *                      as `address` or as the legacy alias `contractId`; at
 *                      least one must be present and both must agree when
 *                      both are given.
 *   deploymentLedger – ledger sequence at which the deployment was applied.
 *                      May be supplied as `deploymentLedger` or as the legacy
 *                      alias `ledger`; must be an integer >= 1.
 *   specVersion      – version of the contract spec (semver). May be supplied
 *                      as `specVersion` or as the legacy alias `version`.
 *   lifecycleState   – required lifecycle state of the deployment. Must be one
 *                      of: "pending", "deployed", "active", "paused",
 *                      "deprecated", "retired", "failed". Missing or unknown
 *                      states are rejected so operators always know whether a
 *                      deployment is live, degraded, or retired.
 *
 * Legacy aliases (`contractId`, `ledger`, `version`) remain accepted for
 * backwards compatibility; new manifests should use the canonical names.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle states a deployment may be in. Kept in sync with
 * docs/deployment-manifest.md and the registry consumers.
 */
export const LIFECYCLE_STATES = [
  "pending",
  "deployed",
  "active",
  "paused",
  "deprecated",
  "retired",
  "failed",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export interface ContractEntry {
  /** Canonical contract address (C…). */
  address: string;
  /** @deprecated legacy alias for `address`; still accepted. */
  contractId?: string;
  wasmHash: string;
  /** Contract spec version (semver). */
  specVersion: string;
  /** @deprecated legacy alias for `specVersion`; still accepted. */
  version?: string;
  /** Ledger sequence of the deployment. */
  deploymentLedger: number;
  /** @deprecated legacy alias for `deploymentLedger`; still accepted. */
  ledger?: number;
  /** Network the contract is deployed to; must match the manifest. */
  network?: "testnet" | "mainnet" | "custom";
  /** Required lifecycle state of the deployment. */
  lifecycleState: LifecycleState;
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

    // ── address (canonical) / contractId (legacy alias) ──
    const address = e.address;
    const contractId = e.contractId;
    if (address === undefined && contractId === undefined) {
      errors.push(
        `contracts.${name}.address: missing (expected contract address C…)`
      );
    } else {
      for (const [field, value] of [
        ["address", address],
        ["contractId", contractId],
      ] as const) {
        if (value === undefined) continue;
        if (typeof value !== "string") {
          errors.push(`contracts.${name}.${field}: must be a string`);
        } else if (!CONTRACT_ID_RE.test(value)) {
          errors.push(
            `contracts.${name}.${field}: must match /^C[A-Z2-7]{55}$/, got '${value}'`
          );
        }
      }
      if (
        typeof address === "string" &&
        typeof contractId === "string" &&
        address !== contractId
      ) {
        errors.push(
          `contracts.${name}: 'address' and legacy 'contractId' disagree ('${address}' vs '${contractId}')`
        );
      }
    }

    // ── network (optional per entry, must match manifest) ──
    if (e.network !== undefined) {
      if (typeof e.network !== "string") {
        errors.push(`contracts.${name}.network: must be a string`);
      } else if (!allowedNetworks.includes(e.network)) {
        errors.push(
          `contracts.${name}.network: '${e.network}' must be one of: ${allowedNetworks.join(", ")}`
        );
      } else if (typeof m.network === "string" && e.network !== m.network) {
        errors.push(
          `contracts.${name}.network: '${e.network}' does not match manifest network '${m.network}'`
        );
      }
    }

    // wasmHash
    if (!e.wasmHash || typeof e.wasmHash !== "string") {
      errors.push(`contracts.${name}.wasmHash: missing or not a string`);
    } else if (!HEX64_RE.test(e.wasmHash)) {
      errors.push(
        `contracts.${name}.wasmHash: must be 64 lowercase hex characters, got '${e.wasmHash}'`
      );
    }

    // ── specVersion (canonical) / version (legacy alias) ──
    const specVersion = e.specVersion;
    const version = e.version;
    if (specVersion === undefined && version === undefined) {
      errors.push(
        `contracts.${name}.specVersion: missing (expected semver spec version)`
      );
    } else {
      for (const [field, value] of [
        ["specVersion", specVersion],
        ["version", version],
      ] as const) {
        if (value === undefined) continue;
        if (typeof value !== "string") {
          errors.push(`contracts.${name}.${field}: must be a string`);
        } else if (!SEMVER_RE.test(value)) {
          warnings.push(
            `contracts.${name}.${field}: '${value}' does not look like a semver version`
          );
        }
      }
      if (
        typeof specVersion === "string" &&
        typeof version === "string" &&
        specVersion !== version
      ) {
        errors.push(
          `contracts.${name}: 'specVersion' and legacy 'version' disagree ('${specVersion}' vs '${version}')`
        );
      }
    }

    // ── deploymentLedger (canonical) / ledger (legacy alias) ──
    const deploymentLedger = e.deploymentLedger;
    const ledger = e.ledger;
    if (deploymentLedger === undefined && ledger === undefined) {
      errors.push(
        `contracts.${name}.deploymentLedger: missing (expected integer >= 1)`
      );
    } else {
      for (const [field, value] of [
        ["deploymentLedger", deploymentLedger],
        ["ledger", ledger],
      ] as const) {
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          errors.push(
            `contracts.${name}.${field}: must be an integer >= 1, got '${value}'`
          );
        }
      }
      if (
        typeof deploymentLedger === "number" &&
        typeof ledger === "number" &&
        deploymentLedger !== ledger
      ) {
        errors.push(
          `contracts.${name}: 'deploymentLedger' and legacy 'ledger' disagree (${deploymentLedger} vs ${ledger})`
        );
      }
    }

    // ── lifecycleState (required) ──
    if (e.lifecycleState === undefined || e.lifecycleState === null) {
      errors.push(
        `contracts.${name}.lifecycleState: missing (must be one of: ${LIFECYCLE_STATES.join(", ")})`
      );
    } else if (typeof e.lifecycleState !== "string") {
      errors.push(`contracts.${name}.lifecycleState: must be a string`);
    } else if (!(LIFECYCLE_STATES as readonly string[]).includes(e.lifecycleState)) {
      errors.push(
        `contracts.${name}.lifecycleState: '${e.lifecycleState}' is not a valid lifecycle state. Must be one of: ${LIFECYCLE_STATES.join(", ")}`
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
