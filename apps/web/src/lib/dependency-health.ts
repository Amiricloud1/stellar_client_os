/**
 * Liveness and readiness dependency health checks — issue #101
 *
 * Separates process liveness from dependency readiness and probes critical
 * infrastructure dependencies (Stellar Horizon, Soroban RPC, Redis cache, and
 * S3 object storage) with strict bounded timeouts and orchestrator-compatible
 * status responses (`ok`, `degraded`, `unhealthy`).
 */

import {
  checkHorizon,
  resolveHorizonUrl,
  DEFAULT_HORIZON_TIMEOUT_MS,
  type HorizonHealthResult,
} from "./horizon-health";
import { s3ConfigSchema } from "./s3/config";
import { getRedisClient, type RedisClient } from "./redis";

export const DEFAULT_SOROBAN_RPC_MAINNET = "https://mainnet.sorobanrpc.com";
export const DEFAULT_SOROBAN_RPC_TESTNET = "https://soroban-testnet.stellar.org";

export const DEFAULT_SOROBAN_TIMEOUT_MS = 3_000;
export const DEFAULT_REDIS_TIMEOUT_MS = 1_500;
export const DEFAULT_STORAGE_TIMEOUT_MS = 2_000;
export const MIN_PROBE_TIMEOUT_MS = 50;
export const MAX_PROBE_TIMEOUT_MS = 15_000;

export type DependencyComponentStatus = "ok" | "degraded" | "down";
export type AggregateHealthStatus = "ok" | "degraded" | "unhealthy";

export interface DependencyCheckSummary {
  status: DependencyComponentStatus;
  critical?: boolean;
  configured?: boolean;
  reachable?: boolean;
  latencyMs?: number | null;
  error?: string | null;
  [key: string]: unknown;
}

export interface SorobanRpcHealthResult {
  reachable: boolean;
  url: string;
  latencyMs: number | null;
  latestLedger: number | null;
  oldestLedger: number | null;
  ledgerRetentionWindow: number | null;
  rpcStatus: string | null;
  error: string | null;
}

export interface RedisHealthResult {
  configured: boolean;
  reachable: boolean;
  critical: boolean;
  status: DependencyComponentStatus;
  latencyMs: number | null;
  error: string | null;
}

export interface StorageHealthResult {
  configured: boolean;
  reachable: boolean;
  critical: boolean;
  status: DependencyComponentStatus;
  region: string | null;
  bucket: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface HealthProbeEnvelope {
  status: AggregateHealthStatus;
  probe: "liveness" | "readiness";
  httpStatus: 200 | 503;
  checks: Record<string, DependencyCheckSummary>;
  timestamp: string;
}

/**
 * Clamp a caller-supplied or environment timeout to a safe bounded range.
 */
export function clampProbeTimeout(
  timeoutMs: number | undefined,
  fallbackMs: number
): number {
  if (timeoutMs === undefined || Number.isNaN(timeoutMs) || !Number.isFinite(timeoutMs)) {
    return fallbackMs;
  }
  return Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, Math.floor(timeoutMs)));
}

/**
 * Execute an async operation with a hard upper timeout bound so hung sockets
 * never stall orchestrator health probes.
 */
export async function withBoundedTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  timeoutLabel: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Resolve the Soroban RPC URL from environment variables.
 */
export function resolveSorobanRpcUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEXT_PUBLIC_SOROBAN_RPC_URL) {
    return env.NEXT_PUBLIC_SOROBAN_RPC_URL;
  }
  return env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
    ? DEFAULT_SOROBAN_RPC_MAINNET
    : DEFAULT_SOROBAN_RPC_TESTNET;
}

/**
 * Probe Soroban RPC via JSON-RPC `getHealth` with a bounded timeout.
 */
