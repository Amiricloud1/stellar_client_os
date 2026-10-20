// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  RateLimiter,
  SharedAtomicCounterStore,
  SLIDING_WINDOW_SCRIPT,
  resolveRouteClassPolicy,
  buildRateLimitHeaders,
  createRateLimiter,
  getTierConfig,
  RATE_LIMIT_TIERS,
  resolveTier,
  CAMPAIGN_API_RATE_LIMIT_TIERS,
  resolveCampaignApiTier,
  resolveCampaignApiTierByFunding,
  type RateLimitResult,
} from "./rate-limit";
import {
  checkRateLimit,
  createRouteClassLimiter,
} from "@/middlewares/rate-limit.middleware";

// ── Mock Redis client ─────────────────────────────────────────────────────────

type RedisClientParam = ConstructorParameters<typeof RateLimiter>[0];

function makeRedis(evalResult: [number, number] = [1, Date.now()]) {
  return {
    eval: vi.fn().mockResolvedValue(evalResult),
    quit: vi.fn().mockResolvedValue("OK"),
  };
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

describe("RateLimiter.check", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns allowed:true when count is within limit", async () => {
    const redis = makeRedis([3, Date.now() - 10_000]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 10, windowMs: 60_000 });
    const result = await limiter.check("127.0.0.1");
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(3);
    expect(result.remaining).toBe(7);
    expect(result.limit).toBe(10);
    expect(result.degraded).toBe(false);
    expect(result.reason).toBe("OK");
  });

  it("returns allowed:false when count exceeds limit", async () => {
    const redis = makeRedis([11, Date.now() - 5_000]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 10, windowMs: 60_000 });
    const result = await limiter.check("10.0.0.1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.count).toBe(11);
    expect(result.reason).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns allowed:true at exactly the limit (boundary)", async () => {
    const redis = makeRedis([10, Date.now()]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 10, windowMs: 60_000 });
    const result = await limiter.check("192.168.1.1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("gracefully allows when Redis is null (default fail-open)", async () => {
    const limiter = new RateLimiter(null, { limit: 10, windowMs: 60_000 });
    const result = await limiter.check("1.2.3.4");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe("REDIS_UNAVAILABLE_FAIL_OPEN");
  });

  it("gracefully allows when Redis eval throws (default fail-open)", async () => {
    const redis = { eval: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 5, windowMs: 60_000 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await limiter.check("5.5.5.5");
    spy.mockRestore();
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe("REDIS_UNAVAILABLE_FAIL_OPEN");
  });

  it("uses the configured keyPrefix in the Redis call", async () => {
    const redis = makeRedis([1, Date.now()]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, {
      limit: 100,
      windowMs: 60_000,
      keyPrefix: "rl:stream",
    });
    await limiter.check("user-abc");
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rl:stream:user-abc",
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String)
    );
  });

  it("calculates resetAt from oldest score when present", async () => {
    const now = Date.now();
    const oldestScore = now - 30_000;
    const redis = makeRedis([1, oldestScore]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 10, windowMs: 60_000 });
    const result = await limiter.check("1.1.1.1");
    // resetAt = oldestScore + windowMs
    expect(result.resetAt).toBe(oldestScore + 60_000);
  });

  it("passes correct TTL to Lua script (ceil(windowMs/1000)+1)", async () => {
    const redis = makeRedis([1, Date.now()]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 5, windowMs: 30_000 });
    await limiter.check("x");
    // TTL should be ceil(30000/1000)+1 = 31
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.any(String),
      expect.any(String),
      "30000",
      "5",
      "31"
    );
  });

  it("uses distinct keys for different identifiers", async () => {
    const redis = makeRedis([1, Date.now()]);
    const limiter = new RateLimiter(redis as unknown as RedisClientParam, { limit: 10, keyPrefix: "rl" });
    await limiter.check("192.168.0.1");
    await limiter.check("192.168.0.2");
    const calls = (redis.eval as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][2]).toBe("rl:192.168.0.1");
    expect(calls[1][2]).toBe("rl:192.168.0.2");
  });
});

// ── Shared Atomic Counters Across App Instances & Redis Outage Behavior (#100) ─

