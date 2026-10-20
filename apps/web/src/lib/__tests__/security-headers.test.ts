// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  NARROW_REQUIRED_ORIGINS,
  HSTS_HEADER_VALUE,
  REFERRER_POLICY_VALUE,
  FRAME_OPTIONS_DENY_VALUE,
  CONTENT_TYPE_OPTIONS_VALUE,
  PERMISSIONS_POLICY_VALUE,
  sanitizeAllowedOrigin,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  applySecurityHeaders,
  buildNextConfigHeaders,
} from "@/lib/security-headers";
import { GET as getWidget } from "@/app/api/campaigns/[id]/widget/route";
import {
  InMemoryCampaignDataSource,
  setCampaignDataSource,
} from "@/services/campaign.service";

describe("Production Browser Security Headers (Issue #99)", () => {
  it("documents every narrowly required external origin with directive and purpose", () => {
    expect(NARROW_REQUIRED_ORIGINS.length).toBeGreaterThanOrEqual(8);
    for (const entry of NARROW_REQUIRED_ORIGINS) {
      expect(entry.origin).toMatch(/^https:\/\//);
      expect(["connect-src", "img-src"]).toContain(entry.directive);
      expect(entry.purpose.length).toBeGreaterThan(10);
    }
  });

  it("sanitizes dynamic environment origins and blocks insecure/wildcard origins in production", () => {
    expect(
      sanitizeAllowedOrigin("https://rpc.mainnet.stellar.org/v1/path?key=123", true)
    ).toBe("https://rpc.mainnet.stellar.org");

    // Rejects plain HTTP in production
    expect(sanitizeAllowedOrigin("http://localhost:8000", true)).toBeNull();
    expect(sanitizeAllowedOrigin("http://rpc.example.com", true)).toBeNull();

    // Allows loopback HTTP only in non-production
    expect(sanitizeAllowedOrigin("http://localhost:8000/soroban/rpc", false)).toBe(
      "http://localhost:8000"
    );
    expect(sanitizeAllowedOrigin("http://127.0.0.1:8000", false)).toBe(
      "http://127.0.0.1:8000"
    );
    expect(sanitizeAllowedOrigin("http://remote-insecure.example.com", false)).toBeNull();

    // Rejects wildcards, credentials, and non-HTTP schemes
    expect(sanitizeAllowedOrigin("https://*.evil.example.com", true)).toBeNull();
    expect(sanitizeAllowedOrigin("*", true)).toBeNull();
    expect(sanitizeAllowedOrigin("https://user:secret@rpc.example.com", true)).toBeNull();
    expect(sanitizeAllowedOrigin("javascript:alert(1)", true)).toBeNull();
  });

  it("builds strict production CSP without unsafe-eval and with frame-ancestors 'none'", () => {
    const csp = buildContentSecurityPolicy({
      isProduction: true,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://custom-soroban.stellar.org/rpc",
        NEXT_PUBLIC_API_URL: "http://insecure.example.com",
      } as unknown as NodeJS.ProcessEnv,
    });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("https://horizon.stellar.org");
    expect(csp).toContain("https://custom-soroban.stellar.org");
    expect(csp).not.toContain("insecure.example.com");
  });

  it("includes HSTS, X-Frame-Options: DENY, Referrer-Policy, and X-Content-Type-Options on standard routes", () => {
    const headers = buildSecurityHeaders({ isProduction: true, allowFraming: false });
    const map = new Map(headers.map((h) => [h.key, h.value]));

    expect(map.get("Strict-Transport-Security")).toBe(HSTS_HEADER_VALUE);
    expect(map.get("X-Frame-Options")).toBe(FRAME_OPTIONS_DENY_VALUE);
    expect(map.get("Referrer-Policy")).toBe(REFERRER_POLICY_VALUE);
    expect(map.get("X-Content-Type-Options")).toBe(CONTENT_TYPE_OPTIONS_VALUE);
    expect(map.get("Permissions-Policy")).toBe(PERMISSIONS_POLICY_VALUE);
    expect(map.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("applies security headers to actual production route responses and honors widget framing rules", async () => {
    const source = new InMemoryCampaignDataSource();
    await source.saveCampaign({
      id: "sec-campaign-1",
      creator: "GCREATOR",
      name: "Security Test Forest",
      status: "ACTIVE",
      goalAmount: "10000",
      raisedAmount: "4500",
      sponsorCount: 4,
      treeCount: 250,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      statusChangedAt: 1_700_000_000_000,
      sponsors: [],
      statusHistory: [],
    });
    setCampaignDataSource(source);

    // 1. Standard JSON metadata endpoint (?format=meta) denies framing
    const metaRes = await getWidget(
      new Request("https://fundable.stellar/api/campaigns/sec-campaign-1/widget?format=meta"),
      { params: Promise.resolve({ id: "sec-campaign-1" }) }
    );
    expect(metaRes.status).toBe(200);
    expect(metaRes.headers.get("Strict-Transport-Security")).toBe(HSTS_HEADER_VALUE);
    expect(metaRes.headers.get("Referrer-Policy")).toBe(REFERRER_POLICY_VALUE);
    expect(metaRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(metaRes.headers.get("X-Frame-Options")).toBe("DENY");
    expect(metaRes.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");

    // 2. Embeddable HTML widget endpoint allows framing via frame-ancestors * and omits X-Frame-Options
    const htmlRes = await getWidget(
      new Request("https://fundable.stellar/api/campaigns/sec-campaign-1/widget"),
      { params: Promise.resolve({ id: "sec-campaign-1" }) }
    );
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("Strict-Transport-Security")).toBe(HSTS_HEADER_VALUE);
    expect(htmlRes.headers.get("Referrer-Policy")).toBe(REFERRER_POLICY_VALUE);
    expect(htmlRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(htmlRes.headers.get("X-Frame-Options")).toBeNull();
    expect(htmlRes.headers.get("Content-Security-Policy")).toContain("frame-ancestors *");

    // 3. Next.js config route rules include both general routes and widget route
    const routeConfigs = buildNextConfigHeaders({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(routeConfigs.some((r) => r.source.includes("(?!api/campaigns/"))).toBe(true);
    expect(routeConfigs.some((r) => r.source === "/api/campaigns/:id/widget")).toBe(true);
  });

  it("applySecurityHeaders mutates and returns a Response with all security headers", () => {
    const res = applySecurityHeaders(new Response("ok", { status: 200 }), {
      isProduction: true,
    });
    expect(res.headers.get("Strict-Transport-Security")).toBe(HSTS_HEADER_VALUE);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe(REFERRER_POLICY_VALUE);
  });
});
