/**
 * Rate-limiting middleware for Next.js App Router — issue #534
 *
 * Applies sliding-window rate limiting to public API submission endpoints.
 * Mount in `src/middleware.ts` (Next.js edge middleware) or call directly
 * from individual route handlers for fine-grained control.
 *
 * # Keying strategy (issue #56 — unified policy)
 * Rate-limit key = client IP address extracted with a trusted-proxy allowlist:
 *   1. Determine the peer (socket) address from the request.
 *   2. Only when the peer is listed in `TRUSTED_PROXIES` (comma-separated IPs)
 *      do we honour `X-Forwarded-For` (first hop) or `X-Real-IP`.
 *   3. Otherwise the peer address is used directly, so spoofed forwarding
 *      headers from untrusted clients cannot rotate the rate-limit key.
 *   4. "anonymous" fallback when no address can be determined.
 *
 * All route classes share one policy (see `@/lib/api-policy`); the route class
 * determines the limit/window and the standard `RateLimit-*` headers.
 *
 * # Configuration (environment variables)
 * | Variable                | Default | Description                              |
 * |-------------------------|---------|------------------------------------------|
 * | TRUSTED_PROXIES         | —       | Comma-separated proxy IPs allowed to set XFF |
 * | RATE_LIMIT_WINDOW_MS    | 60000   | Window duration in ms (global override)  |
 * | RATE_LIMIT_KEY_PREFIX   | rl      | Redis key prefix                         |
 * | RATE_LIMIT_SKIP_IPS     | —       | Comma-separated IPs to always allow      |
 *
 * @example Route-level usage:
 * ```ts
 * // apps/web/src/app/api/stream/route.ts
 * import { withRateLimit } from "@/middlewares/rate-limit.middleware";
 *
 * export const POST = withRateLimit(async (req) => {
 *   // ...handler
 * }, "stream");
 * ```
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedisClient } from "@/lib/redis";
import {
  RateLimiter,
  createRateLimiter,
  buildRateLimitHeaders,
  resolveCampaignApiTier,
  resolveRouteClassPolicy,
  type RateLimitOptions,
  type RouteSensitivityClass,
} from "@/lib/rate-limit";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  buildErrorResponse,
  logWithRequestId,
} from "@/lib/api/errors";

// ── IP extraction ─────────────────────────────────────────────────────────────

function getTrustedProxies(): Set<string> {
  const raw = process.env.TRUSTED_PROXIES ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function getPeerAddress(req: NextRequest): string | null {
  // NextRequest.ip is available in some deployment environments (socket peer).
  const ip = (req as unknown as { ip?: string }).ip;
  return ip ? ip.trim() : null;
}

export function extractIp(req: NextRequest): string {
  const peer = getPeerAddress(req);
  const trusted = getTrustedProxies();

  // Only honour forwarding headers when the immediate peer is a trusted proxy.
  if (peer && trusted.has(peer)) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0].trim();
      if (first) return first;
    }
    const xri = req.headers.get("x-real-ip");
    if (xri) {
      const trimmed = xri.trim();
      if (trimmed) return trimmed;
    }
  }

  if (peer) return peer;
  return "anonymous";
}

export function extractCampaignApiIdentity(req: Request): { identity: string; tier: ReturnType<typeof resolveCampaignApiTier> } {
  const apiKey = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const tierHeader = req.headers.get("x-campaign-tier");
  const fundingHeader = req.headers.get("x-campaign-funding");
  const fundingAmount = fundingHeader ? parseFloat(fundingHeader) : null;
  const tier = resolveCampaignApiTier(tierHeader ?? apiKey, fundingAmount);
  if (apiKey) return { identity: `${tier.id}:key:${apiKey.slice(-16)}`, tier };
  return { identity: `${tier.id}:ip:${extractIp(req as NextRequest)}`, tier };
}

// ── Skip list ─────────────────────────────────────────────────────────────────

function getSkipIps(): Set<string> {
  const raw = process.env.RATE_LIMIT_SKIP_IPS ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Check whether a request should be rate-limited.
 * Returns `null` if allowed, or a `NextResponse` (429 when rate-limited,
 * 503 when a fail-closed sensitive route rejects due to a Redis outage).
 */
