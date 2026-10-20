// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  clampProbeTimeout,
  withBoundedTimeout,
  resolveSorobanRpcUrl,
  checkSorobanRpc,
  checkRedisHealth,
  checkStorageHealth,
  evaluateReadiness,
  DEFAULT_SOROBAN_RPC_MAINNET,
  DEFAULT_SOROBAN_RPC_TESTNET,
  MIN_PROBE_TIMEOUT_MS,
  MAX_PROBE_TIMEOUT_MS,
} from "./dependency-health";
import { GET as getLivez } from "@/app/api/livez/route";
import { GET as getReadyz } from "@/app/api/readyz/route";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("clampProbeTimeout & withBoundedTimeout", () => {
  it("clamps timeout values to [MIN_PROBE_TIMEOUT_MS, MAX_PROBE_TIMEOUT_MS]", () => {
    expect(clampProbeTimeout(10, 1_000)).toBe(MIN_PROBE_TIMEOUT_MS);
    expect(clampProbeTimeout(999_999, 1_000)).toBe(MAX_PROBE_TIMEOUT_MS);
    expect(clampProbeTimeout(undefined, 2_500)).toBe(2_500);
    expect(clampProbeTimeout(Number.NaN, 2_500)).toBe(2_500);
    expect(clampProbeTimeout(1_250, 2_500)).toBe(1_250);
  });

  it("rejects with TimeoutError when operation exceeds bounded timeout", async () => {
    await expect(
      withBoundedTimeout(
        () => new Promise((resolve) => setTimeout(() => resolve("late"), 500)),
        60,
        "Test dependency probe"
      )
    ).rejects.toThrow("Test dependency probe timed out after 60ms");
  });
});

describe("resolveSorobanRpcUrl & checkSorobanRpc", () => {
  it("resolves Soroban RPC URL from env or network default", () => {
    expect(resolveSorobanRpcUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SOROBAN_RPC_TESTNET);
    expect(
      resolveSorobanRpcUrl({ NEXT_PUBLIC_STELLAR_NETWORK: "mainnet" } as NodeJS.ProcessEnv)
    ).toBe(DEFAULT_SOROBAN_RPC_MAINNET);
    expect(
      resolveSorobanRpcUrl({
        NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.custom.stellar.org",
        NEXT_PUBLIC_STELLAR_NETWORK: "mainnet",
      } as NodeJS.ProcessEnv)
    ).toBe("https://rpc.custom.stellar.org");
  });

  it("returns reachable:true with ledger metadata on healthy getHealth response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          status: "healthy",
          latestLedger: 512_345,
          oldestLedger: 495_000,
          ledgerRetentionWindow: 17_280,
        },
      })
    );

    const res = await checkSorobanRpc("https://soroban-testnet.stellar.org", { fetchImpl });
    expect(res.reachable).toBe(true);
    expect(res.rpcStatus).toBe("healthy");
    expect(res.latestLedger).toBe(512_345);
    expect(res.error).toBeNull();
  });

  it("marks Soroban RPC unreachable on non-healthy RPC status or JSON-RPC error", async () => {
    const unhealthyFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "unhealthy" },
      })
    );
    const res1 = await checkSorobanRpc("https://soroban-testnet.stellar.org", {
      fetchImpl: unhealthyFetch,
    });
    expect(res1.reachable).toBe(false);
    expect(res1.error).toContain("non-healthy status: unhealthy");

    const rpcErrFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal RPC error" },
      })
    );
    const res2 = await checkSorobanRpc("https://soroban-testnet.stellar.org", {
      fetchImpl: rpcErrFetch,
    });
    expect(res2.reachable).toBe(false);
    expect(res2.error).toBe("Internal RPC error");
  });

  it("enforces bounded timeout when Soroban RPC hangs", async () => {
    const hangingFetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({})), 500))
    );
    const res = await checkSorobanRpc("https://soroban-testnet.stellar.org", {
      fetchImpl: hangingFetch,
      timeoutMs: 60,
    });
    expect(res.reachable).toBe(false);
    expect(res.error).toContain("timed out after 60ms");
  });
});