export async function checkSorobanRpc(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<SorobanRpcHealthResult> {
  const timeoutMs = clampProbeTimeout(options.timeoutMs, DEFAULT_SOROBAN_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = Date.now();

  try {
    const res = await withBoundedTimeout(
      () =>
        fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getHealth",
          }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        }),
      timeoutMs,
      "Soroban RPC probe"
    );

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      return {
        reachable: false,
        url,
        latencyMs,
        latestLedger: null,
        oldestLedger: null,
        ledgerRetentionWindow: null,
        rpcStatus: null,
        error: `Soroban RPC responded with HTTP ${res.status}`,
      };
    }

    const payload = (await res.json()) as {
      result?: {
        status?: string;
        latestLedger?: number;
        oldestLedger?: number;
        ledgerRetentionWindow?: number;
      };
      error?: { message?: string; code?: number };
    };

    if (payload.error) {
      return {
        reachable: false,
        url,
        latencyMs,
        latestLedger: null,
        oldestLedger: null,
        ledgerRetentionWindow: null,
        rpcStatus: "error",
        error: payload.error.message ?? "Soroban RPC returned JSON-RPC error",
      };
    }

    const rpcStatus = payload.result?.status ?? null;
    const isHealthy = rpcStatus === "healthy";

    return {
      reachable: isHealthy,
      url,
      latencyMs,
      latestLedger:
        typeof payload.result?.latestLedger === "number"
          ? payload.result.latestLedger
          : null,
      oldestLedger:
        typeof payload.result?.oldestLedger === "number"
          ? payload.result.oldestLedger
          : null,
      ledgerRetentionWindow:
        typeof payload.result?.ledgerRetentionWindow === "number"
          ? payload.result.ledgerRetentionWindow
          : null,
      rpcStatus,
      error: isHealthy
        ? null
        : `Soroban RPC reported non-healthy status: ${rpcStatus ?? "unknown"}`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? `Soroban RPC probe timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      reachable: false,
      url,
      latencyMs,
      latestLedger: null,
      oldestLedger: null,
      ledgerRetentionWindow: null,
      rpcStatus: null,
      error: message,
    };
  }
}

/**
 * Probe Redis cache connectivity via `PING` with a bounded timeout.
 */
export async function checkRedisHealth(
  options: {
    redis?: Pick<RedisClient, "ping"> | null;
    timeoutMs?: number;
    required?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<RedisHealthResult> {
  const env = options.env ?? process.env;
  const timeoutMs = clampProbeTimeout(options.timeoutMs, DEFAULT_REDIS_TIMEOUT_MS);
  const critical = options.required ?? env.REDIS_REQUIRED === "true";
  const client = options.redis !== undefined ? options.redis : getRedisClient();

  if (!client) {
    if (critical) {
      return {
        configured: false,
        reachable: false,
        critical: true,
        status: "down",
        latencyMs: null,
        error: "Redis is required (REDIS_REQUIRED=true) but REDIS_URL is not configured",
      };
    }
    return {
      configured: false,
      reachable: false,
      critical: false,
      status: "ok",
      latencyMs: null,
      error: null,
    };
  }

  const startedAt = Date.now();
  try {
    const pong = await withBoundedTimeout(
      () => client.ping(),
      timeoutMs,
      "Redis probe"
    );
    const latencyMs = Date.now() - startedAt;
    const ok = pong === "PONG" || Boolean(pong);

    if (!ok) {
      return {
        configured: true,
        reachable: false,
        critical,
        status: critical ? "down" : "degraded",
        latencyMs,
        error: `Unexpected Redis PING response: ${String(pong)}`,
      };
    }

    return {
      configured: true,
      reachable: true,
      critical,
      status: "ok",
      latencyMs,
      error: null,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? `Redis probe timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      configured: true,
      reachable: false,
      critical,
      status: critical ? "down" : "degraded",
      latencyMs,
      error: message,
    };
  }
}

/**
 * Probe S3 evidence storage configuration and optional endpoint reachability
 * with a bounded timeout.
 */
