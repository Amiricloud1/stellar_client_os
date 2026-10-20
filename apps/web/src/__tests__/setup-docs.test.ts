import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Validates consistency of setup instructions across docs.
 */
export function validateSetupDocConsistency(docs: {
  quickstart: string;
  gettingStarted: string;
  readme: string;
}): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 1. Tool version consistency
  const requiredToolVersions = [
    { name: "Node.js", pattern: /18/ },
    { name: "pnpm", pattern: /8/ },
    { name: "stellar-cli", pattern: /25\.0\.0/ },
  ];

  for (const tool of requiredToolVersions) {
    if (!tool.pattern.test(docs.quickstart)) {
      errors.push(`QUICKSTART.md missing version pattern for ${tool.name}`);
    }
    if (!tool.pattern.test(docs.gettingStarted)) {
      errors.push(`docs/getting-started.md missing version pattern for ${tool.name}`);
    }
    if (!tool.pattern.test(docs.readme)) {
      errors.push(`README.md missing version pattern for ${tool.name}`);
    }
  }

  // 2. Expected output sections
  if (!docs.quickstart.includes("Expected Output")) {
    errors.push("QUICKSTART.md is missing 'Expected Output' blocks");
  }
  if (!docs.gettingStarted.includes("Expected Output")) {
    errors.push("docs/getting-started.md is missing 'Expected Output' blocks");
  }

  // 3. Troubleshooting section
  if (!docs.quickstart.includes("Troubleshooting")) {
    errors.push("QUICKSTART.md is missing 'Troubleshooting' section");
  }
  if (!docs.gettingStarted.includes("Troubleshooting")) {
    errors.push("docs/getting-started.md is missing 'Troubleshooting' section");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

describe("Setup Documentation Unification (Issue #112)", () => {
  const repoRoot = path.resolve(__dirname, "../../../../");
  const quickstartPath = path.join(repoRoot, "QUICKSTART.md");
  const gettingStartedPath = path.join(repoRoot, "docs/getting-started.md");
  const readmePath = path.join(repoRoot, "README.md");

  it("verifies QUICKSTART.md, docs/getting-started.md, and README.md satisfy consistency checks", () => {
    const quickstart = fs.readFileSync(quickstartPath, "utf-8");
    const gettingStarted = fs.readFileSync(gettingStartedPath, "utf-8");
    const readme = fs.readFileSync(readmePath, "utf-8");

    const result = validateSetupDocConsistency({
      quickstart,
      gettingStarted,
      readme,
    });

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("verifies cross-links in README.md and QUICKSTART.md resolve to existing files", () => {
    const readme = fs.readFileSync(readmePath, "utf-8");
    const quickstart = fs.readFileSync(quickstartPath, "utf-8");

    expect(readme).toContain("[QUICKSTART.md](QUICKSTART.md)");
    expect(readme).toContain("[docs/getting-started.md](docs/getting-started.md)");

    expect(quickstart).toContain("[docs/getting-started.md](docs/getting-started.md)");
    expect(quickstart).toContain("[docs/architecture.md](docs/architecture.md)");
    expect(quickstart).toContain("[scripts/README.md](scripts/README.md)");

    // Ensure all referenced files actually exist on disk
    expect(fs.existsSync(path.join(repoRoot, "QUICKSTART.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "docs/getting-started.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "docs/architecture.md"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, "scripts/README.md"))).toBe(true);
  });

  describe("Setup Doc Validator Boundary Cases", () => {
    it("detects when a required tool version pattern is absent", () => {
      const mockResult = validateSetupDocConsistency({
        quickstart: "Node.js 18, pnpm 8", // missing stellar-cli 25.0.0
        gettingStarted: "Node.js 18, pnpm 8, stellar-cli 25.0.0 Expected Output Troubleshooting",
        readme: "Node.js 18, pnpm 8, stellar-cli 25.0.0",
      });

      expect(mockResult.valid).toBe(false);
      expect(mockResult.errors.some((e) => e.includes("stellar-cli"))).toBe(true);
    });

    it("detects when expected outputs or troubleshooting sections are omitted", () => {
      const mockResult = validateSetupDocConsistency({
        quickstart: "Node.js 18, pnpm 8, stellar-cli 25.0.0 Expected Output",
        gettingStarted: "Node.js 18, pnpm 8, stellar-cli 25.0.0", // missing Expected Output & Troubleshooting
        readme: "Node.js 18, pnpm 8, stellar-cli 25.0.0",
      });

      expect(mockResult.valid).toBe(false);
      expect(mockResult.errors.some((e) => e.includes("Troubleshooting"))).toBe(true);
    });
  });
});