describe("checkRedisHealth", () => {
  it("returns status:ok when Redis is unconfigured and optional, or status:down when required", async () => {
    const optionalRes = await checkRedisHealth({
      redis: null,
      required: false,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(optionalRes.status).toBe("ok");
    expect(optionalRes.configured).toBe(false);

    const requiredRes = await checkRedisHealth({
      redis: null,
      required: true,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(requiredRes.status).toBe("down");
    expect(requiredRes.critical).toBe(true);
    expect(requiredRes.error).toContain("REDIS_REQUIRED=true");
  });

  it("returns status:ok on PONG, degraded on optional Redis failure, and down on required Redis timeout", async () => {
    const healthyRedis = { ping: vi.fn().mockResolvedValue("PONG") };
    const okRes = await checkRedisHealth({ redis: healthyRedis, required: false });
    expect(okRes.status).toBe("ok");
    expect(okRes.reachable).toBe(true);

    const failingRedis = { ping: vi.fn().mockRejectedValue(new Error("ECONNRESET")) };
    const degradedRes = await checkRedisHealth({ redis: failingRedis, required: false });
    expect(degradedRes.status).toBe("degraded");
    expect(degradedRes.reachable).toBe(false);

    const hangingRedis = {
      ping: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r("PONG"), 400))),
    };
    const timeoutRes = await checkRedisHealth({
      redis: hangingRedis,
      required: true,
      timeoutMs: 60,
    });
    expect(timeoutRes.status).toBe("down");
    expect(timeoutRes.error).toContain("timed out after 60ms");
  });
});

describe("checkStorageHealth", () => {
  const validS3Env = {
    AWS_REGION: "us-east-1",
    AWS_S3_BUCKET: "fundable-evidence-prod",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    S3_PRESIGN_EXPIRES_SECONDS: "300",
  } as unknown as NodeJS.ProcessEnv;

  it("validates S3 config and optional probe with bounded timeout", async () => {
    const okRes = await checkStorageHealth({
      env: validS3Env,
      probeFn: async () => {},
    });
    expect(okRes.status).toBe("ok");
    expect(okRes.reachable).toBe(true);
    expect(okRes.bucket).toBe("fundable-evidence-prod");

    const invalidEnv = { AWS_S3_BUCKET: "fundable-evidence-prod" } as unknown as NodeJS.ProcessEnv;
    const degradedRes = await checkStorageHealth({ env: invalidEnv, required: false });
    expect(degradedRes.status).toBe("degraded");
    expect(degradedRes.error).toContain("Invalid S3 configuration");

    const timeoutStorage = await checkStorageHealth({
      env: validS3Env,
      required: true,
      timeoutMs: 60,
      probeFn: () => new Promise((r) => setTimeout(r, 400)),
    });
    expect(timeoutStorage.status).toBe("down");
    expect(timeoutStorage.error).toContain("timed out after 60ms");
  });
});

describe("Separate Liveness and Readiness Probes & Orchestrator Responses (Issue #101)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/livez returns 200 OK with Cache-Control: no-store and no external calls", async () => {
    const res = await getLivez();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.probe).toBe("liveness");
    expect(body.checks).toEqual({ app: { status: "ok" } });
  });

  it("evaluateReadiness returns 200 ok when all critical dependencies are healthy", async () => {
    const envelope = await evaluateReadiness({
      env: {} as NodeJS.ProcessEnv,
      redis: { ping: vi.fn().mockResolvedValue("PONG") },
      horizonProbe: async (url) => ({
        reachable: true,
        url,
        latencyMs: 18,
        version: "2.34.0",
        error: null,
      }),
      sorobanProbe: async (url) => ({
        reachable: true,
        url,
        latencyMs: 22,
        latestLedger: 123_456,
        oldestLedger: 100_000,
        ledgerRetentionWindow: 17_280,
        rpcStatus: "healthy",
        error: null,
      }),
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.httpStatus).toBe(200);
    expect(envelope.checks.horizon.status).toBe("ok");
    expect(envelope.checks.sorobanRpc.status).toBe("ok");
    expect(envelope.checks.redis.status).toBe("ok");
  });

  it("evaluateReadiness reports degraded (200 default, 503 when strict=true) when optional Redis cache is down", async () => {
    const baseOpts = {
      env: {} as NodeJS.ProcessEnv,
      redis: { ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) },
      redisRequired: false,
      horizonProbe: async (url: string) => ({
        reachable: true,
        url,
        latencyMs: 15,
        version: "2.34.0",
        error: null,
      }),
      sorobanProbe: async (url: string) => ({
        reachable: true,
        url,
        latencyMs: 20,
        latestLedger: 123_456,
        oldestLedger: 100_000,
        ledgerRetentionWindow: 17_280,
        rpcStatus: "healthy",
        error: null,
      }),
    };

    const nonStrict = await evaluateReadiness({ ...baseOpts, strict: false });
    expect(nonStrict.status).toBe("degraded");
    expect(nonStrict.httpStatus).toBe(200);
    expect(nonStrict.checks.redis.status).toBe("degraded");

    const strict = await evaluateReadiness({ ...baseOpts, strict: true });
    expect(strict.status).toBe("degraded");
    expect(strict.httpStatus).toBe(503);
  });

  it("evaluateReadiness returns 503 unhealthy when Soroban RPC or Horizon is down", async () => {
    const envelope = await evaluateReadiness({
      env: {} as NodeJS.ProcessEnv,
      redis: null,
      horizonProbe: async (url) => ({
        reachable: true,
        url,
        latencyMs: 12,
        version: "2.34.0",
        error: null,
      }),
      sorobanProbe: async (url) => ({
        reachable: false,
        url,
        latencyMs: 3_000,
        latestLedger: null,
        oldestLedger: null,
        ledgerRetentionWindow: null,
        rpcStatus: null,
        error: "Soroban RPC probe timed out after 3000ms",
      }),
    });

    expect(envelope.status).toBe("unhealthy");
    expect(envelope.httpStatus).toBe(503);
    expect(envelope.checks.sorobanRpc.status).toBe("down");
  });

  it("GET /api/readyz returns orchestrator-compatible response with Cache-Control: no-store", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("horizon")) {
        return jsonResponse({ horizon_version: "2.34.0" });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { status: "healthy", latestLedger: 999 },
      });
    });

    const req = new NextRequest("http://localhost/api/readyz?timeoutMs=1000");
    const res = await getReadyz(req);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.probe).toBe("readiness");
    expect(body.checks.horizon.status).toBe("ok");
    expect(body.checks.sorobanRpc.status).toBe("ok");

    fetchSpy.mockRestore();
  });
});
