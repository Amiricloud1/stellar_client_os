// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pins TESTING_GUIDE.md (#121): every command the guide advertises must match
 * a real script in the workspace manifests, and stale Windows-isms
 * (`corepack`, `c:\\...`, `type ... | findstr`) must stay out.
 */
const REPO_ROOT = resolve(__dirname, "../../../../..");

function readRepo(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

function scriptsOf(manifestRelative: string): Record<string, string> {
  return JSON.parse(readRepo(manifestRelative)).scripts ?? {};
}

describe("testing guide command accuracy", () => {
  it("advertises only real workspace scripts", () => {
    const guide = readRepo("TESTING_GUIDE.md");
    const root = scriptsOf("package.json");
    const web = scriptsOf("apps/web/package.json");
    const mobile = scriptsOf("apps/mobile/package.json");
    const sdk = scriptsOf("packages/sdk/package.json");

    // Root-level commands in the guide.
    expect(guide).toContain("pnpm build:contracts");
    expect(root["build:contracts"]).toBeTruthy();
    expect(guide).toContain("pnpm test:contracts");
    expect(root["test:contracts"]).toBeTruthy();

    // Filtered commands resolve to real package scripts.
    const expected: Array<[string, Record<string, string>]> = [
      ["@fundable/sdk test", sdk],
      ["@fundable/sdk test:coverage", sdk],
      ["@fundable/sdk test:integration", sdk],
      ["@fundable/sdk build", sdk],
      ["@fundable/sdk lint", sdk],
      ["@fundable/sdk format:check", sdk],
      ["@fundable/web test", web],
      ["@fundable/web lint", web],
      ["@fundable/web test:e2e", web],
      ["@fundable/mobile test", mobile],
      ["@fundable/mobile typecheck", mobile],
    ];
    for (const [command, scripts] of expected) {
      const script = command.split(" ").slice(1).join(" ").split(" -- ")[0];
      expect(scripts[script], `missing script for pnpm --filter ${command}`).toBeTruthy();
      expect(guide).toContain(`pnpm --filter ${command.split(" -- ")[0]}`);
    }
  });

  it("contains no stale Windows-isms or removed flags", () => {
    const guide = readRepo("TESTING_GUIDE.md");
    for (const stale of ["corepack", "c:\\\\", "findstr", "C:\\\\Users", "test:watch -w"]) {
      expect(guide).not.toContain(stale);
    }
    // pnpm filter syntax (not pnpm -w / pnpm test -w).
    expect(guide).not.toMatch(/pnpm test -w/);
  });

  it("documents prerequisites and CI mapping", () => {
    const guide = readRepo("TESTING_GUIDE.md");
    expect(guide).toMatch(/pnpm exclusively/i);
    expect(guide).toMatch(/Playwright/);
    expect(guide).toMatch(/contracts\.yml/);
    expect(guide).toMatch(/docs\.yml/);
  });
});
