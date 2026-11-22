import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  API_ROUTE_POLICIES,
  getRoutePolicy,
  requirePolicy,
  type ApiPolicy,
  type PolicyContext,
} from "./api-policy";
import {
  deriveValidator,
  evaluateConditionalRead,
  DEFAULT_CONDITIONAL_READ_LIMITS,
  type ConditionalReadContext,
} from "./conditional-read";
import {
  DEFAULT_REQUEST_BUDGETS,
  RequestBudgetError,
  enforceRequestBudgets,
  type RequestBudgetInput,
} from "./request-budget";
import {
  DEFAULT_COST_WEIGHTS,
  DEFAULT_TENANT_BUDGET,
  TenantCostMeter,
  type CostOperation,
} from "./cost-meter";
import {
  DEFAULT_STAMPEDE_LIMITS,
  StampedeCoalescer,
  type StampedeScope,
} from "./stampede-coalescer";

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

describe("conditional reads", () => {
  const baseContext: ConditionalReadContext = {
    principalId: "user-1",
    tenantId: "tenant-1",
    scope: "analytics:summary",
    representation: { total: 42, filters: { region: "eu" } },
  };

  it("derives a stable validator for identical representation and context", () => {
    const a = deriveValidator(baseContext);
    const b = deriveValidator({
      ...baseContext,
      representation: { total: 42, filters: { region: "eu" } },
    });
    expect(a).toBe(b);
    expect(a.startsWith('W/"')).toBe(true);
  });

  it("returns 200 with a validator when no If-None-Match is supplied", () => {
    const result = evaluateConditionalRead(baseContext, undefined);
    expect(result.status).toBe(200);
    expect(result.etag).toBe(deriveValidator(baseContext));
    expect(result.notModified).toBe(false);
  });

  it("returns 304 when the client validator matches", () => {
    const etag = deriveValidator(baseContext);
    const result = evaluateConditionalRead(baseContext, etag);
    expect(result.status).toBe(304);
    expect(result.notModified).toBe(true);
    expect(result.etag).toBe(etag);
  });

  it("returns 200 when the client validator does not match", () => {
    const result = evaluateConditionalRead(baseContext, 'W/"stale-validator"');
    expect(result.status).toBe(200);
    expect(result.notModified).toBe(false);
  });

  it("supports comma-separated If-None-Match lists", () => {
    const etag = deriveValidator(baseContext);
    const result = evaluateConditionalRead(
      baseContext,
      `W/"other", ${etag}`,
    );
    expect(result.status).toBe(304);
  });

  it("isolates validators across principals", () => {
    const other = deriveValidator({ ...baseContext, principalId: "user-2" });
    expect(other).not.toBe(deriveValidator(baseContext));
    const result = evaluateConditionalRead(
      { ...baseContext, principalId: "user-2" },
      deriveValidator(baseContext),
    );
    expect(result.status).toBe(200);
  });

  it("isolates validators across tenants and scopes", () => {
    const base = deriveValidator(baseContext);
    expect(deriveValidator({ ...baseContext, tenantId: "tenant-2" })).not.toBe(base);
    expect(deriveValidator({ ...baseContext, scope: "analytics:detail" })).not.toBe(base);
  });

  it("isolates validators across authorization context", () => {
    const base = deriveValidator(baseContext);
    const elevated = deriveValidator({
      ...baseContext,
      authorizationContext: "role:admin",
    });
    expect(elevated).not.toBe(base);
  });

  it("recovers from a stale validator after the representation changes", () => {
    const stale = deriveValidator(baseContext);
    const changed: ConditionalReadContext = {
      ...baseContext,
      representation: { total: 43, filters: { region: "eu" } },
    };
    const result = evaluateConditionalRead(changed, stale);
    expect(result.status).toBe(200);
    expect(result.etag).not.toBe(stale);
  });

  it("rejects oversized representations with a 413 envelope", () => {
    const huge = { blob: "x".repeat(DEFAULT_CONDITIONAL_READ_LIMITS.maxRepresentationBytes + 1) };
    expect(() => deriveValidator({ ...baseContext, representation: huge })).toThrowError(
      expect.objectContaining({ status: 413 }),
    );
  });
});

