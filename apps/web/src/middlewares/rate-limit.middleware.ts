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
 * # Request budgets (issue #233)
 * Before any body parsing or handler work, `enforceRequestBudgets` validates
 * the request against size and collection budgets (body bytes, nested list
 * depth/length, filter count). Violations short-circuit with:
 *   - `413 PAYLOAD_TOO_LARGE` — body or collection exceeds a hard byte limit.
 *   - `422 UNPROCESSABLE_ENTITY` — structurally valid but over budget
 *     (e.g. too many filters, list nesting too deep).
 * Both responses include `X-Request-Budget` describing the violated budget.
 *
 * # Operation-cost metering (issue #234)
 * After the tenant/principal is resolved, `meterOperation` charges the route's
 * weighted operation cost against the tenant's budget. Exports and analytics
 * are weighted more heavily than lightweight reads. On exhaustion the request
 * is rejected with `429 RATE_LIMIT_EXCEEDED` and:
 *   - `Retry-After` — seconds until the budget window resets.
 *   - `RateLimit-*` — remaining/limit/reset budget headers.
 *
 * # Conditional reads (issue #232)
 * Cacheable GET routes emit a representation validator derived from the
 * representation and the authorization context:
 *   - `ETag` — strong validator scoped to the principal (prevents cross-
 *     principal cache leakage).
 *   - `Cache-Control: private` — never shared-cacheable.
 *   - `Vary: Authorization` — caches key on the caller's credentials.
 * When the request carries a matching `If-None-Match`, the handler responds
 * `304 Not Modified` with the same validator headers and no body.
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
import {
  enforceRequestBudgets,
  meterOperation,
  resolveOperationCost,
  buildConditionalReadHeaders,
  matchesIfNoneMatch,
  type OperationKind,
} from "@/lib/api/request-policy";

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

// ── Request budgets (issue #233) ──────────────────────────────────────────────

/**
 * Enforce request size and collection budgets before any expensive work.
 * Returns `null` when within budget, or a `413`/`422` response otherwise.
 */
export async function checkRequestBudgets(
  req: NextRequest
): Promise<NextResponse | null> {
  const violation = await enforceRequestBudgets(req);
  if (!violation) return null;

  const requestId = resolveRequestId(req);
  logWithRequestId(requestId, "warn", "request_budget_exceeded", {
    budget: violation.budget,
    limit: violation.limit,
    actual: violation.actual,
  });

  return buildErrorResponse({
    code: violation.code,
    message: violation.message,
    status: violation.status,
    requestId,
    headers: { "X-Request-Budget": violation.budget },
    details: {
      budget: violation.budget,
      limit: violation.limit,
      actual: violation.actual,
    },
  });
}

// ── Operation metering (issue #234) ───────────────────────────────────────────

/**
 * Charge the route's weighted operation cost against the tenant budget.
 * Returns `null` when within budget, or a `429` response with `Retry-After`
 * and remaining-budget headers on exhaustion.
 */
export async function checkOperationBudget(
  req: NextRequest,
  operation: OperationKind,
  identity?: string
): Promise<NextResponse | null> {
  const principal = identity ?? extractCampaignApiIdentity(req).identity;
  const cost = resolveOperationCost(operation);
  const result = await meterOperation(principal, operation, cost);
  if (result.allowed) return null;

  const requestId = resolveRequestId(req);
  const headers = {
    ...buildRateLimitHeaders(result),
    "X-Operation-Cost": String(cost),
  };
  logWithRequestId(requestId, "warn", "operation_budget_exceeded", {
    principal,
    operation,
    cost,
    retryAfter: headers["Retry-After"],
  });

  return buildErrorResponse({
    code: "RATE_LIMIT_EXCEEDED",
    message: "Operation budget exhausted",
    status: 429,
    requestId,
    headers,
    details: {
      operation,
      cost,
      retryAfter: headers["Retry-After"],
      remaining: result.remaining,
    },
  });
}

// ── Conditional reads (issue #232) ────────────────────────────────────────────

