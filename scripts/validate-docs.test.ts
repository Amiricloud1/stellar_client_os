// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateDocs } from "./validate-docs";

describe("validateDocs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-val-"));
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "test-repo",
        scripts: {
          build: "echo build",
          test: "echo test",
          "test:contracts": "echo test:contracts",
          lint: "echo lint",
        },
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes when valid scripts and existing paths are referenced", () => {
    const docPath = path.join(tempDir, "docs", "guide.md");
    const existingFile = path.join(tempDir, "docs", "sample.txt");
    fs.writeFileSync(existingFile, "content");
    fs.writeFileSync(
      docPath,
      `# Guide\n\nRun \`pnpm test:contracts\` to test contracts.\nSee [sample](./sample.txt) for details.`
    );

    const result = validateDocs({ repoRoot: tempDir });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("detects nonexistent repository scripts", () => {
    const docPath = path.join(tempDir, "docs", "bad-script.md");
    fs.writeFileSync(docPath, "To run things: `pnpm fake:script`");

    const result = validateDocs({ repoRoot: tempDir });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "invalid_script" && i.reference === "fake:script")).toBe(true);
  });

  it("detects nonexistent local paths", () => {
    const docPath = path.join(tempDir, "docs", "bad-path.md");
    fs.writeFileSync(docPath, "Read config at `./nonexistent/file.json`.");

    const result = validateDocs({ repoRoot: tempDir });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.type === "invalid_path")).toBe(true);
  });

  it("respects credential and external exceptions", () => {
    const docPath = path.join(tempDir, "docs", "credentials.md");
    fs.writeFileSync(
      docPath,
      "Copy secrets to `./credentials.json` and configure `./.env.local` for local execution."
    );

    const result = validateDocs({ repoRoot: tempDir });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("respects build artifact exclusions like dist and target", () => {
    const docPath = path.join(tempDir, "docs", "build-output.md");
    fs.writeFileSync(
      docPath,
      "Artifacts are generated in `./dist/index.js` and `./target/release`."
    );

    const result = validateDocs({ repoRoot: tempDir });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