describe("Distributed Atomic Rate Limiting & Outage Fail-Safety (Issue #100)", () => {
  it("Lua script uses shared atomic Redis INCR counter instead of math.random", () => {
    expect(SLIDING_WINDOW_SCRIPT).toContain("redis.call('INCR', seq_key)");
    expect(SLIDING_WINDOW_SCRIPT).not.toContain("math.random");
    expect(SLIDING_WINDOW_SCRIPT).toContain("if count < limit then");
  });

  it("enforces exact quota across multiple app instances sharing atomic counters", async () => {
    const sharedStore = new SharedAtomicCounterStore();
    const instanceA = new RateLimiter(sharedStore.asRedisClient(), {
      limit: 5,
      windowMs: 60_000,
      keyPrefix: "rl:submit",
      routeClass: "financial-submission",
    });
    const instanceB = new RateLimiter(sharedStore.asRedisClient(), {
      limit: 5,
      windowMs: 60_000,
      keyPrefix: "rl:submit",
      routeClass: "financial-submission",
    });
    const instanceC = new RateLimiter(sharedStore.asRedisClient(), {
      limit: 5,
      windowMs: 60_000,
      keyPrefix: "rl:submit",
      routeClass: "financial-submission",
    });

    // Fire 8 concurrent requests distributed across 3 app instances for the same client IP
    const results = await Promise.all([
      instanceA.check("203.0.113.10"),
      instanceB.check("203.0.113.10"),
      instanceC.check("203.0.113.10"),
      instanceA.check("203.0.113.10"),
      instanceB.check("203.0.113.10"),
      instanceC.check("203.0.113.10"),
      instanceA.check("203.0.113.10"),
      instanceB.check("203.0.113.10"),
    ]);

    const allowedCount = results.filter((r) => r.allowed).length;
    const rejectedCount = results.filter((r) => !r.allowed).length;
    expect(allowedCount).toBe(5);
    expect(rejectedCount).toBe(3);
    expect(results[4].remaining).toBe(0);
    expect(results[5].allowed).toBe(false);
    expect(results[5].reason).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("does not extend the lockout window when blocked requests continue arriving", () => {
    const store = new SharedAtomicCounterStore();
    const t0 = 1_700_000_000_000;
    // Admit 2 requests (limit = 2, window = 10_000ms)
    expect(store.evaluate("rl:test:ip", t0, 10_000, 2, 11)[0]).toBe(1);
    expect(store.evaluate("rl:test:ip", t0 + 1_000, 10_000, 2, 11)[0]).toBe(2);

    // 3rd request at t0 + 5_000 is rejected (count = 3 > 2)
    const [rejectedCount] = store.evaluate("rl:test:ip", t0 + 5_000, 10_000, 2, 11);
    expect(rejectedCount).toBe(3);

    // At t0 + 11_001, the first two requests have expired; because the 3rd was not admitted,
    // a new request is allowed immediately instead of being locked out until t0 + 15_000!
    const [afterWindowCount] = store.evaluate("rl:test:ip", t0 + 11_001, 10_000, 2, 11);
    expect(afterWindowCount).toBe(1);
  });

  it("fails closed for financial-submission, sensitive-mutation, and admin-privileged routes on Redis outage", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenRedis = {
      eval: vi.fn().mockRejectedValue(new Error("Redis cluster down: ECONNREFUSED")),
    } as unknown as RedisClientParam;

    for (const routeClass of [
      "financial-submission",
      "sensitive-mutation",
      "admin-privileged",
    ] as const) {
      expect(resolveRouteClassPolicy(routeClass).failurePolicy).toBe("fail-closed");

      // Both null Redis and runtime Redis error must fail closed
      const limiterNull = new RateLimiter(null, { limit: 10, routeClass });
      const resNull = await limiterNull.check("198.51.100.5");
      expect(resNull.allowed).toBe(false);
      expect(resNull.degraded).toBe(true);
      expect(resNull.failurePolicy).toBe("fail-closed");
      expect(resNull.routeClass).toBe(routeClass);
      expect(resNull.reason).toBe("REDIS_UNAVAILABLE_FAIL_CLOSED");

      const limiterErr = new RateLimiter(brokenRedis, { limit: 10, routeClass });
      const resErr = await limiterErr.check("198.51.100.5");
      expect(resErr.allowed).toBe(false);
      expect(resErr.degraded).toBe(true);
      expect(resErr.reason).toBe("REDIS_UNAVAILABLE_FAIL_CLOSED");
    }
    spy.mockRestore();
  });

  it("falls back to bounded in-memory atomic counter for standard-write routes on Redis outage", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenRedis = {
      eval: vi.fn().mockRejectedValue(new Error("ETIMEDOUT")),
    } as unknown as RedisClientParam;

    const limiter = new RateLimiter(brokenRedis, {
      limit: 2,
      windowMs: 60_000,
      routeClass: "standard-write",
    });

    const first = await limiter.check("198.51.100.99");
    const second = await limiter.check("198.51.100.99");
    const third = await limiter.check("198.51.100.99");

    expect(first.allowed).toBe(true);
    expect(first.degraded).toBe(true);
    expect(first.failurePolicy).toBe("fallback-memory");
    expect(first.reason).toBe("REDIS_UNAVAILABLE_FALLBACK_MEMORY");

    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);

    expect(third.allowed).toBe(false);
    expect(third.degraded).toBe(true);
    expect(third.reason).toBe("RATE_LIMIT_EXCEEDED");

    spy.mockRestore();
  });

  it("fails open for public-read routes on Redis outage", async () => {
    const limiter = createRouteClassLimiter("public-read", null, { limit: 5 });
    const res = await limiter.check("198.51.100.77");
    expect(res.allowed).toBe(true);
    expect(res.degraded).toBe(true);
    expect(res.failurePolicy).toBe("fail-open");
    expect(res.reason).toBe("REDIS_UNAVAILABLE_FAIL_OPEN");
  });

  it("returns 503 Service Unavailable with X-RateLimit-Degraded header from middleware when fail-closed route encounters Redis outage", async () => {
    const limiter = createRouteClassLimiter("financial-submission", null, { limit: 10 });
    const req = new NextRequest("http://localhost/api/tax/generate-1099", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.42" },
    });

    const response = await checkRateLimit(req, limiter);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect(response!.headers.get("X-RateLimit-Degraded")).toBe("true");
    expect(response!.headers.get("X-RateLimit-Policy-Mode")).toBe("fail-closed");
    expect(response!.headers.get("Retry-After")).toBeDefined();

    const body = await response!.json();
    expect(body.code).toBe("RATE_LIMIT_BACKEND_UNAVAILABLE");
    expect(body.degraded).toBe(true);
    expect(body.routeClass).toBe("financial-submission");
  });
});

