import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  API_ROUTE_POLICIES,
  getRoutePolicy,
  requirePolicy,
  type ApiPolicy,
  type PolicyContext,
} from "./api-policy";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/resource", {
    method: "GET",
    headers,
  });
}

function makeContext(
  headers: Record<string, string> = {},
  env: Record<string, string | undefined> = {},
): PolicyContext {
  return {
    request: makeRequest(headers),
    env,
  };
}

describe("API_ROUTE_POLICIES registry", () => {
  it("classifies every route with a known policy", () => {
    const validPolicies: ApiPolicy[] = ["public", "authenticated", "privileged"];
    for (const [route, policy] of Object.entries(API_ROUTE_POLICIES)) {
      expect(route.startsWith("/"), `route ${route} must start with /`).toBe(true);
      expect(validPolicies).toContain(policy);
    }
  });

  it("includes at least one route of each policy class", () => {
    const policies = new Set(Object.values(API_ROUTE_POLICIES));
    expect(policies.has("public")).toBe(true);
    expect(policies.has("authenticated")).toBe(true);
    expect(policies.has("privileged")).toBe(true);
  });
});

describe("getRoutePolicy", () => {
  it("returns the declared policy for a known route", () => {
    const [route, policy] = Object.entries(API_ROUTE_POLICIES)[0];
    expect(getRoutePolicy(route)).toBe(policy);
  });

  it("defaults unknown routes to the most restrictive policy", () => {
    expect(getRoutePolicy("/api/does-not-exist")).toBe("privileged");
  });
});

describe("requirePolicy - public routes", () => {
  it("passes without any credentials", async () => {
    const result = await requirePolicy("public", makeContext());
    expect(result.ok).toBe(true);
  });

  it("passes even with an invalid token present", async () => {
    const result = await requirePolicy(
      "public",
      makeContext({ authorization: "Bearer garbage" }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("requirePolicy - authenticated routes", () => {
  it("rejects a missing token with 401", async () => {
    const result = await requirePolicy("authenticated", makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects an invalid token with 401", async () => {
    const result = await requirePolicy(
      "authenticated",
      makeContext({ authorization: "Bearer not-a-real-token" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects a malformed authorization header with 401", async () => {
    const result = await requirePolicy(
      "authenticated",
      makeContext({ authorization: "Basic abc123" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("passes with a valid token", async () => {
    const result = await requirePolicy(
      "authenticated",
      makeContext({ authorization: "Bearer valid-user-token" }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("requirePolicy - privileged routes", () => {
  const originalAdminKey = process.env.ADMIN_API_KEY;

  beforeEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  afterEach(() => {
    if (originalAdminKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = originalAdminKey;
    }
  });

  it("rejects a missing token with 401", async () => {
    const result = await requirePolicy(
      "privileged",
      makeContext({}, { ADMIN_API_KEY: "secret-admin-key" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects a non-admin role with 403", async () => {
    const result = await requirePolicy(
      "privileged",
      makeContext(
        { authorization: "Bearer valid-user-token" },
        { ADMIN_API_KEY: "secret-admin-key" },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
    }
  });

  it("rejects an invalid token with 401", async () => {
    const result = await requirePolicy(
      "privileged",
      makeContext(
        { authorization: "Bearer not-a-real-token" },
        { ADMIN_API_KEY: "secret-admin-key" },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("returns 503 when the admin key is not configured", async () => {
    const result = await requirePolicy(
      "privileged",
      makeContext({ authorization: "Bearer secret-admin-key" }, {}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });

  it("passes with a valid admin token", async () => {
    const result = await requirePolicy(
      "privileged",
      makeContext(
        { authorization: "Bearer secret-admin-key" },
        { ADMIN_API_KEY: "secret-admin-key" },
      ),
    );
    expect(result.ok).toBe(true);
  });
});