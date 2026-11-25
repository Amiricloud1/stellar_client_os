import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import {
  CanaryReleaseController,
  setCanaryReleaseController,
} from "@/lib/canary";

const KEY = "test-admin-key";
const AUTH = { authorization: `Bearer ${KEY}` };
const release = { release: "web-2026.11.25", previousRelease: "web-2026.11.18" };

function createController(options: {
  burnRate?: number;
  handler?: (context: { dryRun: boolean }) => Promise<void>;
  registerCheck?: boolean;
} = {}) {
  const controller = new CanaryReleaseController({
    metrics: {
      getMetrics: () => ({
        totalRequests: 100,
        burnRate: options.burnRate ?? 0.1,
        p95Ms: 10,
        availabilityRate: 1,
      }),
    },
    clock: () => 1_700_000_000_000,
    windowMs: 60_000,
    minSamplesPerJourney: 1,
    minObservationMs: 0,
    rollbackHandler: options.handler ?? vi.fn().mockResolvedValue(undefined),
  });
  if (options.registerCheck !== false) {
    controller.registerIntegrityCheck({
      name: "ledger-continuity",
      run: () => ({ status: "pass" }),
    });
  }
  return controller;
}

const get = (headers: Record<string, string> = AUTH) =>
  GET(new NextRequest("http://test/api/admin/canary", { headers }));

const post = (
  body: unknown,
  headers: Record<string, string> = AUTH,
) =>
  POST(
    new NextRequest("http://test/api/admin/canary", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.stubEnv("ADMIN_API_KEY", KEY);
  setCanaryReleaseController(createController());
});

afterEach(() => {
  vi.unstubAllEnvs();
  setCanaryReleaseController(null);
});

describe("GET /api/admin/canary", () => {
  it("requires the admin key and fails closed when it is unset", async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ authorization: "Bearer wrong" })).status).toBe(401);

    vi.stubEnv("ADMIN_API_KEY", "");
    expect((await get()).status).toBe(503);
  });

  it("returns the explicit idle state without caching", async () => {
    const response = await get();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body.data).toMatchObject({
      state: "idle",
      release: null,
      rollback: { status: "not_required" },
    });
    expect(body.data.nextActions.length).toBeGreaterThan(0);
  });
});

describe("POST /api/admin/canary", () => {
  it("rejects malformed bodies and unknown actions", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ action: "explode" })).status).toBe(400);
    expect((await post({ action: "start", release: "", previousRelease: "v1", actor: "op" })).status).toBe(400);
  });

  it("rejects starting without a matching rehearsal", async () => {
    const response = await post({ action: "start", ...release, actor: "operator" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("REHEARSAL_REQUIRED");
  });

  it("returns 409 when the rollback rehearsal fails", async () => {
    setCanaryReleaseController(createController({ registerCheck: false }));

    const response = await post({ action: "rehearse", ...release, actor: "operator" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe("ROLLBACK_REHEARSAL_FAILED");
    expect(body.data.passed).toBe(false);
  });

  it("rehearses, starts, evaluates, and advances through the gate", async () => {
    const rehearse = await post({ action: "rehearse", ...release, actor: "operator" });
    expect(rehearse.status).toBe(200);
    expect((await rehearse.json()).data.passed).toBe(true);

    const start = await post({ action: "start", ...release, actor: "operator" });
    expect(start.status).toBe(200);
    expect((await start.json()).data.state).toBe("canary");

    const evaluate = await post({ action: "evaluate" });
    expect(evaluate.status).toBe(200);
    expect((await evaluate.json()).data.evaluation.canPromote).toBe(true);

    const advance = await post({ action: "advance", actor: "operator" });
    expect(advance.status).toBe(200);
    expect((await advance.json()).data.stage).toMatchObject({
      name: "early",
      trafficPercent: 5,
    });
  });

  it("returns 502 and explicit recovery guidance when the rollback handler fails", async () => {
    setCanaryReleaseController(
      createController({
        handler: async ({ dryRun }) => {
          if (!dryRun) throw new Error("restore failed");
        },
      }),
    );
    await post({ action: "rehearse", ...release, actor: "operator" });
    await post({ action: "start", ...release, actor: "operator" });

    const response = await post({
      action: "rollback",
      actor: "operator",
      reason: "customer reports duplicate webhooks",
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe("ROLLBACK_HANDLER_FAILED");
    expect(body.data.rollback).toMatchObject({
      status: "failed",
      failure: "restore failed",
    });
    expect(body.data.nextActions[0]).toContain("Traffic is stopped");
  });

  it("auto-rolls back and reports the critical signals when metrics breach the gate", async () => {
    setCanaryReleaseController(createController({ burnRate: 20 }));
    await post({ action: "rehearse", ...release, actor: "operator" });
    await post({ action: "start", ...release, actor: "operator" });

    const response = await post({ action: "evaluate" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.evaluation.mustRollback).toBe(true);
    expect(body.data.status).toMatchObject({
      state: "rolled_back",
      rollback: { status: "completed" },
    });
    expect(body.data.evaluation.signals).toContainEqual(
      expect.objectContaining({
        code: "CRITICAL_JOURNEY_BURN_RATE",
        severity: "critical",
      }),
    );
  });
});
