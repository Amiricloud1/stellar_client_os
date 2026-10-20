// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { verifyReleaseReady } from "./release-dry-run";

describe("verifyReleaseReady", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-val-"));
    fs.mkdirSync(path.join(tempDir, "packages", "sdk"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, ".changeset"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, ".changeset", "config.json"),
      JSON.stringify({ access: "public" })
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes when package.json has valid name, semver version, and license", () => {
    fs.writeFileSync(
      path.join(tempDir, "packages", "sdk", "package.json"),
      JSON.stringify({
        name: "@fundable/sdk",
        version: "1.2.3",
        license: "MIT",
      })
    );
    fs.writeFileSync(
      path.join(tempDir, ".changeset", "cool-update.md"),
      '---\n"@fundable/sdk": minor\n---\nNew feature\n'
    );

    const result = verifyReleaseReady(tempDir);
    expect(result.ok).toBe(true);
    expect(result.packageName).toBe("@fundable/sdk");
    expect(result.version).toBe("1.2.3");
    expect(result.changesetCount).toBe(1);
  });

  it("fails when package name is mismatched or missing", () => {
    fs.writeFileSync(
      path.join(tempDir, "packages", "sdk", "package.json"),
      JSON.stringify({
        name: "wrong-name",
        version: "1.0.0",
        license: "MIT",
      })
    );

    const result = verifyReleaseReady(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("wrong-name"))).toBe(true);
  });

  it("fails when version is not valid semver", () => {
    fs.writeFileSync(
      path.join(tempDir, "packages", "sdk", "package.json"),
      JSON.stringify({
        name: "@fundable/sdk",
        version: "invalid-semver",
        license: "MIT",
      })
    );

    const result = verifyReleaseReady(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("semver"))).toBe(true);
  });

  it("fails when .changeset/config.json is missing", () => {
    fs.rmSync(path.join(tempDir, ".changeset", "config.json"));
    fs.writeFileSync(
      path.join(tempDir, "packages", "sdk", "package.json"),
      JSON.stringify({
        name: "@fundable/sdk",
        version: "1.0.0",
        license: "MIT",
      })
    );

    const result = verifyReleaseReady(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes(".changeset/config.json"))).toBe(true);
  });
});