// ── buildRateLimitHeaders ─────────────────────────────────────────────────────

describe("buildRateLimitHeaders", () => {
  const now = Date.now();
  const allowedResult: RateLimitResult = {
    allowed: true,
    remaining: 57,
    limit: 60,
    resetAt: now + 45_000,
    count: 3,
  };
  const rejectedResult: RateLimitResult = {
    allowed: false,
    remaining: 0,
    limit: 60,
    resetAt: now + 30_000,
    count: 61,
  };

  it("includes RateLimit-Limit, Remaining, Reset for allowed requests", () => {
    const headers = buildRateLimitHeaders(allowedResult);
    expect(headers["RateLimit-Limit"]).toBe("60");
    expect(headers["RateLimit-Remaining"]).toBe("57");
    expect(headers["X-RateLimit-Limit"]).toBe("60");
    expect(headers["X-RateLimit-Remaining"]).toBe("57");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After for rejected requests", () => {
    const headers = buildRateLimitHeaders(rejectedResult);
    expect(headers["Retry-After"]).toBeDefined();
    expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("does not include Retry-After when allowed", () => {
    const headers = buildRateLimitHeaders(allowedResult);
    expect(Object.keys(headers)).not.toContain("Retry-After");
  });

  it("Reset header is in seconds (positive integer)", () => {
    const headers = buildRateLimitHeaders(allowedResult);
    const reset = Number(headers["RateLimit-Reset"]);
    expect(reset).toBeGreaterThan(0);
    expect(Number.isInteger(reset)).toBe(true);
  });
});

// ── createRateLimiter ─────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  it("creates a RateLimiter with env var defaults", () => {
    const limiter = createRateLimiter(null);
    expect(limiter).toBeInstanceOf(RateLimiter);
  });

  it("overrides are applied over env defaults", async () => {
    const redis = makeRedis([1, Date.now()]);
    const limiter = createRateLimiter(redis as unknown as RedisClientParam, {
      limit: 5,
      keyPrefix: "rl:test",
    });
    await limiter.check("x");
    expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls[0][5]).toBe("5");
    expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe("rl:test:x");
  });
});

// ── Rate Limit Tiers & Resolver ───────────────────────────────────────────────

