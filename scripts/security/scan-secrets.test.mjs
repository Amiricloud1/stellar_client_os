import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  DEFAULT_ALLOWLIST,
  SECRET_PATTERNS,
  scanFiles,
  scanText,
} from "./scan-secrets.mjs";

/**
 * Representative secrets are assembled at runtime from fragments so that this
 * test file itself never contains a matching literal (the scanner allowlists
 * it anyway, but keeping both properties makes refactors safe).
 */
const STELLAR_SEED = `S${"ABCDEFGH".repeat(6)}ABCDEFG`; // S + exactly 55 chars
const GITHUB_PAT = `ghp_${"aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW2xY4zA".slice(0, 40)}`;
const GITHUB_FINE = `github_pat_${"aaaaabbbbb_ccccccdddd_eeeeefffff"}`;
const AWS_KEY = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const SLACK_TOKEN = `xoxb-${"1234567890-1234567890-abcd"}`;
const NPM_TOKEN = `npm_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7s8"}`;
const PEM_BLOCK = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");

const FORBIDDEN_PATTERNS = {
  "stellar-secret-seed": STELLAR_SEED,
  "github-pat-legacy": GITHUB_PAT,
  "github-fine-grained-pat": GITHUB_FINE,
  "aws-access-key-id": AWS_KEY,
  "slack-token": SLACK_TOKEN,
  "npm-token": NPM_TOKEN,
  "private-key-block": PEM_BLOCK,
};

const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "secret-scan-"));
  tempDirs.push(dir);
  return dir;
}

describe("SECRET_PATTERNS", () => {
  it("covers every representative credential class", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id).sort();
    assert.deepEqual(ids, Object.keys(FORBIDDEN_PATTERNS).sort());
  });
});

describe("scanText — success cases", () => {
  for (const [patternId, secret] of Object.entries(FORBIDDEN_PATTERNS)) {
    it(`detects ${patternId}`, () => {
      const findings = scanText(`const value = "${secret}";`, {
        path: "src/app.ts",
      });
      assert.equal(findings.length, 1);
      assert.equal(findings[0].patternId, patternId);
      assert.equal(findings[0].line, 1);
    });
  }

  it("reports every occurrence with correct line numbers", () => {
    const text = [
      "line one is clean",
      `key = "${AWS_KEY}"`,
      "line three",
      `seed = "${STELLAR_SEED}"`,
    ].join("\n");
    const findings = scanText(text, { path: "config.json" });
    assert.deepEqual(
      findings.map((f) => [f.patternId, f.line]),
      [
        ["aws-access-key-id", 2],
        ["stellar-secret-seed", 4],
      ],
    );
  });
});

describe("scanText — failure (negative) cases", () => {
  it("accepts clean source", () => {
    assert.deepEqual(scanText('const url = "https://example.com";'), []);
  });

  it("ignores near-miss Stellar seeds", () => {
    assert.deepEqual(scanText(`const s = "${STELLAR_SEED.slice(0, 55)}";`), []); // one char short
    assert.deepEqual(scanText(`const s = "T${STELLAR_SEED.slice(1)}";`), []); // wrong prefix
    assert.deepEqual(scanText(`const s = "${STELLAR_SEED.toLowerCase()}";`), []); // wrong case
  });

  it("ignores near-miss GitHub tokens", () => {
    assert.deepEqual(scanText(`const t = "ghp_${"a".repeat(35)}";`), []); // too short
    assert.deepEqual(scanText("const t = 'ghp_';"), []); // bare prefix
  });

  it("ignores documentation placeholders", () => {
    assert.deepEqual(scanText("export const SECRET_KEY = process.env.KEY;"), []);
    assert.deepEqual(scanText("token = <YOUR_TOKEN_HERE>"), []);
  });
});

describe("scanText — boundary cases", () => {
  it("handles empty and whitespace-only input", () => {
    assert.deepEqual(scanText(""), []);
    assert.deepEqual(scanText("\n\n   \n"), []);
  });

  it("honours the path allowlist", () => {
    const findings = scanText(`seed = "${STELLAR_SEED}"`, {
      path: "scripts/security/scan-secrets.test.mjs",
      allowlist: DEFAULT_ALLOWLIST,
    });
    assert.deepEqual(findings, []);
  });

  it("flags a secret in a non-allowlisted path even inside the same directory", () => {
    const findings = scanText(`seed = "${STELLAR_SEED}"`, {
      path: "scripts/security/notes.md",
      allowlist: DEFAULT_ALLOWLIST,
    });
    assert.equal(findings.length, 1);
  });
});

describe("scanFiles", () => {
  it("scans files on disk and skips allowlisted or unreadable paths", async () => {
    const dir = await tempDir();
    const secretFile = join(dir, "settings.json");
    const cleanFile = join(dir, "clean.ts");
    // Mirror the repo layout so the default allowlist applies.
    const { mkdir } = await import("node:fs/promises");
    const allowDir = join(dir, "scripts", "security");
    await mkdir(allowDir, { recursive: true });
    const allowlisted = join(allowDir, "scan-secrets.test.mjs");
    const missing = join(dir, "gone.json");

    await writeFile(secretFile, `{"key": "${GITHUB_PAT}"}`);
    await writeFile(cleanFile, "export const ok = 1;");
    await writeFile(allowlisted, `const s = "${STELLAR_SEED}";`);

    const results = await scanFiles(
      [secretFile, cleanFile, allowlisted, missing, join(dir, "image.png")],
      { cwd: dir },
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].file, "settings.json");
    assert.equal(results[0].findings[0].patternId, "github-pat-legacy");
  });
});
