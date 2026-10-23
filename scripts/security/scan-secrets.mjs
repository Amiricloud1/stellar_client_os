#!/usr/bin/env node
/**
 * Dependency-free secret scanner (issue #97).
 *
 * Blocks representative secret patterns before merge: Stellar secret seeds,
 * GitHub tokens, AWS access keys, Slack tokens, and PEM private-key blocks.
 * Runs in CI (`.github/workflows/security.yml`) over `git ls-files` and is
 * covered by deterministic unit tests (`scan-secrets.test.mjs`) that build
 * their payloads programmatically so the test file itself never matches.
 *
 * Usage:
 *   node scripts/security/scan-secrets.mjs [path ...]   # default: git ls-files
 */

/**
 * Representative secret patterns. Each entry names a credential class we must
 * never merge. Keep the list focused on real credential shapes; generic
 * entropy rules cause false-positive debt without materially better coverage.
 */
export const SECRET_PATTERNS = [
  {
    id: "stellar-secret-seed",
    description: "Stellar secret seed (S...)",
    regex: /\bS[A-Z2-7]{55}\b/,
  },
  {
    id: "github-pat-legacy",
    description: "GitHub personal access token (ghp_/gho_/ghu_/ghs_/ghr_)",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    id: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token",
    regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key id (AKIA/ASIA)",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "slack-token",
    description: "Slack bot/user/app token",
    regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    id: "private-key-block",
    description: "PEM-encoded private key block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: "npm-token",
    description: "npm access token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/,
  },
];

/**
 * Default allowlist: known pre-existing matches that are deliberately kept,
 * each with a documented reason (see docs/security/secret-rotation.md):
 *
 * - `scripts/security/*.test.mjs` — the scanner's own representative fixtures
 *   (built programmatically at runtime).
 * - `.gitleaks.toml` — the gitleaks config contains the pattern definitions
 *   themselves.
 * - `apps/web/src/lib/s3/presigner.test.ts` — uses the canonical AWS
 *   documentation example key (AKIA...EXAMPLE), which is not a credential.
 * - `apps/web/src/services/video-anchor.service.test.ts` and
 *   `apps/web/src/app/api/campaign-verification/stream/route.ts` — pre-existing
 *   Stellar testnet seeds tracked for removal: the route's hardcoded fallback
 *   must move fully to `ANCHOR_SECRET_KEY` and the test should generate a
 *   keypair. Tracked as a planned control in docs/security/threat-model.md.
 */
export const DEFAULT_ALLOWLIST = [
  /^scripts\/security\/.*\.test\.mjs$/,
  /^\.gitleaks\.toml$/,
  /^apps\/web\/src\/lib\/s3\/presigner\.test\.ts$/,
  /^apps\/web\/src\/services\/video-anchor\.service\.test\.ts$/,
  /^apps\/web\/src\/app\/api\/campaign-verification\/stream\/route\.ts$/,
];

/** Scan one text blob. Returns findings: { patternId, description, line }. */
export function scanText(text, { allowlist = [], path = "memory" } = {}) {
  if (allowlist.some((entry) => entry.test(path))) return [];
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          patternId: pattern.id,
          description: pattern.description,
          line: index + 1,
        });
      }
    }
  });
  return findings;
}

/** Default file-extension filter: text-ish files only. */
function isScannableFile(file) {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|sh|env|txt|rs|py|html|css|sql)$/i.test(
    file,
  ) || /(^|\/)\.env(\..+)?$/.test(file);
}

/** List tracked files via git, falling back to an empty list outside a repo. */
async function listTrackedFiles(cwd) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run("git", ["ls-files"], { cwd });
  return stdout.split("\n").filter(Boolean);
}

/** Scan an explicit list of files. Returns per-file findings. */
export async function scanFiles(files, options = {}) {
  const { readFile } = await import("node:fs/promises");
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
  const cwd = options.cwd ?? process.cwd();
  const results = [];
  for (const file of files) {
    if (!isScannableFile(file)) continue;
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // deleted between ls-files and read; not a security concern
    }
    // Match the allowlist against the repo-relative path.
    const relative = file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
    const findings = scanText(text, { allowlist, path: relative });
    if (findings.length > 0) results.push({ file: relative, findings });
  }
  return results;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : await listTrackedFiles(cwd);
  const results = await scanFiles(
    files.map((file) => (file.startsWith("/") ? file : `${cwd}/${file}`)),
    { cwd },
  );
  if (results.length > 0) {
    console.error("✗ possible secrets detected — refusing to pass:");
    for (const { file, findings } of results) {
      for (const finding of findings) {
        console.error(
          `  ${file}:${finding.line} [${finding.patternId}] ${finding.description}`,
        );
      }
    }
    console.error(
      "If a match is a deliberate fixture, allowlist its path in scripts/security/scan-secrets.mjs and document why (docs/security/secret-rotation.md).",
    );
    process.exit(1);
  }
  console.log(`✓ no representative secret patterns in ${files.length} files`);
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