describe("RATE_LIMIT_TIERS & tier resolver", () => {
  it("defines free tier with 100 req/day ($0/mo)", () => {
    const freeTier = RATE_LIMIT_TIERS.free;
    expect(freeTier.id).toBe("free");
    expect(freeTier.dailyLimit).toBe(100);
    expect(freeTier.monthlyPriceUsd).toBe(0);
    expect(freeTier.burstLimitPerMin).toBe(10);
  });

  it("defines paid tier 1 with 1,000 req/day ($10/mo)", () => {
    const tier1 = RATE_LIMIT_TIERS.tier1;
    expect(tier1.id).toBe("tier1");
    expect(tier1.dailyLimit).toBe(1000);
    expect(tier1.monthlyPriceUsd).toBe(10);
    expect(tier1.burstLimitPerMin).toBe(60);
  });

  it("defines paid tier 2 with 10,000 req/day ($50/mo)", () => {
    const tier2 = RATE_LIMIT_TIERS.tier2;
    expect(tier2.id).toBe("tier2");
    expect(tier2.dailyLimit).toBe(10000);
    expect(tier2.monthlyPriceUsd).toBe(50);
    expect(tier2.burstLimitPerMin).toBe(300);
  });

  it("resolves tier by id via getTierConfig", () => {
    expect(getTierConfig("free").dailyLimit).toBe(100);
    expect(getTierConfig("tier1").dailyLimit).toBe(1000);
    expect(getTierConfig("tier2").dailyLimit).toBe(10000);
    expect(getTierConfig("non_existent").id).toBe("free");
    expect(getTierConfig(null).id).toBe("free");
  });

  it("resolves tier from API key format via resolveTier", () => {
    expect(resolveTier(null).id).toBe("free");
    expect(resolveTier("").id).toBe("free");
    expect(resolveTier("pk_live_t1_secret123").id).toBe("tier1");
    expect(resolveTier("tier1_key_abc").id).toBe("tier1");
    expect(resolveTier("pk_live_t2_secret456").id).toBe("tier2");
    expect(resolveTier("tier2_key_xyz").id).toBe("tier2");
    expect(resolveTier("invalid_key").id).toBe("free");
  });
});

describe("Campaign API Rate Limiting by Campaign Size & Funding Tier (Issue #877)", () => {
  it("defines standard campaign API rate limit tiers", () => {
    expect(CAMPAIGN_API_RATE_LIMIT_TIERS.basic.hourlyLimit).toBe(100);
    expect(CAMPAIGN_API_RATE_LIMIT_TIERS.basic.windowMs).toBe(3_600_000);
    expect(CAMPAIGN_API_RATE_LIMIT_TIERS.pro.hourlyLimit).toBe(1000);
    expect(CAMPAIGN_API_RATE_LIMIT_TIERS.pro.windowMs).toBe(3_600_000);
    expect(CAMPAIGN_API_RATE_LIMIT_TIERS.enterprise.hourlyLimit).toBe(10000);
    expect(CAMPAIGN_API_RATE_LIMIT_TIERS.enterprise.windowMs).toBe(3_600_000);
  });

  it("resolves basic tier for campaigns with under $10,000 funding", () => {
    expect(resolveCampaignApiTierByFunding(0).id).toBe("basic");
    expect(resolveCampaignApiTierByFunding(500).id).toBe("basic");
    expect(resolveCampaignApiTierByFunding(9999).id).toBe("basic");
    expect(resolveCampaignApiTierByFunding(9999).hourlyLimit).toBe(100);
  });

  it("resolves pro tier for campaigns with $10,000 to $50,000 funding", () => {
    expect(resolveCampaignApiTierByFunding(10000).id).toBe("pro");
    expect(resolveCampaignApiTierByFunding(25000).id).toBe("pro");
    expect(resolveCampaignApiTierByFunding(49999).id).toBe("pro");
    expect(resolveCampaignApiTierByFunding(25000).hourlyLimit).toBe(1000);
  });

  it("resolves enterprise tier for campaigns with $50,000+ funding", () => {
    expect(resolveCampaignApiTierByFunding(50000).id).toBe("enterprise");
    expect(resolveCampaignApiTierByFunding(100000).id).toBe("enterprise");
    expect(resolveCampaignApiTierByFunding(500000).id).toBe("enterprise");
    expect(resolveCampaignApiTierByFunding(100000).hourlyLimit).toBe(10000);
  });

  it("resolves tier by explicit tier name or funding amount", () => {
    expect(resolveCampaignApiTier("basic").id).toBe("basic");
    expect(resolveCampaignApiTier("pro").id).toBe("pro");
    expect(resolveCampaignApiTier("enterprise").id).toBe("enterprise");
    expect(resolveCampaignApiTier(null, 75000).id).toBe("enterprise");
    expect(resolveCampaignApiTier(null, 15000).id).toBe("pro");
    expect(resolveCampaignApiTier(null, 2000).id).toBe("basic");
    expect(resolveCampaignApiTier(null, null).id).toBe("basic");
  });
});

