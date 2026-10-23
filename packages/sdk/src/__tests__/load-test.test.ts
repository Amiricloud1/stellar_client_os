import { describe, it, expect } from "vitest";
import {
  runLoadProfile,
  recoveryCheck,
  type LoadTarget,
  type LoadProfileSpec,
  type Thresholds,
} from "../load-test.js";

function makeTarget(opts: {
  ok: boolean;
  latencyMs: number;
  name?: string;
}): LoadTarget {
  return {
    name: opts.name ?? "mock",
    execute: async () => ({ ok: opts.ok, latencyMs: opts.latencyMs }),
  };
}

function flakyTarget(failRate: number, latencyMs = 5): LoadTarget {
  let calls = 0;
  return {
    name: "flaky",
    execute: async () => {
      calls += 1;
      const ok = calls % Math.ceil(1 / failRate) !== 0;
      return { ok, latencyMs };
    },
  };
}

const THRESHOLDS: Thresholds = {
  maxAvgLatencyMs: 100,
  maxP95LatencyMs: 200,
  maxErrorRate: 0.05,
};

function soak(concurrency = 4, durationMs = 80): LoadProfileSpec {
  return { type: "soak", concurrency, durationMs };
}

function burst(
  concurrency = 4,
  durationMs = 100,
  rampUpMs = 40
): LoadProfileSpec {
  return { type: "burst", concurrency, durationMs, rampUpMs };
}

// ── runLoadProfile: success ────────────────────────────────────────────────

describe("runLoadProfile (success)", () => {
  it("soak passes against a healthy fast target", async () => {
    const result = await runLoadProfile(
      makeTarget({ ok: true, latencyMs: 2 }),
      soak(),
      THRESHOLDS
    );
    expect(result.passed).toBe(true);
    expect(result.operations).toBeGreaterThan(0);
    expect(result.failures).toBe(0);
    expect(result.breaches).toEqual([]);
  });

  it("burst passes against a healthy fast target", async () => {
    const result = await runLoadProfile(
      makeTarget({ ok: true, latencyMs: 2 }),
      burst(),
      THRESHOLDS
    );
    expect(result.passed).toBe(true);
    expect(result.profile).toBe("burst");
    expect(result.failures).toBe(0);
  });

  it("reports latency and error metrics", async () => {
    const result = await runLoadProfile(
      makeTarget({ ok: true, latencyMs: 10 }),
      soak(),
      THRESHOLDS
    );
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.p95LatencyMs).toBeGreaterThanOrEqual(result.avgLatencyMs);
    expect(result.maxLatencyMs).toBeGreaterThanOrEqual(result.p95LatencyMs);
    expect(result.errorRate).toBe(0);
  });
});

// ── runLoadProfile: failure ────────────────────────────────────────────────

describe("runLoadProfile (failure)", () => {
  it("fails when the error rate exceeds the threshold", async () => {
    // 50% error rate, threshold 5%.
    const result = await runLoadProfile(
      flakyTarget(0.5, 2),
      soak(),
      THRESHOLDS
    );
    expect(result.passed).toBe(false);
    expect(result.errorRate).toBeGreaterThan(THRESHOLDS.maxErrorRate);
    expect(result.breaches.some((b) => b.includes("error rate"))).toBe(true);
  });

  it("fails when latency exceeds the threshold", async () => {
    const result = await runLoadProfile(
      makeTarget({ ok: true, latencyMs: 500 }),
      soak(),
      THRESHOLDS
    );
    expect(result.passed).toBe(false);
    expect(result.breaches.some((b) => b.includes("latency"))).toBe(true);
  });

  it("fails a burst with a high error rate", async () => {
    const result = await runLoadProfile(
      flakyTarget(0.5, 2),
      burst(),
      THRESHOLDS
    );
    expect(result.passed).toBe(false);
    expect(result.profile).toBe("burst");
    expect(result.failures).toBeGreaterThan(0);
  });
});

// ── boundary ───────────────────────────────────────────────────────────────

describe("boundary cases", () => {
  // Deterministic boundary targets: fail on a fixed cyclic schedule so the
  // failure ratio holds no matter how many cheap operations fit in the soak.
  // `every: 20` yields exactly a 5% failure rate (== maxErrorRate → passes);
  // `every: 9` yields ~11% (breaches maxErrorRate → fails).
  function cyclicTarget(every: number, latencyMs = 2): LoadTarget {
    let calls = 0;
    return {
      name: "boundary",
      execute: async () => {
        calls += 1;
        const ok = calls % every !== 0;
        await new Promise((r) => setTimeout(r, 0));
        return { ok, latencyMs };
      },
    };
  }

  it("passes when the error rate sits exactly on the bound", async () => {
    const result = await runLoadProfile(
      cyclicTarget(20, 2),
      { type: "soak", concurrency: 20, durationMs: 100 },
      THRESHOLDS
    );
    expect(result.operations).toBeGreaterThanOrEqual(20);
    // Exactly every 20th call fails → ratio is ~5% → never above the bound.
    expect(result.errorRate).toBeLessThanOrEqual(THRESHOLDS.maxErrorRate);
    expect(result.passed).toBe(true);
  });

  it("fails when the error rate sits above the bound", async () => {
    const result = await runLoadProfile(
      cyclicTarget(9, 2),
      { type: "soak", concurrency: 20, durationMs: 100 },
      THRESHOLDS
    );
    expect(result.operations).toBeGreaterThanOrEqual(20);
    expect(result.errorRate).toBeGreaterThan(THRESHOLDS.maxErrorRate);
    expect(result.passed).toBe(false);
  });
});

// ── recoveryCheck ──────────────────────────────────────────────────────────

describe("recoveryCheck", () => {
  it("returns true when the target recovers after failures", async () => {
    let calls = 0;
    const target: LoadTarget = {
      name: "recovering",
      execute: async () => {
        calls += 1;
        return { ok: calls > 3, latencyMs: 1 };
      },
    };
    expect(
      await recoveryCheck(target, { checks: 2, delayMs: 5, maxAttempts: 20 })
    ).toBe(true);
  });

  it("returns false when the target never recovers", async () => {
    const target: LoadTarget = {
      name: "broken",
      execute: async () => ({ ok: false, latencyMs: 1 }),
    };
    expect(
      await recoveryCheck(target, { checks: 2, delayMs: 5, maxAttempts: 5 })
    ).toBe(false);
  });
});
