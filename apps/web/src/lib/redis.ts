/**
 * Redis client singleton — issue #534
 *
 * Provides a shared ioredis client for rate limiting.
 * Returns null when Redis is unavailable so the app degrades
 * gracefully (allow-all) rather than hard-failing requests.
 *
 * Environment variables:
 * | Variable               | Default                  | Description                  |
 * |------------------------|--------------------------|------------------------------|
 * | REDIS_URL              | redis://localhost:6379   | Full Redis connection string  |
 * | REDIS_CONNECT_TIMEOUT  | 2000                     | Connect timeout (ms)         |
 * | REDIS_COMMAND_TIMEOUT  | 500                      | Per-command timeout (ms)     |
 *
 * Idempotency (issue #58) also uses this client. See `idempotency.ts` for the
 * store implementation and the `IDEMPOTENCY_*` environment variables.
 */

import Redis from "ioredis";

export type RedisClient = Redis;

/**
 * Atomic fixed-window counter script (issue #56).
 *
 * KEYS[1] = fully-qualified rate-limit key (route class + identity)
 * ARGV[1] = window length in milliseconds
 *
 * Returns { count, ttlMs } where ttlMs is the remaining window in ms.
 * INCR and PEXPIRE run atomically so a key can never be left without a TTL,
 * which would otherwise pin a counter forever and lock out an identity.
 */
export const RATE_LIMIT_LUA_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export interface RateLimitScriptResult {
  count: number;
  ttlMs: number;
}

/**
 * Atomic weighted-budget script (issue #234).
 *
 * KEYS[1] = fully-qualified budget key (tenant + window bucket)
 * ARGV[1] = window length in milliseconds
 * ARGV[2] = cost to deduct (integer >= 1)
 * ARGV[3] = budget limit for the window
 *
 * Returns { allowed, remaining, ttlMs } where:
 *   allowed   = 1 when the deduction fit within the limit, 0 otherwise
 *   remaining = budget left after the deduction (never negative)
 *   ttlMs     = remaining window in ms
 *
 * The whole read-modify-write runs atomically so concurrent requests from the
 * same tenant can never overspend the window. A rejected deduction does not
 * consume budget. The TTL is always (re)applied so a key can never be pinned
 * without expiry.
 */
export const BUDGET_LUA_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if current + cost > limit then
  return { 0, math.max(0, limit - current), ttl }
