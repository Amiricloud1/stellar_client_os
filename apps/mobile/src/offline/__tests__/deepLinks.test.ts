import { describe, expect, it } from "vitest";
import { CampaignCache, CampaignRepository } from "../campaignCache";
import { createMemoryStorage } from "../storage";
import {
  type ParseResult,
  type DeepLinkError,
  type ResolveResult,
  parseCampaignDeepLink,
  resolveCampaignDeepLink,
} from "../deepLinks";
import type { CampaignDetail, CampaignSummary } from "../types";

const detail = (id: string): CampaignDetail => ({
  id,
  name: `Campaign ${id}`,
  status: "active",
  goalAmount: "1000",
  raisedAmount: "10",
  treeCount: 5,
  sponsorCount: 1,
  sponsors: [],
  verificationProgress: 40,
});

function failingFetch<T>(): Promise<T> {
  return Promise.reject(new Error("offline"));
}

/** Type-safe assertion for a malformed parse result (`ok` discriminates the union). */
function expectMalformed(result: ParseResult, error: DeepLinkError): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(error);
  }
}

function assertOk<T>(
  result: ResolveResult<T>,
): asserts result is Extract<ResolveResult<T>, { status: "ok" }> {
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error(`expected ok, got ${result.status}`);
  }
}

function assertUnavailable<T>(
  result: ResolveResult<T>,
): asserts result is Extract<ResolveResult<T>, { status: "unavailable" }> {
  expect(result.status).toBe("unavailable");
  if (result.status !== "unavailable") {
    throw new Error(`expected unavailable, got ${result.status}`);
  }
}

function assertMalformedResult<T>(
  result: ResolveResult<T>,
): asserts result is Extract<ResolveResult<T>, { status: "malformed" }> {
  expect(result.status).toBe("malformed");
  if (result.status !== "malformed") {
    throw new Error(`expected malformed, got ${result.status}`);
  }
}

describe("parseCampaignDeepLink", () => {
  it("parses https links on our host", () => {
    expect(parseCampaignDeepLink("https://app.fundable.com/campaigns/camp-1")).toEqual({
      ok: true,
      link: { campaignId: "camp-1" },
    });
  });

  it("parses www and bare fundable.com hosts", () => {
    expect(parseCampaignDeepLink("https://www.fundable.com/campaigns/x").ok).toBe(true);
    expect(parseCampaignDeepLink("https://fundable.com/campaigns/y").ok).toBe(true);
  });

  it("parses the custom app scheme", () => {
    expect(parseCampaignDeepLink("fundable://campaigns/z-9")).toEqual({
      ok: true,
      link: { campaignId: "z-9" },
    });
  });

  it("rejects unknown hosts", () => {
    const result = parseCampaignDeepLink("https://evil.example/campaigns/a");
    expectMalformed(result, "unsupported_host");
  });

  it("rejects non-campaign routes", () => {
    const result = parseCampaignDeepLink("https://app.fundable.com/settings");
    expectMalformed(result, "not_a_campaign_route");
  });

  it("rejects missing campaign id", () => {
    const result = parseCampaignDeepLink("https://app.fundable.com/campaigns/");
    expectMalformed(result, "missing_campaign_id");
  });

  it("rejects invalid campaign ids", () => {
    const result = parseCampaignDeepLink(
      "https://app.fundable.com/campaigns/bad id!",
    );
    expectMalformed(result, "invalid_campaign_id");
  });

  it("rejects unsupported schemes", () => {
    const result = parseCampaignDeepLink("mailto:campaigns/a");
    expectMalformed(result, "unsupported_scheme");
  });

  it("rejects garbage input", () => {
    const result = parseCampaignDeepLink("not a url");
    expectMalformed(result, "not_a_url");
  });

  it("decodes percent-encoded ids", () => {
    const result = parseCampaignDeepLink(
      "https://app.fundable.com/campaigns/camp%2D1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.link.campaignId).toBe("camp-1");
    }
  });

  it("accepts trailing query strings", () => {
    const result = parseCampaignDeepLink(
      "https://app.fundable.com/campaigns/camp-1?utm_source=push",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects extra path segments", () => {
    const result = parseCampaignDeepLink(
      "https://app.fundable.com/campaigns/a/b",
    );
    expectMalformed(result, "not_a_campaign_route");
  });
});

describe("resolveCampaignDeepLink", () => {
  it("serves fresh network data and refreshes the cache", async () => {
    const storage = createMemoryStorage();
    const cache = new CampaignCache(storage, { clock: () => 5 });
    const repository = new CampaignRepository<CampaignSummary[], CampaignDetail>(cache);
    const fetched: string[] = [];

    const result = await resolveCampaignDeepLink(
      "https://app.fundable.com/campaigns/camp-1",
      repository,
      async () => {
        fetched.push("camp-1");
        return detail("camp-1");
      },
      { cache },
    );

    assertOk(result);
    expect(result.fromCache).toBe(false);
    expect(result.stale).toBe(false);
    expect(fetched).toEqual(["camp-1"]);
    expect(await cache.readDetail("camp-1")).not.toBeNull();
  });

  it("falls back to cache on cold start when offline", async () => {
    const storage = createMemoryStorage();
    const cache = new CampaignCache(storage, { clock: () => 7 });
    const repository = new CampaignRepository<CampaignSummary[], CampaignDetail>(cache);
    await repository.loadDetail("camp-1", async () => detail("camp-1"));

    const result = await resolveCampaignDeepLink(
      "fundable://campaigns/camp-1",
      repository,
      failingFetch,
      { cache },
    );

    assertOk(result);
    expect(result.fromCache).toBe(true);
    expect(result.cachedAt).toBe(7);
  });

  it("reports unavailable when nothing is cached and offline", async () => {
    const storage = createMemoryStorage();
    const cache = new CampaignCache(storage, { clock: () => 9 });
    const repository = new CampaignRepository<CampaignSummary[], CampaignDetail>(cache);

    const result = await resolveCampaignDeepLink(
      "https://app.fundable.com/campaigns/never-seen",
      repository,
      failingFetch,
      { cache },
    );

    assertUnavailable(result);
    expect(result.campaignId).toBe("never-seen");
    expect(result.staleLabel).toBe(null);
  });

  it("reports last-known freshness when the repository cache misses", async () => {
    const storage = createMemoryStorage();
    const oldCache = new CampaignCache(storage, { clock: () => 100 });
    await oldCache.saveDetail("camp-1", detail("camp-1"));

    // Repository uses a separate empty cache → link resolves to unavailable,
    // while options.cache still reports last-known freshness.
    const repository = new CampaignRepository<CampaignSummary[], CampaignDetail>(
      new CampaignCache(createMemoryStorage()),
    );
    const result = await resolveCampaignDeepLink(
      "fundable://campaigns/camp-1",
      repository,
      failingFetch,
      { cache: oldCache, staleAfterMs: null },
    );

    assertUnavailable(result);
    expect(result.staleLabel).toBe("updated just now");
  });

  it("rejects malformed links without touching the repository", async () => {
    const repository = new CampaignRepository<CampaignSummary[], CampaignDetail>(
      new CampaignCache(createMemoryStorage()),
    );
    let called = false;
    const result = await resolveCampaignDeepLink(
      "https://evil.example/campaigns/a",
      repository,
      async () => {
        called = true;
        return detail("a");
      },
    );

    assertMalformedResult(result);
    expect(result.error).toBe("unsupported_host");
    expect(called).toBe(false);
  });
});