/**
 * Attach principal-scoped validator headers to a cacheable GET response and
 * honour `If-None-Match` with a `304 Not Modified`.
 */
export function applyConditionalRead(
  req: NextRequest,
  response: NextResponse,
  principal: string
): NextResponse {
  const headers = buildConditionalReadHeaders(response, principal);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  const etag = headers["ETag"];
  if (etag && matchesIfNoneMatch(req.headers.get("if-none-match"), etag)) {
    const notModified = new NextResponse(null, { status: 304 });
    for (const [key, value] of Object.entries(headers)) {
      notModified.headers.set(key, value);
    }
    notModified.headers.set(REQUEST_ID_HEADER, resolveRequestId(req));
    return notModified;
  }

  return response;
}

// ── HOC wrapper ───────────────────────────────────────────────────────────────

type RouteHandler = (req: NextRequest) => Promise<NextResponse> | NextResponse;

export interface WithRateLimitOptions {
  /** Weighted operation kind used for tenant metering (issue #234). */
  operation?: OperationKind;
  /** Emit principal-scoped conditional-read headers for GET responses (issue #232). */
  conditionalRead?: boolean;
}

/**
 * Higher-order function that wraps a Next.js App Router route handler
 * with unified sliding-window rate limiting for the given route class.
 *
 * Order of enforcement:
 *   1. Request budgets (413/422) — before any body parsing.
 *   2. Sliding-window rate limit (429) — existing route-class behavior.
 *   3. Operation-cost metering (429) — weighted tenant budget.
 *   4. Handler invocation, then conditional-read headers for GET routes.
 *
 * @param handler    — the original route handler
 * @param routeClass — route class from `@/lib/api-policy` (defaults to "public")
 * @param options    — operation metering and conditional-read configuration
 */
export function withRateLimit(
  handler: RouteHandler,
  routeClass: RouteClass = "public",
  options: WithRateLimitOptions = {}
): RouteHandler {
  return async (req: NextRequest): Promise<NextResponse> => {
    // 1. Request budgets — reject oversized bodies/collections before parsing.
    const overBudget = await checkRequestBudgets(req);
    if (overBudget) return overBudget;

    // 2. Sliding-window rate limit (existing route-class behavior).
    const limited = await checkRateLimit(req, routeClass);
    if (limited) return limited;

    // 3. Weighted operation metering against the tenant budget.
    if (options.operation) {
      const exhausted = await checkOperationBudget(req, options.operation);
      if (exhausted) return exhausted;
    }

    // 4. Invoke the handler.
    const response = await handler(req);
    // Propagate the correlation ID on successful responses as well.
    const requestId = resolveRequestId(req);
    response.headers.set(REQUEST_ID_HEADER, requestId);

    // 5. Conditional-read validators for cacheable GET routes.
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (options.conditionalRead && isRead) {
      const principal = extractCampaignApiIdentity(req).identity;
      return applyConditionalRead(req, response, principal);
    }

    return response;
  };
}

type CampaignRouteHandler = (req: Request, ...args: unknown[]) => Promise<Response> | Response;
export function withCampaignApiRateLimit(handler: CampaignRouteHandler): CampaignRouteHandler {
  const redis = getRedisClient();
  return async (req: Request, ...args: unknown[]): Promise<Response> => {
    const nextReq = req as NextRequest;

    // Request budgets — reject oversized bodies/collections before parsing.
    const overBudget = await checkRequestBudgets(nextReq);
    if (overBudget) return overBudget;

    const { identity, tier } = extractCampaignApiIdentity(req);
    if (getSkipIps().has(extractIp(nextReq))) return handler(req, ...args);
    const isMutation = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";

    // Weighted operation metering — exports/analytics cost more than reads.
    const operation: OperationKind = isMutation ? "write" : "read";
    const exhausted = await checkOperationBudget(nextReq, operation, identity);
    if (exhausted) return exhausted;

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

    // Conditional-read validators for cacheable GET responses.
    if (!isMutation) {
      const nextResponse = response as NextResponse;
      return applyConditionalRead(nextReq, nextResponse, identity);
    }

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