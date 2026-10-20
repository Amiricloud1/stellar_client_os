// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Pins .github/PULL_REQUEST_TEMPLATE.md + CONTRIBUTING.md (#120). */
const REPO_ROOT = resolve(__dirname, "../../../../..");

function readRepo(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("contribution guidance and PR template", () => {
  it("PR template requests packages, risk, evidence, migrations, docs", () => {
    const template = readRepo(".github/PULL_REQUEST_TEMPLATE.md");

    for (const section of [
      "Affected packages",
      "Risk",
      "Validation evidence",
      "Migrations",
      "Documentation impact",
      "Issues",
    ]) {
      expect(template).toContain(section);
    }
    expect(template).toContain("closes #");
    // Template asks without duplicating full repo policy.
    expect(template.length).toBeLessThan(3000);
  });

  it("CONTRIBUTING.md links policy instead of duplicating it", () => {
    const contributing = readRepo("CONTRIBUTING.md");

    expect(contributing).toContain("STYLE_GUIDE.md");
    expect(contributing).toContain("TESTING_GUIDE.md");
    expect(contributing).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(contributing).toContain("docs/environment-variables.md");
  });
});
