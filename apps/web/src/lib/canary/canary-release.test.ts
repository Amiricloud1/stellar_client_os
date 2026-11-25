import { describe, expect, it, vi } from "vitest";
import {
  CANARY_STAGES,
  CanaryReleaseController,
  CanaryReleaseError,
  type CanaryReleaseOptions,
  type IntegrityCheckObservation,
  type JourneyMetricsProvider,
  type RollbackHandler,
} from "./canary-release";
import type { CriticalFlow } from "../slo/slo.types";

type FlowSample = {
  totalRequests?: number;
  burnRate?: number;
  p95Ms?: number;
  availabilityRate?: number;
};

function metricsProvider(
  samples: Partial<Record<CriticalFlow, FlowSample>> = {},
): JourneyMetricsProvider {
  return {
    getMetrics(flow) {
      const sample = samples[flow] ?? {};
      return {
        totalRequests: sample.totalRequests ?? 100,
        burnRate: sample.burnRate ?? 0.1,
        p95Ms: sample.p95Ms ?? 10,
        availabilityRate: sample.availabilityRate ?? 1,
      };
    },
  };
}

const release = { release: "web-2026.11.25", previousRelease: "web-2026.11.18" };

function createController(options: {
  samples?: Partial<Record<CriticalFlow, FlowSample>>;
  integrity?: () => IntegrityCheckObservation | Promise<IntegrityCheckObservation>;
  handler?: RollbackHandler;
  overrides?: Partial<CanaryReleaseOptions>;
} = {}) {
  let now = 1_700_000_000_000;
  const handler = options.handler ?? vi.fn().mockResolvedValue(undefined);
  const controller = new CanaryReleaseController({
    metrics: metricsProvider(options.samples),
    clock: () => now,
    windowMs: 60_000,
    minSamplesPerJourney: 10,
    minObservationMs: 0,
    maxIntegritySignalAgeMs: 60_000,
    integrityTimeoutMs: 1_000,
    rollbackHandler: handler,
    ...options.overrides,
  });
  controller.registerIntegrityCheck({
    name: "ledger-continuity",
    critical: true,
    run: options.integrity ?? (() => ({ status: "pass" })),
  });
  return {
    controller,
    handler,
    advanceClock: (ms: number) => {
      now += ms;
    },
  };
}

async function rehearseAndStart(controller: CanaryReleaseController) {
  const rehearsal = await controller.rehearseRollback({
    ...release,
    actor: "operator@example.test",
  });
  expect(rehearsal.passed).toBe(true);
  controller.start({ ...release, actor: "operator@example.test" });
}

