import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Maintenance check helper to parse workspace members from contracts/Cargo.toml.
 */
export function getWorkspaceContracts(cargoTomlContent: string): string[] {
  const membersMatch = cargoTomlContent.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!membersMatch) return [];

  const rawMembers = membersMatch[1];
  return rawMembers
    .split("\n")
    .map((line) => line.trim().replace(/[",]/g, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Validates whether an architecture doc satisfies completeness criteria.
 */
export function validateArchitectureDoc(
  docContent: string,
  contracts: string[]
): { valid: boolean; missingContracts: string[]; missingSections: string[] } {
  const missingContracts = contracts.filter((contract) => !docContent.includes(contract));

  const requiredSections = [
    "High-Level System Architecture",
    "Smart Contract Inventory",
    "API Boundaries",
    "Trust Boundaries",
    "Current System Data Flows",
  ];

  const missingSections = requiredSections.filter((sec) => !docContent.includes(sec));

  return {
    valid: missingContracts.length === 0 && missingSections.length === 0,
    missingContracts,
    missingSections,
  };
}

describe("Architecture Documentation Maintenance Check (Issue #111)", () => {
  const repoRoot = path.resolve(__dirname, "../../../../");
  const cargoTomlPath = path.join(repoRoot, "contracts/Cargo.toml");
  const archDocPath = path.join(repoRoot, "docs/architecture.md");

  it("successfully parses all 15 contract workspace members from Cargo.toml", () => {
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf-8");
    const contracts = getWorkspaceContracts(cargoToml);

    expect(contracts.length).toBe(15);
    expect(contracts).toContain("payment-stream");
    expect(contracts).toContain("distributor");
    expect(contracts).toContain("campaign-funding");
    expect(contracts).toContain("campaign-verification-audit");
    expect(contracts).toContain("tax-deduction-certificate");
  });

  it("validates that docs/architecture.md documents all 15 contracts", () => {
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf-8");
    const archDoc = fs.readFileSync(archDocPath, "utf-8");
    const contracts = getWorkspaceContracts(cargoToml);

    const validation = validateArchitectureDoc(archDoc, contracts);

    expect(validation.missingContracts).toEqual([]);
    expect(validation.missingSections).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("documents every contract's expected .wasm artifact name", () => {
    const archDoc = fs.readFileSync(archDocPath, "utf-8");

    const expectedArtifacts = [
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

    for (const artifact of expectedArtifacts) {
      expect(archDoc).toContain(artifact);
    }
  });

  // Boundary & Failure test cases for the validator
  describe("Maintenance Checker Failure Handling", () => {
    it("fails validation when a contract is missing from the architecture guide", () => {
      const mockDoc = "# Partial Doc\n## High-Level System Architecture\n## Smart Contract Inventory\n## API Boundaries\n## Trust Boundaries\n## Current System Data Flows\n- payment-stream";
      const contracts = ["payment-stream", "distributor", "timelock"];

      const result = validateArchitectureDoc(mockDoc, contracts);
      expect(result.valid).toBe(false);
      expect(result.missingContracts).toEqual(["distributor", "timelock"]);
    });

    it("fails validation when a required architectural section is omitted", () => {
      const mockDoc = "- payment-stream\n- distributor";
      const contracts = ["payment-stream", "distributor"];

      const result = validateArchitectureDoc(mockDoc, contracts);
      expect(result.valid).toBe(false);
      expect(result.missingSections.length).toBeGreaterThan(0);
    });
  });
});
