#!/usr/bin/env node
/**
 * CI validator for docs/security/threat-model.md (issue #96).
 *
 * Enforces the structural contract of the maintained threat model so that
 * "track high-risk controls" stays true over time:
 *
 *   - every required section heading exists;
 *   - the Assets, Trust boundaries, Attacker capabilities, Mitigations and
 *     High-risk controls tables each have their required columns;
 *   - every High-risk controls row carries a status of implemented | planned |
 *     accepted.
 *
 * Deterministic and dependency-free (node:test compatible):
 *
 *   node scripts/security/validate-threat-model.mjs [path-to-doc]
 *   node --test scripts/security/
 */

export const REQUIRED_SECTIONS = [
  "Assets",
  "Trust boundaries",
  "Attacker capabilities",
  "Mitigations",
  "Residual risks",
  "High-risk controls",
];

const REQUIRED_TABLES = {
  Assets: ["Asset", "Where it lives", "Impact if compromised"],
  "Trust boundaries": ["Boundary", "Crossing", "Enforcement"],
  "Attacker capabilities": ["Attacker", "Capability assumed"],
  Mitigations: ["Threat", "Mitigation", "Status"],
  "High-risk controls": ["Control", "Covers", "Status"],
};

export const ALLOWED_CONTROL_STATUSES = ["implemented", "planned", "accepted"];

function parseTable(markdown, sectionHeading) {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${escapeRe(sectionHeading)}\\s*$`);
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return null;

  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // next section
    if (!line.trim().startsWith("|")) {
      if (rows.length > 0 && line.trim() === "") continue;
      if (rows.length > 0 && !line.trim().startsWith("|")) break;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    // Skip the markdown separator row (--- --- ---).
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkColumns(section, rows, requiredColumns) {
  const problems = [];
  if (rows === null) return [`missing "## ${section}" section`];
  const header = rows[0] ?? [];
  for (const column of requiredColumns) {
    if (!header.includes(column)) {
      problems.push(
        `"${section}" table is missing the "${column}" column (found: ${header.join(", ") || "no header"})`,
      );
    }
  }
  return problems;
}

/** Validate threat-model markdown. Returns a list of human-readable problems. */
export function validateThreatModel(markdown) {
  const problems = [];
  if (typeof markdown !== "string" || markdown.trim() === "") {
    return ["threat model document is empty"];
  }

  for (const section of REQUIRED_SECTIONS) {
    const headingRe = new RegExp(`^##\\s+${escapeRe(section)}\\s*$`, "m");
    if (!headingRe.test(markdown)) {
      problems.push(`missing required section: "## ${section}"`);
    }
  }

  for (const [section, columns] of Object.entries(REQUIRED_TABLES)) {
    problems.push(
      ...checkColumns(section, parseTable(markdown, section), columns),
    );
  }

  // High-risk controls: every data row must carry an allowed status.
  const controls = parseTable(markdown, "High-risk controls");
  if (controls && controls.length > 0) {
    const header = controls[0];
    const statusIndex = header.indexOf("Status");
    controls.slice(1).forEach((row, index) => {
      const status = row[statusIndex] ?? "";
      if (!ALLOWED_CONTROL_STATUSES.includes(status)) {
        problems.push(
          `high-risk control row ${index + 1} ("${row[0] ?? "untitled"}") has invalid status "${status}" — expected one of: ${ALLOWED_CONTROL_STATUSES.join(", ")}`,
        );
      }
    });
  }

  return problems;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const { readFile } = await import("node:fs/promises");
  const path =
    process.argv[2] ?? new URL("../../docs/security/threat-model.md", import.meta.url).pathname;
  const markdown = await readFile(path, "utf8");
  const problems = validateThreatModel(markdown);
  if (problems.length > 0) {
    console.error(`✗ ${path} failed threat-model validation:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`✓ ${path} satisfies the threat-model contract`);
}

const { pathToFileURL } = await import("node:url");
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