describe("CanaryReleaseController", () => {
  it("requires a successful rehearsal for the exact release pair", () => {
    const { controller } = createController();

    expect(() =>
      controller.start({ ...release, actor: "operator@example.test" }),
    ).toThrowError(
      expect.objectContaining({ code: "REHEARSAL_REQUIRED" }),
    );
    expect(() =>
      controller.start({ ...release, actor: "operator@example.test" }),
    ).toThrow(CanaryReleaseError);
  });

  it("does not pass rehearsal without data-integrity signals", async () => {
    const controller = new CanaryReleaseController({
      metrics: metricsProvider(),
      clock: () => 1,
      minObservationMs: 0,
      rollbackHandler: vi.fn().mockResolvedValue(undefined),
    });

    const rehearsal = await controller.rehearseRollback({
      ...release,
      actor: "operator@example.test",
    });

    expect(rehearsal.passed).toBe(false);
    expect(
      rehearsal.checks.find((check) => check.name === "data-integrity-signals"),
    ).toMatchObject({ passed: false });
  });

  it("invalidates the rehearsal when the integrity-check set changes", async () => {
    const { controller } = createController();
    await controller.rehearseRollback({ ...release, actor: "operator@example.test" });

    controller.registerIntegrityCheck({
      name: "balance-reconciliation",
      run: () => ({ status: "pass" }),
    });

    expect(() =>
      controller.start({ ...release, actor: "operator@example.test" }),
    ).toThrowError(expect.objectContaining({ code: "REHEARSAL_REQUIRED" }));
  });

  it("promotes through every stage to stable when all signals are healthy", async () => {
    const { controller } = createController();
    await rehearseAndStart(controller);

    for (let index = 1; index < CANARY_STAGES.length; index += 1) {
      const status = await controller.advance("operator@example.test");
      expect(status.state).toBe("canary");
      expect(status.stage?.trafficPercent).toBe(CANARY_STAGES[index].trafficPercent);
    }

    const status = await controller.advance("operator@example.test");
    expect(status.state).toBe("stable");
    expect(status.stage?.trafficPercent).toBe(100);
    expect(status.nextActions[0]).toContain("Monitor");
  });

  it("holds promotion when a critical journey has too few samples", async () => {
    const { controller } = createController({
      samples: { submission: { totalRequests: 3 } },
    });
    await rehearseAndStart(controller);

    await expect(controller.advance("operator@example.test")).rejects.toMatchObject({
      code: "HEALTH_GATE_BLOCKED",
      details: {
        signals: expect.arrayContaining([
          expect.objectContaining({
            code: "CRITICAL_JOURNEY_NO_SIGNAL",
            severity: "blocking",
            flow: "submission",
          }),
        ]),
      },
    });
    expect(controller.getStatus().stage?.trafficPercent).toBe(1);
  });

  it("treats the promotion burn-rate boundary as blocking", async () => {
    const samples: Partial<Record<CriticalFlow, FlowSample>> = {
      reads: { burnRate: 2.0 },
    };
    const { controller } = createController({ samples });
    await rehearseAndStart(controller);

    await expect(controller.advance("operator@example.test")).rejects.toMatchObject({
      code: "HEALTH_GATE_BLOCKED",
    });

    samples.reads = { burnRate: 1.99 };
    await expect(controller.advance("operator@example.test")).resolves.toMatchObject({
      state: "canary",
    });
  });

  it("automatically rolls back on a critical burn rate and stops traffic", async () => {
    const { controller, handler } = createController({
      samples: { webhooks: { burnRate: 14.4 } },
    });
    await rehearseAndStart(controller);

    const evaluation = await controller.evaluate();
    const status = controller.getStatus();

    expect(evaluation.mustRollback).toBe(true);
    expect(status.state).toBe("rolled_back");
    expect(status.stage?.trafficPercent).toBe(0);
    expect(status.rollback.status).toBe("completed");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dryRun: false,
        release: release.release,
        previousRelease: release.previousRelease,
      }),
    );
  });

  it("rolls back on the p95 latency rollback threshold", async () => {
    // reads SLO p95 target is 250ms; rollback ratio defaults to 1.5 → 375ms.
    const { controller } = createController({
      samples: { reads: { p95Ms: 376 } },
    });
    await rehearseAndStart(controller);

    const evaluation = await controller.evaluate();

    expect(evaluation.mustRollback).toBe(true);
    expect(evaluation.signals).toContainEqual(
      expect.objectContaining({
        code: "CRITICAL_JOURNEY_LATENCY",
        severity: "critical",
        flow: "reads",
      }),
    );
    expect(controller.getStatus().state).toBe("rolled_back");
  });

  it("reports a failed rollback handler explicitly while keeping traffic stopped", async () => {
    const handler = vi
      .fn<RollbackHandler>()
      .mockImplementation(async ({ dryRun }) => {
        if (!dryRun) throw new Error("previous build restore failed");
      });
    const { controller } = createController({
      samples: { sync: { burnRate: 20 } },
      handler,
    });
    await rehearseAndStart(controller);

    await controller.evaluate();
    const status = controller.getStatus();

    expect(status.state).toBe("rolled_back");
    expect(status.rollback.status).toBe("failed");
    expect(status.rollback.failure).toContain("previous build restore failed");
    expect(status.nextActions[0]).toContain("Traffic is stopped");
  });

  it("enforces the observation window before promotion", async () => {
    const { controller, advanceClock } = createController({
      overrides: { minObservationMs: 60_000 },
    });
    await rehearseAndStart(controller);

    await expect(controller.advance("operator@example.test")).rejects.toMatchObject({
      code: "OBSERVATION_WINDOW_NOT_MET",
      details: { retryAfterMs: 60_000 },
    });

    advanceClock(60_000);
    await expect(controller.advance("operator@example.test")).resolves.toMatchObject({
      state: "canary",
      stage: { trafficPercent: 5 },
    });
  });

  it("holds promotion when a non-critical integrity check fails", async () => {
    const { controller } = createController();
    controller.registerIntegrityCheck({
      name: "optional-index-check",
      critical: false,
      run: () => ({ status: "fail", message: "replica lag" }),
    });
    await rehearseAndStart(controller);

    const evaluation = await controller.evaluate();

    expect(evaluation.mustRollback).toBe(false);
    expect(evaluation.canPromote).toBe(false);
    expect(controller.getStatus().state).toBe("canary");
    expect(evaluation.signals).toContainEqual(
      expect.objectContaining({
        code: "DATA_INTEGRITY_FAILED",
        severity: "blocking",
        check: "optional-index-check",
      }),
    );
  });

  it("automatically rolls back when a critical integrity check fails", async () => {
    const { controller } = createController({
      integrity: () => ({ status: "fail", message: "ledger gap detected" }),
    });
    await rehearseAndStart(controller);

    const evaluation = await controller.evaluate();

    expect(evaluation.mustRollback).toBe(true);
    expect(controller.getStatus().state).toBe("rolled_back");
    expect(controller.getStatus().rollback.status).toBe("completed");
    expect(evaluation.signals).toContainEqual(
      expect.objectContaining({
        code: "DATA_INTEGRITY_FAILED",
        severity: "critical",
        check: "ledger-continuity",
      }),
    );
  });

  it("blocks promotion on a stale integrity observation", async () => {
    const { controller } = createController({
      integrity: () => ({ status: "pass", observedAt: 0 }),
    });
    await rehearseAndStart(controller);

    const evaluation = await controller.evaluate();

    expect(evaluation.canPromote).toBe(false);
    expect(evaluation.integrity[0]).toMatchObject({ status: "stale" });
    expect(evaluation.signals).toContainEqual(
      expect.objectContaining({ code: "DATA_INTEGRITY_FAILED", check: "ledger-continuity" }),
    );
  });

  it("allows an operator to roll back a healthy canary", async () => {
    const { controller } = createController();
    await rehearseAndStart(controller);

    const status = await controller.rollback({
      actor: "operator@example.test",
      reason: "customer reports duplicate webhooks",
    });

    expect(status.state).toBe("rolled_back");
    expect(status.stage?.trafficPercent).toBe(0);
    expect(status.rollback.status).toBe("completed");
    expect(status.rollback.signals).toContainEqual(
      expect.objectContaining({ code: "MANUAL_ROLLBACK" }),
    );
  });

  it("rejects rollback when no release is active", async () => {
    const { controller } = createController();

    await expect(
      controller.rollback({ actor: "operator@example.test", reason: "nothing to do" }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
