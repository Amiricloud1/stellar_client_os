// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectBindingsDrift } from "../../scripts/check-bindings-drift.js";

describe("detectBindingsDrift", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects when a generated directory is missing and names the exact remediation command", () => {
    const srcDir = path.join(tempDir, "contracts", "payment-stream", "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "lib.rs"), "// rust");

    const nonExistentGenDir = path.join(tempDir, "sdk", "generated", "payment-stream");

    const res = detectBindingsDrift([
      {
        contract: "payment-stream",
        srcDir,
        generatedDir: nonExistentGenDir,
      },
    ]);

    expect(res.hasDrift).toBe(true);
    expect(res.drifts).toHaveLength(1);
    expect(res.drifts[0].contract).toBe("payment-stream");
    expect(res.drifts[0].remediation).toBe("pnpm --filter @fundable/sdk generate:wasm --contract payment-stream");
  });

  it("detects when contract source was modified after bindings generation", () => {
    const srcDir = path.join(tempDir, "contracts", "distributor", "src");
    const genDir = path.join(tempDir, "sdk", "generated", "distributor");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(genDir, { recursive: true });

    // Generated file with older timestamp
    const genFile = path.join(genDir, "index.ts");
    fs.writeFileSync(genFile, "// generated");
    const pastTime = new Date(Date.now() - 10000);
    fs.utimesSync(genFile, pastTime, pastTime);

    // Source file with current timestamp
    fs.writeFileSync(path.join(srcDir, "lib.rs"), "// updated rust");

    const res = detectBindingsDrift([
      {
        contract: "distributor",
        srcDir,
        generatedDir: genDir,
      },
    ]);

    expect(res.hasDrift).toBe(true);
    expect(res.drifts[0].contract).toBe("distributor");
    expect(res.drifts[0].reason).toBe("contract_newer_than_generated_bindings");
    expect(res.drifts[0].remediation).toBe("pnpm --filter @fundable/sdk generate:wasm --contract distributor");
  });

  it("reports no drift when generated bindings are newer than contract source", () => {
    const srcDir = path.join(tempDir, "contracts", "planter", "src");
    const genDir = path.join(tempDir, "sdk", "generated", "planter");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(genDir, { recursive: true });

    const srcFile = path.join(srcDir, "lib.rs");
    fs.writeFileSync(srcFile, "// rust");
    const pastTime = new Date(Date.now() - 10000);
    fs.utimesSync(srcFile, pastTime, pastTime);

    const genFile = path.join(genDir, "index.ts");
    fs.writeFileSync(genFile, "// fresh generated");

    const res = detectBindingsDrift([
      {
        contract: "planter",
        srcDir,
        generatedDir: genDir,
      },
    ]);

    expect(res.hasDrift).toBe(false);
    expect(res.drifts).toHaveLength(0);
  });
});