describe("request budgets", () => {
  function input(overrides: Partial<RequestBudgetInput> = {}): RequestBudgetInput {
    return {
      body: "",
      listDepth: 0,
      filterCount: 0,
      ...overrides,
    };
  }

  it("accepts a request within all budgets", () => {
    expect(() => enforceRequestBudgets(input())).not.toThrow();
  });

  it("accepts values exactly at the boundary", () => {
    expect(() =>
      enforceRequestBudgets(
        input({
          body: "x".repeat(DEFAULT_REQUEST_BUDGETS.maxBodyBytes),
          listDepth: DEFAULT_REQUEST_BUDGETS.maxListDepth,
          filterCount: DEFAULT_REQUEST_BUDGETS.maxFilterCount,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an oversized body with a 413 envelope", () => {
    try {
      enforceRequestBudgets(
        input({ body: "x".repeat(DEFAULT_REQUEST_BUDGETS.maxBodyBytes + 1) }),
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBudgetError);
      const budgetError = error as RequestBudgetError;
      expect(budgetError.status).toBe(413);
      expect(budgetError.code).toBe("request_body_too_large");
      expect(budgetError.toResponse().status).toBe(413);
    }
  });

  it("rejects nested lists beyond the depth budget with a 422 envelope", () => {
    try {
      enforceRequestBudgets(
        input({ listDepth: DEFAULT_REQUEST_BUDGETS.maxListDepth + 1 }),
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBudgetError);
      const budgetError = error as RequestBudgetError;
      expect(budgetError.status).toBe(422);
      expect(budgetError.code).toBe("list_depth_exceeded");
    }
  });

  it("rejects too many filters with a 422 envelope", () => {
    try {
      enforceRequestBudgets(
        input({ filterCount: DEFAULT_REQUEST_BUDGETS.maxFilterCount + 1 }),
      );
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestBudgetError);
      const budgetError = error as RequestBudgetError;
      expect(budgetError.status).toBe(422);
      expect(budgetError.code).toBe("filter_count_exceeded");
    }
  });

  it("rejects negative counters as invalid input", () => {
    expect(() => enforceRequestBudgets(input({ filterCount: -1 }))).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
  });
});

describe("tenant cost meter", () => {
  let now = 0;
  let meter: TenantCostMeter;

  beforeEach(() => {
    now = 1_000;
    meter = new TenantCostMeter({ now: () => now });
  });

  it("weights exports and analytics more heavily than lightweight reads", () => {
    expect(DEFAULT_COST_WEIGHTS.export).toBeGreaterThan(DEFAULT_COST_WEIGHTS.read);
    expect(DEFAULT_COST_WEIGHTS.analytics).toBeGreaterThan(DEFAULT_COST_WEIGHTS.read);
  });

  it("consumes weighted cost for a lightweight read", () => {
    const result = meter.consume("tenant-1", "read");
    expect(result.allowed).toBe(true);
    expect(result.consumed).toBe(DEFAULT_COST_WEIGHTS.read);
    expect(result.remaining).toBe(DEFAULT_TENANT_BUDGET - DEFAULT_COST_WEIGHTS.read);
  });

  it("consumes more budget for an export than a read", () => {
    const read = meter.consume("tenant-1", "read");
    const exportResult = meter.consume("tenant-1", "export");
    expect(exportResult.consumed).toBeGreaterThan(read.consumed);
  });

  it("isolates budgets across tenants", () => {
    meter.consume("tenant-1", "export");
    const other = meter.consume("tenant-2", "read");
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(DEFAULT_TENANT_BUDGET - DEFAULT_COST_WEIGHTS.read);
  });

  it("rejects when the budget is exhausted and reports Retry-After", () => {
    const operations: CostOperation[] = ["export", "export", "export"];
    let last = meter.consume("tenant-1", "read");
    for (const op of operations) {
      last = meter.consume("tenant-1", op);
    }
    const denied = meter.consume("tenant-1", "export");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.allowed).toBe(true);
  });

  it("recovers after the window rolls over", () => {
    for (let i = 0; i < 10; i += 1) {
      meter.consume("tenant-1", "export");
    }
    expect(meter.consume("tenant-1", "export").allowed).toBe(false);
    now += DEFAULT_TENANT_BUDGET.windowSeconds * 1000 + 1;
    const recovered = meter.consume("tenant-1", "export");
    expect(recovered.allowed).toBe(true);
    expect(recovered.remaining).toBe(DEFAULT_TENANT_BUDGET - DEFAULT_COST_WEIGHTS.export);
  });
});

describe("stampede coalescer", () => {
  const scope: StampedeScope = {
    tenantId: "tenant-1",
    principalId: "user-1",
    scope: "analytics:summary",
    filters: { region: "eu" },
  };

  it("coalesces concurrent identical cold reads", async () => {
    const coalescer = new StampedeCoalescer();
    let calls = 0;
    const loader = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { total: 42 };
    });
    const results = await Promise.all([
      coalescer.load(scope, loader),
      coalescer.load(scope, loader),
      coalescer.load(scope, loader),
    ]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.value.total === 42)).toBe(true);
    expect(results.every((r) => r.stale === false)).toBe(true);
  });

  it("does not coalesce across principals, tenants, scopes or filters", async () => {
    const coalescer = new StampedeCoalescer();
    const loader = vi.fn(async () => ({ total: 1 }));
    await Promise.all([
      coalescer.load(scope, loader),
      coalescer.load({ ...scope, principalId: "user-2" }, loader),
      coalescer.load({ ...scope, tenantId: "tenant-2" }, loader),
      coalescer.load({ ...scope, scope: "analytics:detail" }, loader),
      coalescer.load({ ...scope, filters: { region: "us" } }, loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(5);
  });

  it("serves bounded stale data while a refresh is in flight", async () => {
    let now = 0;
    const coalescer = new StampedeCoalescer({ now: () => now });
    await coalescer.load(scope, async () => ({ total: 1 }));
    now += DEFAULT_STAMPEDE_LIMITS.freshForSeconds * 1000 + 1;
    let resolveRefresh: (value: { total: number }) => void = () => {};
    const refresh = coalescer.load(
      scope,
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const stale = await coalescer.load(scope, async () => ({ total: 99 }));
    expect(stale.stale).toBe(true);
    expect(stale.value.total).toBe(1);
    resolveRefresh({ total: 2 });
    await refresh;
  });

  it("stops serving stale data past the stale bound", async () => {
    let now = 0;
    const coalescer = new StampedeCoalescer({ now: () => now });
    await coalescer.load(scope, async () => ({ total: 1 }));
    now +=
      (DEFAULT_STAMPEDE_LIMITS.freshForSeconds +
        DEFAULT_STAMPEDE_LIMITS.staleForSeconds) *
        1000 +
      1;
    const result = await coalescer.load(scope, async () => ({ total: 2 }));
    expect(result.stale).toBe(false);
    expect(result.value.total).toBe(2);
  });

  it("recovers after a backend failure", async () => {
    const coalescer = new StampedeCoalescer();
    await expect(
      coalescer.load(scope, async () => {
        throw new Error("backend down");
      }),
    ).rejects.toThrow("backend down");
    const recovered = await coalescer.load(scope, async () => ({ total: 7 }));
    expect(recovered.value.total).toBe(7);
    expect(recovered.stale).toBe(false);
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