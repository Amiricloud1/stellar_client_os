/**
 * Load-test harness for public APIs and indexing workloads — issue #107
 *
 * Provides repeatable burst and soak load profiles with latency, error-rate,
 * and resource thresholds plus recovery checks. The harness runs against an
 * isolated `LoadTarget` (a mock in tests, never live funds or production
 * infrastructure), so every run is deterministic and safe in CI.
 *
 * Companion operator guidance lives in docs/load-testing.md.
 */

export type LoadProfile = "burst" | "soak";

export interface BurstProfile {
  type: "burst";
  /** Target concurrency at the peak of the burst. */
  concurrency: number;
  /** Total duration of the burst in ms. */
  durationMs: number;
  /** Time over which concurrency ramps from 1 to `concurrency`. */
  rampUpMs: number;
}

export interface SoakProfile {
  type: "soak";
  /** Sustained concurrency. */
  concurrency: number;
  /** Total duration of the soak in ms. */
  durationMs: number;
}

export type LoadProfileSpec = BurstProfile | SoakProfile;

export interface Thresholds {
  /** Maximum allowed average latency (ms). */
  maxAvgLatencyMs: number;
  /** Maximum allowed p95 latency (ms). */
  maxP95LatencyMs: number;
  /** Maximum allowed error rate (0..1). */
  maxErrorRate: number;
  /** Maximum allowed peak memory (MB), optional. */
  maxMemoryMb?: number;
}

export interface LoadTarget {
  /** Human-readable name of the isolated target under test. */
  name: string;
  /** Execute one operation. Returns latency and whether it succeeded. */
  execute(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface LoadTestResult {
  profile: LoadProfile;
  target: string;
  operations: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  errorRate: number;
  peakMemoryMb: number;
  durationMs: number;
  /** True when all thresholds are satisfied. */
  passed: boolean;
  /** Human-readable list of any breached thresholds. */
  breaches: string[];
}

function nowMs(): number {
  return performance.now();
}

function memoryMb(): number {
  if (typeof process.memoryUsage === "function") {
    return process.memoryUsage().heapUsed / 1_048_576;
  }
  return 0;
}

function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Run a single load profile against an isolated target and evaluate thresholds.
 *
 * Deterministic when the target is a mock with fixed latency/failure behavior.
 * No network or live funds are involved.
 */
export async function runLoadProfile(
  target: LoadTarget,
  spec: LoadProfileSpec,
  thresholds: Thresholds
): Promise<LoadTestResult> {
  const start = nowMs();
  const latencies: number[] = [];
  let successes = 0;
  let failures = 0;
  let peakMemory = 0;

  const runBatch = async (concurrency: number): Promise<void> => {
    const batch: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      batch.push(
        (async () => {
          const t0 = nowMs();
          let ok = false;
          let measured = 0;
          try {
            const result = await target.execute();
            ok = result.ok;
            // Prefer the latency reported by the target (deterministic in
            // mocks), falling back to wall-clock measurement for real targets.
            measured = result.latencyMs ?? nowMs() - t0;
          } catch {
            measured = nowMs() - t0;
            ok = false;
          }
          latencies.push(measured);
          if (ok) successes += 1;
          else failures += 1;
        })()
      );
    }
    await Promise.all(batch);
    peakMemory = Math.max(peakMemory, memoryMb());
  };

  if (spec.type === "soak") {
    const deadline = start + spec.durationMs;
    while (nowMs() < deadline) {
      await runBatch(spec.concurrency);
    }
  } else {
    // burst: ramp concurrency 1 -> concurrency over rampUpMs, then hold.
    const burstStart = start;
    const burstDeadline = start + spec.durationMs;
    const rampEnd = start + spec.rampUpMs;
    while (nowMs() < burstDeadline) {
      let concurrency = spec.concurrency;
      if (nowMs() < rampEnd && spec.rampUpMs > 0) {
        const progress = (nowMs() - burstStart) / spec.rampUpMs;
        concurrency = Math.max(1, Math.floor(progress * spec.concurrency));
      }
      await runBatch(concurrency);
    }
  }

  const durationMs = nowMs() - start;
  const operations = successes + failures;
  const sorted = [...latencies].sort((a, b) => a - b);
  const avgLatencyMs = mean(latencies);
  const p95LatencyMs = p95(sorted);
  const maxLatencyMs = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const errorRate = operations > 0 ? failures / operations : 0;
  peakMemory = Math.max(peakMemory, memoryMb());

  const breaches: string[] = [];
  if (avgLatencyMs > thresholds.maxAvgLatencyMs) {
    breaches.push(
      `avg latency ${avgLatencyMs.toFixed(1)}ms > ${thresholds.maxAvgLatencyMs}ms`
    );
  }
  if (p95LatencyMs > thresholds.maxP95LatencyMs) {
    breaches.push(
      `p95 latency ${p95LatencyMs.toFixed(1)}ms > ${thresholds.maxP95LatencyMs}ms`
    );
  }
  if (errorRate > thresholds.maxErrorRate) {
    breaches.push(
      `error rate ${(errorRate * 100).toFixed(1)}% > ${(thresholds.maxErrorRate * 100).toFixed(1)}%`
    );
  }
  if (
    thresholds.maxMemoryMb !== undefined &&
    peakMemory > thresholds.maxMemoryMb
  ) {
    breaches.push(
      `peak memory ${peakMemory.toFixed(1)}MB > ${thresholds.maxMemoryMb}MB`
    );
  }

  return {
    profile: spec.type,
    target: target.name,
    operations,
    successes,
    failures,
    avgLatencyMs,
    p95LatencyMs,
    maxLatencyMs,
    errorRate,
    peakMemoryMb: peakMemory,
    durationMs,
    passed: breaches.length === 0,
    breaches,
  };
}

/**
 * Recovery check: after a load burst, repeatedly probe the target until it
 * responds successfully `checks` times in a row, or `maxAttempts` is reached.
 * Returns true when the target is observed to have recovered.
 */
export async function recoveryCheck(
  target: LoadTarget,
  options: {
    /** Number of consecutive successful probes required. Default 3. */
    checks?: number;
    /** Delay between probes in ms. Default 50. */
    delayMs?: number;
    /** Maximum number of probe attempts. Default 20. */
    maxAttempts?: number;
  } = {}
): Promise<boolean> {
  const checks = options.checks ?? 3;
  const delayMs = options.delayMs ?? 50;
  const maxAttempts = options.maxAttempts ?? 20;

  let consecutive = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let ok = false;
    try {
      const result = await target.execute();
      ok = result.ok;
    } catch {
      ok = false;
    }
    if (ok) {
      consecutive += 1;
      if (consecutive >= checks) return true;
    } else {
      consecutive = 0;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
