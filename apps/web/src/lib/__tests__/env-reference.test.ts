// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pins docs/environment-variables.md (#119) against the runtime schemas:
 * every `NEXT_PUBLIC_*` key of `envSchema` and every key of `s3ConfigSchema`
 * must appear in the reference doc, and the required web keys must be
 * represented in `.env.example`.
 */
const REPO_ROOT = resolve(__dirname, "../../../../..");

function readRepo(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("environment-variable reference consistency", () => {
  it("documents every NEXT_PUBLIC_* key of envSchema", () => {
    const source = readRepo("apps/web/src/lib/env.ts");
    const doc = readRepo("docs/environment-variables.md");

    const keys = new Set<string>();
    for (const match of source.matchAll(/(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      keys.add(match[1]);
    }
    expect(keys.size).toBeGreaterThan(0);

    const missing = [...keys].filter((key) => !doc.includes(`\`${key}\``));
    expect(missing).toEqual([]);
  });

  it("documents every key of s3ConfigSchema", () => {
    const source = readRepo("apps/web/src/lib/s3/config.ts");
    const doc = readRepo("docs/environment-variables.md");

    for (const key of [
      "AWS_REGION",
      "AWS_S3_BUCKET",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "S3_PRESIGN_EXPIRES_SECONDS",
    ]) {
      expect(source).toContain(key);
      expect(doc).toContain(`\`${key}\``);
    }
  });

  it("represents required web keys in .env.example", () => {
    const example = readRepo(".env.example");

    for (const key of [
      "NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID",
      "NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID",
      "NEXT_PUBLIC_SOROBAN_RPC_URL",
      "NEXT_PUBLIC_STELLAR_NETWORK",
    ]) {
      expect(example).toContain(key);
    }
  });

  it("classifies secrets explicitly in the reference", () => {
    const doc = readRepo("docs/environment-variables.md");

    for (const secret of [
      "AWS_SECRET_ACCESS_KEY",
      "ADMIN_API_KEY",
      "STELLAR_SECRET_KEY",
      "BOT_SECRET_KEY",
      "DATABASE_URL",
    ]) {
      expect(doc).toContain(`\`${secret}\``);
    }
    // The doc must warn that client-bundled vars are never secret-bearing.
    expect(doc).toMatch(/never put secrets there/i);
  });
});