end
local next = redis.call('INCRBY', KEYS[1], cost)
return { 1, math.max(0, limit - next), ttl }
`;

export interface BudgetScriptResult {
  allowed: boolean;
  remaining: number;
  ttlMs: number;
}

/**
 * Compare-and-delete script for single-flight locks (issue #235).
 *
 * KEYS[1] = lock key
 * ARGV[1] = expected token
 *
 * Only deletes the lock when the stored token matches, so a slow holder can
 * never release a lock that has since been re-acquired by another caller.
 */
export const RELEASE_LOCK_LUA_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Minimal interface the rate limiter depends on. Tests inject a deterministic
 * in-memory implementation so they never touch a live Redis instance.
 */
export interface RateLimitStore {
  evalScript(
    key: string,
    windowMs: number
  ): Promise<RateLimitScriptResult | null>;
}

let _client: Redis | null = null;
let _attempted = false;

/**
 * Run the atomic INCR+PEXPIRE script against the shared client.
 * Returns null when Redis is unavailable so callers can fail open.
 */
export async function evalScript(
  key: string,
  windowMs: number
): Promise<RateLimitScriptResult | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const raw = (await client.eval(
      RATE_LIMIT_LUA_SCRIPT,
      1,
      key,
      String(Math.max(1, Math.floor(windowMs)))
    )) as [number | string, number | string];

    const count = Number(raw?.[0] ?? 0);
    const ttlMs = Number(raw?.[1] ?? windowMs);
    if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) return null;
    return { count, ttlMs: Math.max(0, ttlMs) };
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.error("[redis] evalScript failed:", (err as Error).message);
    }
    return null;
  }
}

/**
 * Atomically deduct `cost` from a per-tenant budget counter (issue #234).
 * Returns null when Redis is unavailable so callers can apply their documented
 * fail-open/fail-closed policy.
 */
export async function deductBudget(
  key: string,
  windowMs: number,
  cost: number,
  limit: number
): Promise<BudgetScriptResult | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const raw = (await client.eval(
      BUDGET_LUA_SCRIPT,
      1,
      key,
      String(Math.max(1, Math.floor(windowMs))),
      String(Math.max(1, Math.floor(cost))),
      String(Math.max(0, Math.floor(limit)))
    )) as [number | string, number | string, number | string];

    const allowed = Number(raw?.[0] ?? 0) === 1;
    const remaining = Number(raw?.[1] ?? 0);
    const ttlMs = Number(raw?.[2] ?? windowMs);
    if (!Number.isFinite(remaining) || !Number.isFinite(ttlMs)) return null;
    return { allowed, remaining: Math.max(0, remaining), ttlMs: Math.max(0, ttlMs) };
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.error("[redis] deductBudget failed:", (err as Error).message);
    }
    return null;
  }
}

/**
 * Try to acquire a single-flight lock (issue #235) using SET NX PX.
 * Returns the lock token on success, or null when the lock is already held or
 * Redis is unavailable. Callers must treat null as "someone else is working".
 */
export async function acquireSingleFlightLock(
  key: string,
  ttlMs: number
): Promise<string | null> {
  const client = getRedisClient();
  if (!client) return null;

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const res = await client.set(
      key,
      token,
      "PX",
      Math.max(1, Math.floor(ttlMs)),
      "NX"
    );
    return res === "OK" ? token : null;
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.error(
        "[redis] acquireSingleFlightLock failed:",
        (err as Error).message
      );
    }
    return null;
  }
}

/**
 * Release a single-flight lock only if we still own it (issue #235).
 * Returns true when the lock was deleted, false otherwise (including when
 * Redis is unavailable).
 */
export async function releaseSingleFlightLock(
  key: string,
  token: string
): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const deleted = (await client.eval(
      RELEASE_LOCK_LUA_SCRIPT,
      1,
      key,
      token
    )) as number | string;
    return Number(deleted) > 0;
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.error(
        "[redis] releaseSingleFlightLock failed:",
        (err as Error).message
      );
    }
    return false;
  }
}

export function getRedisClient(): Redis | null {
  if (_attempted) return _client;
  _attempted = true;

  // Deterministic test mode: never open a live connection during tests.
  if (process.env.NODE_ENV === "test" && !process.env.REDIS_URL) {
    return null;
  }

  const url =
    process.env.REDIS_URL ??
    (process.env.NODE_ENV === "production" ? null : "redis://localhost:6379");

  if (!url) {
    console.warn(
      "[redis] REDIS_URL not configured — rate limiting disabled (allow-all mode)"
    );
    return null;
  }

  try {
    _client = new Redis(url, {
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT ?? 2_000),
      commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT ?? 500),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    _client.on("error", (err: Error) => {
      if (process.env.NODE_ENV !== "test") {
        console.error("[redis] connection error:", err.message);
      }
    });

    return _client;
  } catch (err) {
    console.error("[redis] failed to create client:", (err as Error).message);
    return null;
  }
}

/** Disconnect and reset the singleton — used in tests. */
export async function closeRedisClient(): Promise<void> {
  if (_client) {
    await _client.quit().catch(() => {});
    _client = null;
  }
  _attempted = false;
}

/**
 * Returns the shared client only if it is currently usable (status "ready").
 * Used by the idempotency store, which must fail closed rather than silently
 * skipping reservation when Redis is down.
 */
export function getReadyRedisClient(): Redis | null {
  const client = getRedisClient();
  if (!client) return null;
  return client.status === "ready" ? client : null;
}
