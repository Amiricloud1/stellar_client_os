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
 * In-memory RateLimitStore for tests. Deterministic: the caller supplies the
 * clock so window rollover and 429 reset timing can be asserted exactly.
 */
export function createInMemoryRateLimitStore(
  now: () => number = () => Date.now()
): RateLimitStore & { reset(): void } {
  const buckets = new Map<string, { count: number; expiresAt: number }>();

  return {
    async evalScript(key, windowMs) {
      const t = now();
      const existing = buckets.get(key);
      if (!existing || existing.expiresAt <= t) {
        const expiresAt = t + Math.max(1, Math.floor(windowMs));
        buckets.set(key, { count: 1, expiresAt });
        return { count: 1, ttlMs: expiresAt - t };
      }
      existing.count += 1;
      return { count: existing.count, ttlMs: existing.expiresAt - t };
    },
    reset() {
      buckets.clear();
    },
  };
}
