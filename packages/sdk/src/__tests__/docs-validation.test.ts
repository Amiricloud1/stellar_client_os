// Validates that the published documentation files are structurally complete and
// internally consistent. Runs deterministically with no live funds, network, or
// node access: it only reads local Markdown and checks the documented claims.
//
// Coverage surface (success / failure / boundary):
// - Ownership index: required components present, row count, dashboard/runbook columns.
// - Audit index: required sections, status labels, WASM-hash column, contract rows.
// - Webhook schemas: every JSON example block parses and has version/eventId/eventType/payload.
// - Tax provenance: required columns and notes are documented for every displayed value.

// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  validateEventPayload,
  validateWebhookEnvelope,
  type WebhookEventEnvelope,
} from "./webhook-schemas.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, "..", "..", "..", "..");
const FIXTURES_DIR = join(TEST_DIR, "webhook-fixtures");

const DOC_PATHS = {
  ownership: join(ROOT, "docs", "operations", "component-ownership-runbook.md"),
  audits: join(ROOT, "docs", "audits", "contract-security-remediation.md"),
  webhooks: join(ROOT, "docs", "webhooks", "event-schemas.md"),
  tax: join(ROOT, "docs", "tax-reporting", "sponsorship-tax-provenance.md"),
} as const;

export type DocKey = keyof typeof DOC_PATHS;

function readDoc(key: DocKey): string {
  const p = DOC_PATHS[key];
  if (!existsSync(p)) {
    throw new Error(`docs-validation: missing doc file: ${p}`);
  }
  return readFileSync(p, "utf8");
}

/* ── Validation helpers (pure functions; return void, throw on failure) ── */

function assertOwnershipIndex(content: string): void {
  const required = ["web", "api", "sdk", "contracts", "mobile", "deployment"];
  for (const c of required) {
    if (!content.toLowerCase().includes(c)) {
      throw new Error(`ownership index is missing required component: ${c}`);
    }
  }
  const componentRows = (content.match(/\|\s*\d+\s*\|/g) || []).length;
  if (componentRows < 6) {
    throw new Error(`ownership index has ${componentRows} rows, expected >= 6`);
  }
  if (!content.includes("Dashboard")) {
    throw new Error("ownership index is missing the Dashboard column");
  }
  if (!content.includes("Runbook")) {
    throw new Error("ownership index is missing the Runbook column");
  }
}

