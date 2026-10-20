// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateWorkspace } from "./validate-workspace";

describe("validateWorkspace", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-val-"));
    fs.mkdirSync(path.join(tempDir, "packages", "sdk"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "apps", "web"), { recursive: true });

    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "root", private: true })
    );
    fs.writeFileSync(
      path.join(tempDir, "packages", "sdk", "package.json"),
      JSON.stringify({ name: "@fundable/sdk", version: "1.0.0" })
    );
    fs.writeFileSync(
      path.join(tempDir, "apps", "web", "package.json"),
      JSON.stringify({
        name: "@fundable/web",
        version: "1.0.0",
        dependencies: {
          "@fundable/sdk": "workspace:*",
        },
      })
    );
    fs.writeFileSync(path.join(tempDir, "pnpm-lock.yaml"), "lockfile: true\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes for clean workspace with valid workspace references and pnpm-lock.yaml", () => {
    const res = validateWorkspace(tempDir);
    expect(res.ok).toBe(true);
    expect(res.issues).toHaveLength(0);
    expect(res.competingLockfiles).toHaveLength(0);
    expect(res.brokenWorkspaceDeps).toHaveLength(0);
  });

  it("detects competing lockfiles and gives exact remediation", () => {
    fs.writeFileSync(path.join(tempDir, "package-lock.json"), "{}");
    const res = validateWorkspace(tempDir);
    expect(res.ok).toBe(false);
    expect(res.competingLockfiles).toContain("package-lock.json");
    expect(res.issues.some((i) => i.includes("rm package-lock.json"))).toBe(true);
  });

  it("detects broken workspace dependencies", () => {
    fs.writeFileSync(
      path.join(tempDir, "apps", "web", "package.json"),
      JSON.stringify({
        name: "@fundable/web",
        dependencies: {
          "@fundable/nonexistent": "workspace:*",
        },
      })
    );
    const res = validateWorkspace(tempDir);
    expect(res.ok).toBe(false);
    expect(res.brokenWorkspaceDeps).toContain("@fundable/nonexistent");
  });

  it("detects missing pnpm-lock.yaml", () => {
    fs.rmSync(path.join(tempDir, "pnpm-lock.yaml"));
    const res = validateWorkspace(tempDir);
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.includes("Missing 'pnpm-lock.yaml'"))).toBe(true);
  });
});
