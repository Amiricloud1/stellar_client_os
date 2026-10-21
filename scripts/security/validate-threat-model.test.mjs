import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  ALLOWED_CONTROL_STATUSES,
  validateThreatModel,
} from "./validate-threat-model.mjs";

/** A minimal threat model that satisfies the full contract. */
const VALID_MODEL = `# Threat Model

## Assets

| Asset | Where it lives | Impact if compromised |
| ----- | -------------- | --------------------- |
| Escrow funds | Contract storage | Fund theft |

## Trust boundaries

| # | Boundary | Crossing | Enforcement |
| - | -------- | -------- | ----------- |
| B1 | Browser ↔ API | Input | Validation |

## Attacker capabilities

| ID | Attacker | Capability assumed |
| -- | -------- | ------------------ |
| A1 | Network attacker | Modify traffic |

## Mitigations

| Threat | Attacker | Boundary | Mitigation | Status |
| ------ | -------- | -------- | ---------- | ------ |
| Theft | A1 | B1 | Validation | implemented |

## Residual risks

- Phishing.

## High-risk controls

| Control | Covers | Owner surface | Status |
| ------- | ------ | ------------- | ------ |
| Scanning | A1/B1 | CI | implemented |
| Threshold keys | A1/B1 | contracts | planned |
| Explicit acceptance | A1/B1 | ops | accepted |
`;

describe("validateThreatModel", () => {
  it("accepts a well-formed threat model", () => {
    assert.deepEqual(validateThreatModel(VALID_MODEL), []);
  });

  it("accepts the repository's real threat model document", async () => {
    const markdown = await readFile(
      new URL("../../docs/security/threat-model.md", import.meta.url),
      "utf8",
    );
    assert.deepEqual(validateThreatModel(markdown), []);
  });

  it("rejects empty or non-string input", () => {
    assert.deepEqual(validateThreatModel(""), [
      "threat model document is empty",
    ]);
    assert.deepEqual(validateThreatModel(null), [
      "threat model document is empty",
    ]);
  });

  it("flags every missing required section", () => {
    const problems = validateThreatModel("# Threat Model\n\nnothing else\n");
    for (const section of [
      "Assets",
      "Trust boundaries",
      "Attacker capabilities",
      "Mitigations",
      "Residual risks",
      "High-risk controls",
    ]) {
      assert.ok(
        problems.some((p) => p.includes(`## ${section}`)),
        `expected a problem mentioning ${section}`,
      );
    }
  });

  it("flags a missing table column", () => {
    const broken = VALID_MODEL.replace(
      "| Asset | Where it lives | Impact if compromised |",
      "| Asset | Where it lives |",
    );
    const problems = validateThreatModel(broken);
    assert.ok(
      problems.some((p) =>
        p.includes('"Assets" table is missing the "Impact if compromised" column'),
      ),
      problems.join("\n"),
    );
  });

  it("flags high-risk control rows with an invalid status", () => {
    const broken = VALID_MODEL.replace("| planned |", "| in-progress |");
    const problems = validateThreatModel(broken);
    assert.ok(
      problems.some((p) => p.includes('invalid status "in-progress"')),
      problems.join("\n"),
    );
  });

  it("flags a high-risk control row that omits the status cell", () => {
    const broken = VALID_MODEL.replace(
      "| Threshold keys | A1/B1 | contracts | planned |",
      "| Threshold keys | A1/B1 | contracts |",
    );
    const problems = validateThreatModel(broken);
    assert.ok(problems.some((p) => p.includes('has invalid status ""')));
  });

  it("exposes only documented control statuses", () => {
    assert.deepEqual([...ALLOWED_CONTROL_STATUSES].sort(), [
      "accepted",
      "implemented",
      "planned",
    ]);
  });
});