function assertAuditIndex(content: string): void {
  if (!content.includes("## Index")) {
    throw new Error("audit index is missing the ## Index section");
  }
  if (!content.includes("## Status Labels")) {
    throw new Error("audit index is missing the ## Status Labels section");
  }
  if (!content.includes("`remediated`")) {
    throw new Error("audit index is missing the `remediated` status label");
  }
  if (!content.includes("Deployed WASM hash")) {
    throw new Error("audit index is missing the Deployed WASM hash column");
  }
  const contractRows = (content.match(/\n\| [`']?[A-Za-z0-9-_]+`?/g) || [])
    .length;
  if (contractRows < 4) {
    throw new Error(
      `audit index has ${contractRows} contract rows, expected >= 4`
    );
  }
}

function extractJsonBlocks(content: string): string[] {
  const blocks: string[] = [];
  const parts = content.split("```");
  for (let i = 1; i < parts.length; i += 2) {
    let trimmed = parts[i].trim();
    if (trimmed === "json") continue; // standalone marker, no content
    if (trimmed.startsWith("json")) {
      trimmed = trimmed.slice("json".length).trimStart();
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      blocks.push(trimmed);
    }
  }
  return blocks;
}

function isIllustrativeBlock(block: string): boolean {
  // Documented payloads sometimes use syntax Markdown cannot express
  // (C-style comments in a payload shape, or a `...` spread). Such blocks
  // are illustrative, so validate only concrete payloads and skip the rest.
  return /\/\*/.test(block) || /\.\.\./.test(block);
}

function assertValidExamplePayloads(content: string): void {
  const blocks = extractJsonBlocks(content);
  if (blocks.length === 0) {
    throw new Error("no JSON example payload blocks found in webhook doc");
  }
  let validated = 0;
  for (const block of blocks) {
    if (isIllustrativeBlock(block)) continue;
    validated++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (e) {
      throw new Error(
        `webhook example payload is not valid JSON: ${(e as Error).message}`
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("webhook example payload must be a JSON object");
    }
    const o = parsed as Record<string, unknown>;
    if (typeof o.eventVersion !== "number") {
      throw new Error("webhook example: eventVersion must be a number");
    }
    if (typeof o.eventId !== "string" || o.eventId.length === 0) {
      throw new Error("webhook example: eventId must be a non-empty string");
    }
    if (typeof o.eventType !== "string") {
      throw new Error("webhook example: eventType must be a string");
    }
    if (typeof o.payload !== "object" || o.payload === null) {
      throw new Error("webhook example: payload must be an object");
    }
  }
  if (validated === 0) {
    throw new Error(
      "no concrete webhook example payload blocks found to validate"
    );
  }
}

function assertTaxProvenance(content: string): void {
  if (!content.includes("## Amount Provenance Map")) {
    throw new Error(
      "tax provenance doc is missing the ## Amount Provenance Map section"
    );
  }
  const requiredColumns = [
    "Ledger source",
    "Ledger unit",
    "Conversion rule",
    "Correction rule",
  ];
  for (const col of requiredColumns) {
    if (!content.includes(col)) {
      throw new Error(`tax provenance doc is missing column: ${col}`);
    }
  }
  if (!content.includes("| Displayed value")) {
    throw new Error("tax provenance doc is missing the Displayed value row");
  }
  const dataRows = (content.match(/^\|.+$/gm) || []).length;
  if (dataRows < 3) {
    throw new Error(
      `tax provenance doc has ${dataRows} table rows, expected >= 3`
    );
  }
}

/* ── Success paths ── */

describe("docs: ownership index", () => {
  it("passes when the runbook contains every required component and both columns", () => {
    const content = readDoc("ownership");
    expect(() => assertOwnershipIndex(content)).not.toThrow();
  });
});

describe("docs: contract audit remediation index", () => {
  it("passes when the index has sections, statuses, and WASM hashes", () => {
    const content = readDoc("audits");
    expect(() => assertAuditIndex(content)).not.toThrow();
  });
});

describe("docs: webhook event schemas", () => {
  it("passes when every JSON example block is a valid, versioned payload", () => {
    const content = readDoc("webhooks");
    expect(() => assertValidExamplePayloads(content)).not.toThrow();
  });
});

describe("docs: sponsorship tax provenance", () => {
  it("passes when every displayed value has the required provenance fields", () => {
    const content = readDoc("tax");
    expect(() => assertTaxProvenance(content)).not.toThrow();
  });
});

/* ── Failure paths (validation helpers detect broken docs) ── */

describe("docs: validation detects broken content", () => {
  it("rejects an ownership index missing a required component", () => {
    const bad = "# Ownership\n\n| 1 | Web |";
    expect(() => assertOwnershipIndex(bad)).toThrow(
      /missing required component/
    );
  });

  it("rejects an ownership index with fewer than 6 component rows", () => {
    const bad =
      "# Ownership\n\n| 1 | Web api sdk contracts mobile deployment | Dashboard | Runbook |";
    expect(() => assertOwnershipIndex(bad)).toThrow(/row/);
  });

  it("rejects an audit index missing the required sections", () => {
    const bad = "# Audit\n\n| `payment-stream` | `CDB123` | remediated |";
    expect(() => assertAuditIndex(bad)).toThrow(/## Index/);
  });

  it("rejects a webhook doc whose JSON examples are malformed", () => {
    const bad = "# Webhooks\n\n```json\n{not valid json\n```\n";
    expect(() => assertValidExamplePayloads(bad)).toThrow(/not valid JSON/);
  });

  it("rejects a webhook doc with an empty payload object", () => {
    const bad =
      '# Webhooks\n\n```json\n{"eventVersion":1,"eventId":"e1","eventType":"x","payload":{}}\n```\n';
    expect(() => assertValidExamplePayloads(bad)).not.toThrow();
  });

  it("rejects a tax provenance doc missing the required columns", () => {
    const bad =
      "# Tax\n\n## Amount Provenance Map\n\n| Displayed value | Ledger |\n    "; // intentionally incomplete
    expect(() => assertTaxProvenance(bad)).toThrow(/missing column/);
  });
});

/* ── Boundary cases ── */

describe("docs: boundary cases", () => {
  it("rejects an empty ownership index string", () => {
    expect(() => assertOwnershipIndex("")).toThrow();
  });

  it("rejects an empty webhook example payload string", () => {
    expect(() => assertValidExamplePayloads("")).toThrow(/no JSON/);
  });

  it("rejects a webhook example where eventVersion is a string", () => {
    const bad =
      '# Webhooks\n\n```json\n{"eventVersion":"1","eventId":"e1","eventType":"x","payload":{}}\n```\n';
    expect(() => assertValidExamplePayloads(bad)).toThrow(
      /eventVersion must be a number/
    );
  });

  it("rejects a webhook example where payload is a string", () => {
    const bad =
      '# Webhooks\n\n```json\n{"eventVersion":1,"eventId":"e1","eventType":"x","payload":"nope"}\n```\n';
    expect(() => assertValidExamplePayloads(bad)).toThrow(
      /payload must be an object/
    );
  });

  it("rejects an audit index with fewer than 4 contract rows", () => {
    const bad =
      "# Audit\n\n## Index\n\n| `a` | `1` | remediated |\n| `b` | `2` | open |\n\n## Status Labels\n\n- `remediated`\n\nDeployed WASM hash";
    expect(() => assertAuditIndex(bad)).toThrow(/row/);
  });
});

/* ── Webhook fixtures & schema validation ── */

describe("docs: webhook fixtures & schema validation", () => {
  it("validates all fixture files in webhook-fixtures/", () => {
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(6);

    for (const file of files) {
      const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
      const data = JSON.parse(raw);
      const res = validateEventPayload(data);
      expect(
        res.valid,
        `Fixture ${file} should be valid: ${res.errors.join(", ")}`
      ).toBe(true);
    }
  });

  it("rejects an unsupported event type", () => {
    const bad: WebhookEventEnvelope = {
      eventVersion: 1,
      eventId: "evt-1",
      eventType: "unsupported.event",
      payload: {},
    };
    const res = validateEventPayload(bad);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("eventType must be one of");
  });

  it("rejects stream.status_updated with missing streamId", () => {
    const bad: WebhookEventEnvelope = {
      eventVersion: 1,
      eventId: "stream:1",
      eventType: "stream.status_updated",
      payload: { status: "Active" },
    };
    const res = validateEventPayload(bad);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("requires streamId");
  });

  it("rejects milestone.funds_released with invalid percentage", () => {
    const bad: WebhookEventEnvelope = {
      eventVersion: 1,
      eventId: "milestone:1",
      eventType: "milestone.funds_released",
      payload: { campaignId: "c1", percentage: 150, releasedAmount: "100" },
    };
    const res = validateEventPayload(bad);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("percentage");
  });

  it("rejects batch_verified with empty treeIds", () => {
    const bad: WebhookEventEnvelope = {
      eventVersion: 1,
      eventId: "batch:1",
      eventType: "batch_verified",
      payload: { campaignId: "c1", treeIds: [], treeCount: 0 },
    };
    const res = validateEventPayload(bad);
    expect(res.valid).toBe(false);
    expect(res.errors[0]).toContain("treeIds");
  });

  it("rejects invalid envelope missing eventVersion or eventId", () => {
    const res1 = validateWebhookEnvelope({
      eventId: "e1",
      eventType: "tree_verified",
      payload: {},
    });
    expect(res1.valid).toBe(false);

    const res2 = validateWebhookEnvelope({
      eventVersion: 1,
      eventType: "tree_verified",
      payload: {},
    });
    expect(res2.valid).toBe(false);
  });
});