export async function checkStorageHealth(
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    required?: boolean;
    probeFn?: (config: { region: string; bucket: string }) => Promise<void>;
  } = {}
): Promise<StorageHealthResult> {
  const env = options.env ?? process.env;
  const timeoutMs = clampProbeTimeout(options.timeoutMs, DEFAULT_STORAGE_TIMEOUT_MS);
  const critical = options.required ?? env.STORAGE_REQUIRED === "true";

  const hasAnyS3Var = Boolean(
    env.AWS_REGION || env.AWS_S3_BUCKET || env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY
  );

  if (!hasAnyS3Var) {
    if (critical) {
      return {
        configured: false,
        reachable: false,
        critical: true,
        status: "down",
        region: null,
        bucket: null,
        latencyMs: null,
        error: "Storage is required (STORAGE_REQUIRED=true) but S3 credentials are not configured",
      };
    }
    return {
      configured: false,
      reachable: false,
      critical: false,
      status: "ok",
      region: null,
      bucket: null,
      latencyMs: null,
      error: null,
    };
  }

  const startedAt = Date.now();
  const parsed = s3ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const latencyMs = Date.now() - startedAt;
    const message = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      configured: true,
      reachable: false,
      critical,
      status: critical ? "down" : "degraded",
      region: env.AWS_REGION ?? null,
      bucket: env.AWS_S3_BUCKET ?? null,
      latencyMs,
      error: `Invalid S3 configuration: ${message}`,
    };
  }

  if (options.probeFn) {
    try {
      await withBoundedTimeout(
        () =>
          options.probeFn!({
            region: parsed.data.AWS_REGION,
            bucket: parsed.data.AWS_S3_BUCKET,
          }),
        timeoutMs,
        "Storage probe"
      );
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message =
        error instanceof Error && error.name === "TimeoutError"
          ? `Storage probe timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        configured: true,
        reachable: false,
        critical,
        status: critical ? "down" : "degraded",
        region: parsed.data.AWS_REGION,
        bucket: parsed.data.AWS_S3_BUCKET,
        latencyMs,
        error: message,
      };
    }
  }

  return {
    configured: true,
    reachable: true,
    critical,
    status: "ok",
    region: parsed.data.AWS_REGION,
    bucket: parsed.data.AWS_S3_BUCKET,
    latencyMs: Date.now() - startedAt,
    error: null,
  };
}

/**
 * Evaluate process liveness. Never performs external I/O so orchestrators
 * (Kubernetes `livenessProbe`, ECS healthcheck) never restart healthy containers
 * during downstream dependency outages.
 */
export function evaluateLiveness(): HealthProbeEnvelope {
  return {
    status: "ok",
    probe: "liveness",
    httpStatus: 200,
    checks: {
      app: { status: "ok" },
    },
    timestamp: new Date().toISOString(),
  };
}

export interface ReadinessEvaluationOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** When true, `degraded` non-critical dependencies also return HTTP 503. */
  strict?: boolean;
  fetchImpl?: typeof fetch;
  redis?: Pick<RedisClient, "ping"> | null;
  redisRequired?: boolean;
  storageRequired?: boolean;
  storageProbeFn?: (config: { region: string; bucket: string }) => Promise<void>;
  horizonProbe?: (url: string, opts?: { timeoutMs?: number }) => Promise<HorizonHealthResult>;
  sorobanProbe?: (url: string, opts?: { timeoutMs?: number }) => Promise<SorobanRpcHealthResult>;
}

/**
 * Evaluate full service readiness across Horizon, Soroban RPC, Redis cache,
 * and S3 storage with bounded timeouts.
 */
export async function evaluateReadiness(
  options: ReadinessEvaluationOptions = {}
): Promise<HealthProbeEnvelope> {
  const env = options.env ?? process.env;
  const horizonUrl = resolveHorizonUrl(env);
  const sorobanUrl = resolveSorobanRpcUrl(env);

  const horizonTimeout = clampProbeTimeout(options.timeoutMs, DEFAULT_HORIZON_TIMEOUT_MS);
  const sorobanTimeout = clampProbeTimeout(options.timeoutMs, DEFAULT_SOROBAN_TIMEOUT_MS);
  const redisTimeout = clampProbeTimeout(options.timeoutMs, DEFAULT_REDIS_TIMEOUT_MS);
  const storageTimeout = clampProbeTimeout(options.timeoutMs, DEFAULT_STORAGE_TIMEOUT_MS);

  const runHorizon = options.horizonProbe ?? ((u, o) => checkHorizon(u, { ...o, fetchImpl: options.fetchImpl }));
  const runSoroban = options.sorobanProbe ?? ((u, o) => checkSorobanRpc(u, { ...o, fetchImpl: options.fetchImpl }));

  const [horizon, sorobanRpc, redis, storage] = await Promise.all([
    runHorizon(horizonUrl, { timeoutMs: horizonTimeout }),
    runSoroban(sorobanUrl, { timeoutMs: sorobanTimeout }),
    checkRedisHealth({
      redis: options.redis,
      timeoutMs: redisTimeout,
      required: options.redisRequired,
      env,
    }),
    checkStorageHealth({
      env,
      timeoutMs: storageTimeout,
      required: options.storageRequired,
      probeFn: options.storageProbeFn,
    }),
  ]);

  const horizonCheck: DependencyCheckSummary = {
    status: horizon.reachable ? "ok" : "down",
    critical: true,
    reachable: horizon.reachable,
    url: horizon.url,
    ...(horizon.latencyMs !== null ? { latencyMs: horizon.latencyMs } : {}),
    ...(horizon.version !== null ? { version: horizon.version } : {}),
    ...(horizon.error !== null ? { error: horizon.error } : {}),
  };

  const sorobanCheck: DependencyCheckSummary = {
    status: sorobanRpc.reachable ? "ok" : "down",
    critical: true,
    reachable: sorobanRpc.reachable,
    url: sorobanRpc.url,
    ...(sorobanRpc.latencyMs !== null ? { latencyMs: sorobanRpc.latencyMs } : {}),
    ...(sorobanRpc.latestLedger !== null ? { latestLedger: sorobanRpc.latestLedger } : {}),
    ...(sorobanRpc.rpcStatus !== null ? { rpcStatus: sorobanRpc.rpcStatus } : {}),
    ...(sorobanRpc.error !== null ? { error: sorobanRpc.error } : {}),
  };

  const redisCheck: DependencyCheckSummary = {
    status: redis.status,
    critical: redis.critical,
    configured: redis.configured,
    reachable: redis.reachable,
    ...(redis.latencyMs !== null ? { latencyMs: redis.latencyMs } : {}),
    ...(redis.error !== null ? { error: redis.error } : {}),
  };

  const storageCheck: DependencyCheckSummary = {
    status: storage.status,
    critical: storage.critical,
    configured: storage.configured,
    reachable: storage.reachable,
    ...(storage.region !== null ? { region: storage.region } : {}),
    ...(storage.bucket !== null ? { bucket: storage.bucket } : {}),
    ...(storage.latencyMs !== null ? { latencyMs: storage.latencyMs } : {}),
    ...(storage.error !== null ? { error: storage.error } : {}),
  };

  const checks: Record<string, DependencyCheckSummary> = {
    app: { status: "ok" },
    horizon: horizonCheck,
    sorobanRpc: sorobanCheck,
    redis: redisCheck,
    storage: storageCheck,
  };

  const statuses = [horizonCheck.status, sorobanCheck.status, redisCheck.status, storageCheck.status];
  let status: AggregateHealthStatus = "ok";
  if (statuses.includes("down")) {
    status = "unhealthy";
  } else if (statuses.includes("degraded")) {
    status = "degraded";
  }

  const httpStatus: 200 | 503 =
    status === "unhealthy" || (status === "degraded" && options.strict)
      ? 503
      : 200;

  return {
    status,
    probe: "readiness",
    httpStatus,
    checks,
    timestamp: new Date().toISOString(),
  };
}
