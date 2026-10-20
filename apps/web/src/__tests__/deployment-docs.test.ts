import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { getWorkspaceContracts } from "./architecture-docs.test";

/**
 * Validates that deployment scripts and docs cover all workspace contracts.
 */
export function validateDeploymentCompleteness(
  deployScript: string,
  initScript: string,
  deployReadme: string,
  contracts: string[]
): {
  valid: boolean;
  missingInDeploy: string[];
  missingInInit: string[];
  missingInReadme: string[];
} {
  const missingInDeploy = contracts.filter((c) => {
    const under = c.replace(/-/g, "_");
    return !deployScript.includes(c) && !deployScript.includes(under);
  });

  const missingInInit = contracts.filter((c) => {
    const under = c.replace(/-/g, "_");
    return !initScript.includes(c) && !initScript.includes(under);
  });

  const missingInReadme = contracts.filter((c) => !deployReadme.includes(c));

  return {
    valid:
      missingInDeploy.length === 0 &&
      missingInInit.length === 0 &&
      missingInReadme.length === 0,
    missingInDeploy,
    missingInInit,
    missingInReadme,
  };
}

describe("Deployment Documentation & Script Alignment (Issue #113)", () => {
  const repoRoot = path.resolve(__dirname, "../../../../");
  const cargoTomlPath = path.join(repoRoot, "contracts/Cargo.toml");
  const deployScriptPath = path.join(repoRoot, "scripts/deploy.sh");
  const initScriptPath = path.join(repoRoot, "scripts/initialize.sh");
  const deployReadmePath = path.join(repoRoot, "scripts/README.md");

  const contracts = getWorkspaceContracts(fs.readFileSync(cargoTomlPath, "utf-8"));
  const deployScript = fs.readFileSync(deployScriptPath, "utf-8");
  const initScript = fs.readFileSync(initScriptPath, "utf-8");
  const deployReadme = fs.readFileSync(deployReadmePath, "utf-8");

  it("verifies that scripts/deploy.sh and scripts/initialize.sh support all 15 contracts", () => {
    const validation = validateDeploymentCompleteness(
      deployScript,
      initScript,
      deployReadme,
      contracts
    );

    expect(validation.missingInDeploy).toEqual([]);
    expect(validation.missingInInit).toEqual([]);
    expect(validation.missingInReadme).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("verifies dry-run mode flags are supported in deployment and initialization scripts", () => {
    expect(deployScript).toContain("--dry-run");
    expect(deployScript).toContain("DRY_RUN");

    expect(initScript).toContain("--dry-run");
    expect(initScript).toContain("DRY_RUN");
  });

  it("verifies scripts/README.md documents prerequisites, dry-run, initialization, verification, and recovery", () => {
    expect(deployReadme).toContain("Prerequisites");
    expect(deployReadme).toContain("Dry-Run Simulation");
    expect(deployReadme).toContain("Contract Initialization");
    expect(deployReadme).toContain("Verification");
    expect(deployReadme).toContain("Recovery & Troubleshooting Runbook");
  });

  it("verifies scripts/README.md documents all 15 compiled .wasm artifact names", () => {
    const expectedWasmNames = [
      "payment_stream.wasm",
      "distributor.wasm",
      "nft_stream.wasm",
      "campaign_funding.wasm",
      "soulbound_badge.wasm",
      "stellar_client_os_verifier_penalty.wasm",
      "planter.wasm",
      "campaign_verification_audit.wasm",
      "stellar_client_os_dispute_arbiter.wasm",
      "timelock.wasm",
      "upgrade_proxy.wasm",
      "sponsor_crowdfunding.wasm",
      "sponsor_insurance.wasm",
      "campaign_diversity.wasm",
      "tax_deduction_certificate.wasm",
    ];

    for (const wasmName of expectedWasmNames) {
      expect(deployReadme).toContain(wasmName);
    }
  });

  describe("Deployment Completeness Validator Edge Cases", () => {
    it("flags missing contracts when script omits members", () => {
      const mockDeploy = "CONTRACTS=(payment_stream distributor)";
      const mockInit = "CONTRACTS=(payment_stream distributor)";
      const mockReadme = "payment-stream distributor";
      const fullContracts = ["payment-stream", "distributor", "nft-stream"];

      const result = validateDeploymentCompleteness(
        mockDeploy,
        mockInit,
        mockReadme,
        fullContracts
      );

      expect(result.valid).toBe(false);
      expect(result.missingInDeploy).toEqual(["nft-stream"]);
      expect(result.missingInInit).toEqual(["nft-stream"]);
      expect(result.missingInReadme).toEqual(["nft-stream"]);
    });
  });
});
