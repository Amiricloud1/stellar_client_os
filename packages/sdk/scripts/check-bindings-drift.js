#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../");
const sdkRoot = path.resolve(__dirname, "..");
const contractsRoot = path.resolve(repoRoot, "contracts");

export const CONTRACT_BINDING_MAP = [
  {
    contract: "payment-stream",
    srcDir: path.resolve(contractsRoot, "payment-stream", "src"),
    generatedDir: path.resolve(sdkRoot, "src/generated/payment-stream"),
  },
  {
    contract: "distributor",
    srcDir: path.resolve(contractsRoot, "distributor", "src"),
    generatedDir: path.resolve(sdkRoot, "src/generated/distributor"),
  },
  {
    contract: "planter",
    srcDir: path.resolve(contractsRoot, "planter", "src"),
    generatedDir: path.resolve(sdkRoot, "src/generated/planter"),
  },
  {
    contract: "campaign-funding",
    srcDir: path.resolve(contractsRoot, "campaign-funding", "src"),
    generatedDir: path.resolve(sdkRoot, "src/generated/campaign-funding"),
  },
];

export function getLatestMtime(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let latest = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = getLatestMtime(fullPath);
      if (sub > latest) latest = sub;
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    }
  }
  return latest;
}

export function detectBindingsDrift(contracts = CONTRACT_BINDING_MAP) {
  const drifts = [];

  for (const c of contracts) {
    if (!fs.existsSync(c.generatedDir)) {
      drifts.push({
        contract: c.contract,
        reason: "missing_generated_directory",
        remediation: `pnpm --filter @fundable/sdk generate:wasm --contract ${c.contract}`,
      });
      continue;
    }

    const srcMtime = getLatestMtime(c.srcDir);
    const genMtime = getLatestMtime(c.generatedDir);

    if (srcMtime > genMtime && genMtime > 0) {
      drifts.push({
        contract: c.contract,
        reason: "contract_newer_than_generated_bindings",
        remediation: `pnpm --filter @fundable/sdk generate:wasm --contract ${c.contract}`,
      });
    }
  }

  return {
    hasDrift: drifts.length > 0,
    drifts,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Checking for contract bindings drift...");
  const res = detectBindingsDrift();
  if (res.hasDrift) {
    console.error(`Detected drift in ${res.drifts.length} contract bindings:`);
    for (const d of res.drifts) {
      console.error(`- Contract '${d.contract}' (${d.reason})`);
      console.error(`  Remediation command: ${d.remediation}`);
    }
    process.exit(1);
  } else {
    console.log("No drift detected. Generated bindings are up to date.");
  }
}