export async function checkRateLimit(
  req: NextRequest,
  routeClass: RouteClass
): Promise<NextResponse | null> {
  const ip = extractIp(req);

  // Skip-list: internal/trusted IPs bypass rate limiting
  if (getSkipIps().has(ip)) return null;

  const result = await checkRouteLimit(routeClass, ip);
  const headers = buildRateLimitHeaders(result);

  if (!result.allowed) {
    const requestId = resolveRequestId(req);
    logWithRequestId(requestId, "warn", "rate_limit_exceeded", {
      ip,
      retryAfter: headers["Retry-After"],
    });
    return buildErrorResponse({
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests",
      status: 429,
      requestId,
      headers,
      details: { retryAfter: headers["Retry-After"] },
    });
  }

  return null;
}

// ── HOC wrapper ───────────────────────────────────────────────────────────────

type RouteHandler = (req: NextRequest) => Promise<NextResponse> | NextResponse;

/**
 * Higher-order function that wraps a Next.js App Router route handler
 * with unified sliding-window rate limiting for the given route class.
 *
 * @param handler    — the original route handler
 * @param routeClass — route class from `@/lib/api-policy` (defaults to "public")
 */
export function withRateLimit(
  handler: RouteHandler,
  routeClass: RouteClass = "public"
): RouteHandler {
  return async (req: NextRequest): Promise<NextResponse> => {
    const limited = await checkRateLimit(req, routeClass);
    if (limited) return limited;
    const response = await handler(req);
    // Propagate the correlation ID on successful responses as well.
    const requestId = resolveRequestId(req);
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  };
}

type CampaignRouteHandler = (req: Request, ...args: unknown[]) => Promise<Response> | Response;
export function withCampaignApiRateLimit(handler: CampaignRouteHandler): CampaignRouteHandler {
  const redis = getRedisClient();
  return async (req: Request, ...args: unknown[]): Promise<Response> => {
    const nextReq = req as NextRequest;
    const { identity, tier } = extractCampaignApiIdentity(req);
    if (getSkipIps().has(extractIp(nextReq))) return handler(req, ...args);
    const isMutation = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    const result = await new RateLimiter(redis, {
      limit: tier.hourlyLimit,
      windowMs: tier.windowMs,
      keyPrefix: "rl:campaign-api",
      routeClass: isMutation ? "standard-write" : "public-read",
    }).check(identity);
    const headers = buildRateLimitHeaders(result);
    if (!result.allowed) {
      const requestId = resolveRequestId(req);
      logWithRequestId(requestId, "warn", "rate_limit_exceeded", {
        identity,
        tier: tier.id,
        retryAfter: headers["Retry-After"],
      });
      return buildErrorResponse({
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests",
        status: 429,
        requestId,
        headers,
        details: { tier: tier.id, retryAfter: headers["Retry-After"] },
      });
    }
    const response = await handler(req, ...args);
    response.headers.set(REQUEST_ID_HEADER, resolveRequestId(req));
    return response;
  };
}

// ── Default limiters for public submission & sensitive endpoints ─────────────

let _streamLimiter: RateLimiter | null = null;
let _submitLimiter: RateLimiter | null = null;

/** 30 stream-creation requests per minute per IP (fallback-memory on Redis outage) */
export function getStreamLimiter(): RateLimiter {
  if (!_streamLimiter) {
    const policy = getRouteClassPolicy("stream");
    _streamLimiter = new RateLimiter(getRedisClient(), {
      limit: Number(process.env.RATE_LIMIT_STREAM_MAX ?? 30),
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
      keyPrefix: "rl:stream",
      routeClass: "standard-write",
    });
  }
  return _streamLimiter;
}

/** 10 payment-submission requests per minute per IP (fail-closed on Redis outage) */
export function getSubmitLimiter(): RateLimiter {
  if (!_submitLimiter) {
    const policy = getRouteClassPolicy("submit");
    _submitLimiter = new RateLimiter(getRedisClient(), {
      limit: Number(process.env.RATE_LIMIT_SUBMIT_MAX ?? 10),
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
      keyPrefix: "rl:submit",
      routeClass: "financial-submission",
    });
  }
  return _submitLimiter;
}

/** Create a rate limiter pre-configured for a specific route sensitivity class. */
export function createRouteClassLimiter(
  routeClass: RouteSensitivityClass,
  redis = getRedisClient(),
  overrides?: Partial<RateLimitOptions>
): RateLimiter {
  const policy = resolveRouteClassPolicy(routeClass);
  return new RateLimiter(redis, {
    limit: policy.defaultLimit,
    windowMs: policy.defaultWindowMs,
    keyPrefix: policy.keyPrefix,
    routeClass,
    failurePolicy: policy.failurePolicy,
    ...overrides,
  });
}

export function resetMiddlewareLimitersForTests(): void {
  _streamLimiter = null;
  _submitLimiter = null;
}

