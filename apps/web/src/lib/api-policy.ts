/**
 * Shared API authentication policy module (issue #54).
 *
 * This module is the single source of truth for classifying every API route as
 * one of three policy levels and for enforcing those policies at request time.
 *
 * ── Route classification ────────────────────────────────────────────────────
 *
 *  'public'
 *      No session or role is required. These routes are safe to call
 *      anonymously and must never expose privileged data or mutate state in a
 *      way that requires an identity. Examples: health checks, public
 *      configuration, read-only catalog data.
 *
 *  'authenticated'
 *      A valid session (authenticated user) is required, but no specific role
 *      is needed. These routes act on behalf of the caller and must scope all
 *      data access to that caller. Examples: the current user's profile,
 *      their own orders, their own notifications.
 *
 *  'privileged'
 *      A valid session AND an elevated role (e.g. 'admin') is required. These
 *      routes can read or mutate data across users or perform administrative
 *      actions. Examples: admin dashboards, user management, system settings.
 *
 * ── Enforcement ─────────────────────────────────────────────────────────────
 *
 *  `requirePolicy(request, policy)` is the shared guard used by route handlers.
 *  It returns `null` when the request satisfies the policy, or a `NextResponse`
 *  describing the failure:
 *
 *      401  – no valid session (missing/invalid credentials)
 *      403  – valid session but insufficient role for a privileged route
 *      503  – the policy engine itself is unavailable/misconfigured
 *
 *  Credential comparisons reuse the timing-safe comparison from
 *  `admin-auth.ts` to avoid leaking information through response timing.
 *
 * ── Compatibility / migration notes ─────────────────────────────────────────
 *
 *  - The registry below is the canonical list of API routes. New routes MUST be
 *    added here; `assertRouteCoverage` (see tests) fails CI when a route under
 *    the API tree is missing from the registry, preventing accidental
 *    "unclassified" (and therefore implicitly public) endpoints.
 *  - Routes that previously relied on ad-hoc checks should migrate to
 *    `requirePolicy`. The guard is additive: it does not change session
 *    semantics, only centralizes the decision and the failure responses.
 *  - Unknown routes default to the most restrictive behavior at the call site
 *    (callers should treat a missing registry entry as a bug, not as public).
 *
 * ── Nested-resource authorization (issue #236) ──────────────────────────────
 *
 *  Route-level policy (above) answers "may this caller hit this route?".
 *  Nested resources additionally require a *relationship* check: a caller may
 *  be allowed to reach `/api/campaigns/:id/donations` yet still be forbidden
 *  from reading a specific donation they neither made nor own. This module is
 *  the authoritative boundary for those decisions.
 *
 *  Principals
 *      'owner'         – created/owns the parent resource (e.g. campaign owner)
 *      'collaborator'  – explicitly granted access to the parent resource
 *      'donor'         – contributed to the parent resource (donations/backers)
 *      'anonymous'     – no session, or a session with no relationship
 *
 *  Policy matrix (action × principal). `✓` = allowed, `–` = forbidden (403),
 *  `404` = hide existence from anonymous callers.
 *
 *      Resource / action          owner  collaborator  donor  anonymous
 *      campaign:read               ✓        ✓           ✓       ✓
 *      campaign:update             ✓        ✓           –       –
 *      campaign:delete             ✓        –           –       –
 *      collaborator:list           ✓        ✓           –       –
 *      collaborator:manage         ✓        –           –       –
 *      donation:read               ✓        ✓           ✓*      –
 *      donation:create             ✓        ✓           ✓       –
 *      donation:update             ✓        –           ✓*      –
 *      donation:delete             ✓        –           –       –
 *      sponsorship_receipt:read    ✓        ✓           ✓*      –
 *      backer:read                 ✓        ✓           ✓*      –
 *
 *      * donors may only act on their *own* donation/receipt/backer records;
 *        the relationship resolver must report `donor` only for those rows.
 *
 *  Enforcement
 *      `resolvePrincipal(request, resource)` derives the caller's principal
 *      for a resource. `canAccessNestedResource(principal, resource, action)`
 *      is the pure decision function. `requireNestedPolicy(request, resource,
 *      action)` is the guard used by route handlers and returns `null` on
 *      success or an explicit failure response:
 *
 *          401  – anonymous caller on a non-public action
 *          403  – authenticated caller lacking the required relationship
 *          404  – anonymous caller on a resource whose existence is hidden
 *          503  – the relationship resolver is unavailable/misconfigured
 *
 *  Compatibility / migration notes
 *      - Existing routes keep working: `requirePolicy` is unchanged. Nested
 *        handlers should call `requireNestedPolicy` *after* `requirePolicy`.
 *      - The relationship resolver is configured via `setRelationshipResolver`.
 *        Like the session resolver it fails closed (503) when unset.
 *      - `canAccessNestedResource` is pure and safe to unit test without a
 *        request; prefer it for authorization logic and use the guard only at
 *        the HTTP boundary.
 */

import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { timingSafeEqual } from 'crypto';

/** The three supported policy levels. */
export type ApiPolicy = 'public' | 'authenticated' | 'privileged';

/** A single registry entry describing a route and its policy. */
export interface RoutePolicyEntry {
  /** Route path pattern, e.g. `/api/admin/users` or `/api/orders/:id`. */
  readonly path: string;
  /** Policy level required to access the route. */
  readonly policy: ApiPolicy;
  /** Roles permitted for 'privileged' routes. Ignored otherwise. */
  readonly roles?: readonly string[];
}

/** Roles that are considered privileged by default. */
export const DEFAULT_PRIVILEGED_ROLES: readonly string[] = ['admin'];

/**
 * Canonical route-policy registry.
 *
 * Every API route must appear here exactly once. Paths may contain `:param`
 * segments which match a single path segment at enforcement time.
 */
export const ROUTE_POLICIES: readonly RoutePolicyEntry[] = [
  // ── Public ────────────────────────────────────────────────────────────────
  { path: '/api/health', policy: 'public' },
  { path: '/api/config', policy: 'public' },

  // ── Authenticated ─────────────────────────────────────────────────────────
  { path: '/api/me', policy: 'authenticated' },
  { path: '/api/orders', policy: 'authenticated' },
  { path: '/api/orders/:id', policy: 'authenticated' },
  { path: '/api/notifications', policy: 'authenticated' },
  // Campaign discovery batch reads (issue #231). Bounded batch reads are
  // scoped to the caller; ownership/visibility is enforced in the service.
  { path: '/api/campaigns/discovery/batch', policy: 'authenticated' },
  // Large campaign exports run as asynchronous jobs (issue #228). The
  // artifact retrieval route additionally verifies job ownership in the
  // service layer; the policy boundary only requires a valid session.
  { path: '/api/campaigns/:id/exports', policy: 'authenticated' },
  { path: '/api/campaigns/:id/exports/:jobId', policy: 'authenticated' },

  // ── Privileged ────────────────────────────────────────────────────────────
  { path: '/api/admin/users', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
  { path: '/api/admin/users/:id', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
  { path: '/api/admin/settings', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
  // Audited operator webhook redelivery (issue #230). Each manual attempt is
  // recorded; only privileged operators may trigger a redelivery.
  { path: '/api/admin/webhooks/:id/redeliver', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
] as const;

/** Minimal shape of the session object the guard understands. */
export interface PolicySession {
  /** Whether the caller has a valid, authenticated session. */
  authenticated: boolean;
  /** Roles granted to the caller, if any. */
  roles?: readonly string[];
}

/** Result of resolving a session for a request. */
export type SessionResolver = (
  request: Request,
) => PolicySession | null | Promise<PolicySession | null>;

/**
 * Default session resolver. Integrations should replace this via
 * `setSessionResolver` (or pass a resolver explicitly to `requirePolicy`).
 *
 * The default is intentionally conservative: it treats every request as
 * unauthenticated unless a resolver has been configured. This ensures that
 * forgetting to wire up authentication fails closed rather than open.
 */
let sessionResolver: SessionResolver | null = null;

/**
 * Configure the session resolver used by `requirePolicy`.
 *
 * Passing `null` restores the fail-closed default.
 */
export function setSessionResolver(resolver: SessionResolver | null): void {
  sessionResolver = resolver;
}

/** Returns the currently configured session resolver, if any. */
export function getSessionResolver(): SessionResolver | null {
  return sessionResolver;
}

/**
 * Timing-safe string comparison. Reuses the same primitive as
 * `admin-auth.ts` so credential/role comparisons do not leak timing
 * information. Returns `false` for any non-string or length mismatch.
 */
export function safeCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison of equal-length buffers to keep timing
    // roughly constant, then return false.
    const len = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(len);
    const paddedB = Buffer.alloc(len);
    bufA.copy(paddedA);
    bufB.copy(paddedB);
    timingSafeEqual(paddedA, paddedB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Returns true when any of the caller's roles matches any of the required
 * roles, using timing-safe comparison.
 */
export function hasRequiredRole(
  callerRoles: readonly string[] | undefined,
  requiredRoles: readonly string[] | undefined,
): boolean {
  const required = requiredRoles && requiredRoles.length > 0
    ? requiredRoles
    : DEFAULT_PRIVILEGED_ROLES;
  if (!callerRoles || callerRoles.length === 0) {
    return false;
  }
  // Compare every pair to avoid early-exit timing differences.
  let matched = false;
  for (const callerRole of callerRoles) {
    for (const requiredRole of required) {
      if (safeCompare(callerRole, requiredRole)) {
        matched = true;
      }
    }
  }
  return matched;
}

/** Normalizes a pathname by stripping a trailing slash (except root). */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/** Splits a path into non-empty segments. */
function segments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

/**
 * Returns true when `pattern` (which may contain `:param` segments) matches
 * the concrete `pathname`.
 */
export function matchRoute(pattern: string, pathname: string): boolean {
  const patternSegs = segments(pattern);
  const pathSegs = segments(pathname);
  if (patternSegs.length !== pathSegs.length) {
    return false;
  }
  for (let i = 0; i < patternSegs.length; i += 1) {
    const p = patternSegs[i];
    if (p.startsWith(':')) {
      continue; // wildcard single segment
    }
    if (p !== pathSegs[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Resolves the registry entry for a concrete pathname, or `null` when the
 * route is not registered.
 */
export function resolveRoutePolicy(pathname: string): RoutePolicyEntry | null {
  const normalized = normalizePath(pathname);
  for (const entry of ROUTE_POLICIES) {
    if (matchRoute(entry.path, normalized)) {
      return entry;
    }
  }
  return null;
}

/** Extracts the pathname from a Request/URL-like object. */
function getPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

/**
 * Returns true when the route identified by `request` (or a pathname string)
 * is classified as 'public'.
 */
export function isPublicRoute(requestOrPath: Request | string): boolean {
  const path = typeof requestOrPath === 'string' ? requestOrPath : getPathname(requestOrPath);
  return resolveRoutePolicy(path)?.policy === 'public';
}

/**
 * Returns true when the route identified by `request` (or a pathname string)
 * is classified as 'authenticated'.
 */
export function isAuthenticatedRoute(requestOrPath: Request | string): boolean {
  const path = typeof requestOrPath === 'string' ? requestOrPath : getPathname(requestOrPath);
  return resolveRoutePolicy(path)?.policy === 'authenticated';
}

/**
 * Returns true when the route identified by `request` (or a pathname string)
 * is classified as 'privileged'.
 */
export function isPrivilegedRoute(requestOrPath: Request | string): boolean {
  const path = typeof requestOrPath === 'string' ? requestOrPath : getPathname(requestOrPath);
  return resolveRoutePolicy(path)?.policy === 'privileged';
}

// ─────────────────────────────────────────────────────────────────────────────
// Request hardening (issues #232–#235)
//
// The helpers below are the authoritative boundary for four cross-cutting
// concerns that must be applied *before* expensive application/database work:
//
//   #232  Conditional reads  – strong ETags derived from representation +
//                              authorization scope, so caches never leak data
//                              across principals/tenants/roles.
//   #233  Request budgets    – reject oversized bodies, deeply nested lists and
//                              excessive filters up front (413 / 422).
//   #234  Operation metering  – weighted per-tenant budgets (429 + Retry-After).
//   #235  Analytics coalescing – single-flight cold reads with bounded
//                              stale-while-revalidate, never mixing scopes.
//
// Every helper returns an explicit failure envelope so operators and clients
// can distinguish "rejected" from "unavailable" and recover deterministically.
// ─────────────────────────────────────────────────────────────────────────────

/** Machine-readable reason codes for request-budget rejections. */
export type RequestBudgetReason =
  | 'body_too_large'
  | 'list_too_deep'
  | 'too_many_filters';

/** Options controlling `enforceRequestBudgets`. */
export interface RequestBudgetOptions {
  /** Maximum accepted request body size in bytes. */
  readonly maxBodyBytes: number;
  /** Maximum accepted nesting depth of list/array values. */
  readonly maxListDepth: number;
  /** Maximum accepted number of filter parameters. */
  readonly maxFilterCount: number;
}

/** Default request budgets applied when a route does not override them. */
export const DEFAULT_REQUEST_BUDGETS: RequestBudgetOptions = {
  maxBodyBytes: 1_048_576, // 1 MiB
  maxListDepth: 5,
  maxFilterCount: 25,
} as const;

/** Result of a budget check: `ok` or an explicit rejection envelope. */
export type RequestBudgetResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 413 | 422;
      readonly code: 'REQUEST_TOO_LARGE' | 'REQUEST_BUDGET_EXCEEDED';
      readonly reason: RequestBudgetReason;
      readonly message: string;
      readonly response: NextResponse;
    };

/** Builds a JSON error envelope with a machine-readable `reason`. */
function budgetError(
  status: 413 | 422,
  code: 'REQUEST_TOO_LARGE' | 'REQUEST_BUDGET_EXCEEDED',
  reason: RequestBudgetReason,
  message: string,
): NextResponse {
  return NextResponse.json(
    { error: { code, reason, message } },
    { status },
  );
}

/** Computes the maximum nesting depth of arrays within a parsed value. */
function listDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) {
    let max = depth + 1;
    for (const item of value) {
      const child = listDepth(item, depth + 1);
      if (child > max) {
        max = child;
      }
    }
    return max;
  }
  if (value && typeof value === 'object') {
    let max = depth;
    for (const item of Object.values(value as Record<string, unknown>)) {
      const child = listDepth(item, depth);
      if (child > max) {
        max = child;
      }
    }
    return max;
  }
  return depth;
}

/** Counts filter-like query parameters (`filter`, `filter[...]`, `filters`). */
function countFilters(url: URL): number {
  let count = 0;
  for (const key of url.searchParams.keys()) {
    if (key === 'filter' || key === 'filters' || key.startsWith('filter[') || key.startsWith('filter.')) {
      count += 1;
    }
  }
  return count;
}

/**
 * Enforces request size and collection budgets before any parsing or database
 * work (issue #233).
 *
 * Checks, in order:
 *   1. `Content-Length` (when present) against `maxBodyBytes` → 413
 *      `REQUEST_TOO_LARGE` / `body_too_large`.
 *   2. Filter count in the query string against `maxFilterCount` → 422
 *      `REQUEST_BUDGET_EXCEEDED` / `too_many_filters`.
 *   3. For JSON bodies, actual byte length and nested list depth → 413 / 422.
 *
 * The body is read at most once and re-attached to the request so downstream
 * handlers can still consume it. Non-JSON bodies are only size-checked.
 *
 * @returns `{ ok: true }` when within budget, otherwise a rejection envelope
 *          carrying the ready-to-return `response`.
 */
export async function enforceRequestBudgets(
  request: Request,
  options: RequestBudgetOptions = DEFAULT_REQUEST_BUDGETS,
): Promise<RequestBudgetResult> {
  const { maxBodyBytes, maxListDepth, maxFilterCount } = options;

  // 1. Declared size check (cheap, before touching the body).
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
      return {
        ok: false,
        status: 413,
        code: 'REQUEST_TOO_LARGE',
        reason: 'body_too_large',
        message: `Request body exceeds ${maxBodyBytes} bytes.`,
        response: budgetError(
          413,
          'REQUEST_TOO_LARGE',
          'body_too_large',
          `Request body exceeds ${maxBodyBytes} bytes.`,
        ),
      };
    }
  }

  // 2. Filter count check (query string only, no body parse needed).
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    url = new URL('http://localhost/');
  }
  if (countFilters(url) > maxFilterCount) {
    return {
      ok: false,
      status: 422,
      code: 'REQUEST_BUDGET_EXCEEDED',
      reason: 'too_many_filters',
      message: `At most ${maxFilterCount} filters are allowed.`,
      response: budgetError(
        422,
        'REQUEST_BUDGET_EXCEEDED',
        'too_many_filters',
        `At most ${maxFilterCount} filters are allowed.`,
      ),
    };
  }

  // 3. Body checks. Only methods that can carry a body are inspected.
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
    return { ok: true };
  }

  const contentType = request.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  let raw: string;
  try {
    raw = await request.clone().text();
  } catch {
    // Unreadable body: fail closed with an explicit envelope.
    return {
      ok: false,
      status: 422,
      code: 'REQUEST_BUDGET_EXCEEDED',
      reason: 'body_too_large',
      message: 'Request body could not be read.',
      response: budgetError(
        422,
        'REQUEST_BUDGET_EXCEEDED',
        'body_too_large',
        'Request body could not be read.',
      ),
    };
  }

  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > maxBodyBytes) {
    return {
      ok: false,
      status: 413,
      code: 'REQUEST_TOO_LARGE',
      reason: 'body_too_large',
      message: `Request body exceeds ${maxBodyBytes} bytes.`,
      response: budgetError(
        413,
        'REQUEST_TOO_LARGE',
        'body_too_large',
        `Request body exceeds ${maxBodyBytes} bytes.`,
      ),
    };
  }

  if (isJson && raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        status: 422,
        code: 'REQUEST_BUDGET_EXCEEDED',
        reason: 'list_too_deep',
        message: 'Request body is not valid JSON.',
        response: budgetError(
          422,
          'REQUEST_BUDGET_EXCEEDED',
          'list_too_deep',
          'Request body is not valid JSON.',
        ),
      };
    }
    if (listDepth(parsed) > maxListDepth) {
      return {
        ok: false,
        status: 422,
        code: 'REQUEST_BUDGET_EXCEEDED',
        reason: 'list_too_deep',
        message: `List nesting exceeds ${maxListDepth} levels.`,
        response: budgetError(
          422,
          'REQUEST_BUDGET_EXCEEDED',
          'list_too_deep',
          `List nesting exceeds ${maxListDepth} levels.`,
        ),
      };
    }
  }

  return { ok: true };
}

// ── #232 Conditional reads ───────────────────────────────────────────────────

/** Authorization scope mixed into representation validators. */
export interface RepresentationScope {
  /** Stable principal identifier (user id). */
  readonly principalId: string;
  /** Tenant identifier, when the deployment is multi-tenant. */
  readonly tenantId?: string;
  /** Roles granted to the principal, order-independent. */
  readonly roles?: readonly string[];
}

/** Deterministic JSON serialization with sorted object keys. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * Computes a strong ETag for a cacheable representation (issue #232).
 *
 * The validator is `"sha256-<hex>"` over the canonical (key-sorted) JSON of
 * the body combined with the authorization scope. Because the scope is part of
 * the hash, two principals/tenants/role sets can never share a validator even
 * when their bodies are byte-identical — preventing cross-principal cache
 * leakage through shared caches or CDNs.
 *
 * @param body  The representation to hash (any JSON-serializable value).
 * @param scope Principal/tenant/role context the representation was computed
 *              under. Roles are sorted so ordering does not affect the hash.
 */
export function computeRepresentationValidator(
  body: unknown,
  scope: RepresentationScope,
): string {
  const roles = [...(scope.roles ?? [])].sort();
  const material = canonicalize({
    body,
    principalId: scope.principalId,
    tenantId: scope.tenantId ?? null,
    roles,
  });
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  return `"sha256-${digest}"`;
}

/** Parses an `If-None-Match` header into individual entity tags. */
function parseIfNoneMatch(header: string): string[] {
  return header
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Evaluates a conditional read against the current representation validator
 * (issue #232).
 *
 * Supports `If-None-Match` with strong tags, weak tags (`W/"..."`) and `*`.
 * When the header matches the current ETag the caller should respond `304`
 * with no body; otherwise the caller proceeds and should send the ETag via
 * `ETag` plus `Cache-Control: private` so shared caches never store it.
 *
 * @returns `null` when the request should proceed, or a `304` response.
 */
export function evaluateConditionalRead(
  request: Request,
  etag: string,
): NextResponse | null {
  const header = request.headers.get('if-none-match');
  if (!header) {
    return null;
  }
  const candidates = parseIfNoneMatch(header);
  const normalized = etag.replace(/^W\//, '');
  for (const candidate of candidates) {
    if (candidate === '*') {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }
    if (candidate.replace(/^W\//, '') === normalized) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }
  }
  return null;
}

// ── #234 Operation metering ──────────────────────────────────────────────────

/** Operation classes that consume weighted budget units. */
export type OperationClass = 'read' | 'search' | 'analytics' | 'export';

/** Weighted cost of each operation class. */
export const OPERATION_COSTS: Readonly<Record<OperationClass, number>> = {
  read: 1,
  search: 2,
  analytics: 5,
  export: 10,
} as const;

/** Minimal Redis-like surface used for atomic budget deduction. */
export interface BudgetStore {
  /**
   * Atomically deduct `cost` from `key` and return the remaining balance.
   * Implementations MUST be atomic (e.g. a Lua script or `DECRBY`).
   */
  deduct(key: string, cost: number, ttlSeconds: number): Promise<number>;
}

/** Per-tenant budget configuration. */
export interface TenantBudget {
  /** Units available per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/** Default per-tenant budget: 10,000 units per minute. */
export const DEFAULT_TENANT_BUDGET: TenantBudget = {
  limit: 10_000,
  windowSeconds: 60,
} as const;

/**
 * Failure mode for a metering operation when the budget store is unavailable.
 *  - `fail-open`  : allow the request (used for lightweight reads so a Redis
 *                   outage does not take the API down).
 *  - `fail-closed`: reject with 503 (used for expensive operations where an
 *                   unmetered burst could exhaust downstream capacity).
 */
export type MeteringFailureMode = 'fail-open' | 'fail-closed';

/** Failure mode per operation class. */
export const METERING_FAILURE_MODES: Readonly<Record<OperationClass, MeteringFailureMode>> = {
  read: 'fail-open',
  search: 'fail-open',
  analytics: 'fail-closed',
  export: 'fail-closed',
} as const;

/** Result of a metering attempt. */
export type MeterResult =
  | { readonly ok: true; readonly remaining: number; readonly cost: number }
  | {
      readonly ok: false;
      readonly status: 429 | 503;
      readonly code: 'BUDGET_EXHAUSTED' | 'METERING_UNAVAILABLE';
      readonly response: NextResponse;
    };

let budgetStore: BudgetStore | null = null;

/** Configures the budget store used by `meterOperation`. */
export function setBudgetStore(store: BudgetStore | null): void {
  budgetStore = store;
}

/** Returns the configured budget store, if any. */
export function getBudgetStore(): BudgetStore | null {
  return budgetStore;
}

/**
 * Meters an operation against the tenant's weighted budget (issue #234).
 *
 * Exports and analytics cost more than lightweight reads (see
 * `OPERATION_COSTS`), so a tenant cannot exhaust shared capacity with cheap
 * calls. Units are deducted atomically from a per-tenant Redis key
 * (`budget:<tenant>:<window>`), which expires after the window.
 *
 * On success the caller should surface `X-RateLimit-Remaining` and
 * `X-RateLimit-Cost` headers. On exhaustion a `429` is returned with
 * `Retry-After` (seconds until the window resets) and `X-RateLimit-Remaining: 0`.
 * If the store is unavailable the behavior depends on the operation class
 * (`METERING_FAILURE_MODES`): lightweight reads fail open, expensive
 * operations fail closed with `503 METERING_UNAVAILABLE`.
 *
 * @param tenantId  Tenant whose budget is charged.
 * @param operation Operation class being performed.
 * @param budget    Optional per-tenant override of the default budget.
 */
export async function meterOperation(
  tenantId: string,
  operation: OperationClass,
  budget: TenantBudget = DEFAULT_TENANT_BUDGET,
): Promise<MeterResult> {
  const cost = OPERATION_COSTS[operation];
  const store = budgetStore;
  if (!store) {
    if (METERING_FAILURE_MODES[operation] === 'fail-open') {
      return { ok: true, remaining: budget.limit, cost };
    }
    return {
      ok: false,
      status: 503,
      code: 'METERING_UNAVAILABLE',
      response: NextResponse.json(
        { error: { code: 'METERING_UNAVAILABLE', message: 'Metering backend unavailable.' } },
        { status: 503 },
      ),
    };
  }

  const window = Math.floor(Date.now() / 1000 / budget.windowSeconds);
  const key = `budget:${tenantId}:${window}`;
  let remaining: number;
  try {
    remaining = await store.deduct(key, cost, budget.windowSeconds);
  } catch {
    if (METERING_FAILURE_MODES[operation] === 'fail-open') {
      return { ok: true, remaining: budget.limit, cost };
    }
    return {
      ok: false,
      status: 503,
      code: 'METERING_UNAVAILABLE',
      response: NextResponse.json(
        { error: { code: 'METERING_UNAVAILABLE', message: 'Metering backend unavailable.' } },
        { status: 503 },
      ),
    };
  }

  if (remaining < 0) {
    const retryAfter = budget.windowSeconds - (Math.floor(Date.now() / 1000) % budget.windowSeconds);
    return {
      ok: false,
      status: 429,
      code: 'BUDGET_EXHAUSTED',
      response: NextResponse.json(
        { error: { code: 'BUDGET_EXHAUSTED', message: 'Tenant budget exhausted.' } },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, retryAfter)),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Cost': String(cost),
          },
        },
      ),
    };
  }

  return { ok: true, remaining, cost };
}

// ── #235 Analytics coalescing ────────────────────────────────────────────────

/** Minimal Redis-like surface used for single-flight locks and caching. */
export interface AnalyticsCacheStore {
  /** Attempts to acquire `key` for `ttlSeconds`; returns true on success. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  /** Releases a lock previously acquired with `acquireLock`. */
  releaseLock(key: string): Promise<void>;
  /** Reads a cached JSON value, or `null` when absent. */
  get(key: string): Promise<string | null>;
  /** Writes a JSON value with a TTL. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** Options controlling analytics coalescing. */
export interface AnalyticsCoalesceOptions {
  /** How long a computed value stays fresh, in seconds. */
  readonly freshSeconds: number;
  /** How long past freshness a value may still be served stale, in seconds. */
  readonly staleSeconds: number;
  /** Lock TTL in seconds (should exceed expected compute time). */
  readonly lockSeconds: number;
  /** Poll interval while waiting for another caller's result, in ms. */
  readonly pollMs?: number;
  /** Maximum time to wait for a coalesced result, in ms. */
  readonly waitMs?: number;
}

/** Default coalescing options. */
export const DEFAULT_ANALYTICS_COALESCE: AnalyticsCoalesceOptions = {
  freshSeconds: 30,
  staleSeconds: 120,
  lockSeconds: 10,
  pollMs: 50,
  waitMs: 2_000,
} as const;

/** Result of a coalesced analytics read. */
export interface AnalyticsResult<T> {
  readonly value: T;
  /** True when the value was served from the stale window. */
  readonly stale: boolean;
  /** True when this caller performed the computation. */
  readonly computed: boolean;
}

let analyticsStore: AnalyticsCacheStore | null = null;

/** Configures the analytics cache store used by `coalesceAnalytics`. */
export function setAnalyticsCacheStore(store: AnalyticsCacheStore | null): void {
  analyticsStore = store;
}

/** Returns the configured analytics cache store, if any. */
export function getAnalyticsCacheStore(): AnalyticsCacheStore | null {
  return analyticsStore;
}

/** Normalizes filters so equivalent filter sets share a cache key. */
function normalizeFilters(filters: Record<string, unknown> | undefined): string {
  return canonicalize(filters ?? {});
}

/**
 * Builds the cache key for a coalesced analytics read. The key includes the
 * tenant, the principal scope and the normalized filters, so entries are never
 * reused across scopes (issue #235).
 */
export function analyticsCacheKey(
  tenantId: string,
  scope: RepresentationScope,
  filters: Record<string, unknown> | undefined,
): string {
  const roles = [...(scope.roles ?? [])].sort();
  const scopeHash = createHash('sha256')
    .update(canonicalize({ principalId: scope.principalId, roles }), 'utf8')
    .digest('hex');
  const filterHash = createHash('sha256')
    .update(normalizeFilters(filters), 'utf8')
    .digest('hex');
  return `analytics:${tenantId}:${scopeHash}:${filterHash}`;
}

/** Sleeps for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coalesces identical cold analytics reads (issue #235).
 *
 * Behavior:
 *  1. Serve a fresh cached value immediately (`stale: false`).
 *  2. If the value is stale but within the stale window, serve it immediately
 *     with `stale: true` and let a single caller refresh in the background.
 *  3. On a cold miss, exactly one caller acquires a short Redis lock and
 *     computes; concurrent callers poll for the result. If the lock holder
 *     fails, the lock expires and the next caller retries (bounded by
 *     `waitMs`).
 *
 * Entries are keyed by (tenant, principal scope, normalized filters) so
 * permissions and filters are never mixed. If the cache store is unavailable
 * the function fails open by computing directly — analytics must not take the
 * API down, but the caller should surface `X-Analytics-Cache: bypass`.
 *
 * @param compute Callback that produces the value on a cache miss.
 */
export async function coalesceAnalytics<T>(
  tenantId: string,
  scope: RepresentationScope,
  filters: Record<string, unknown> | undefined,
  compute: () => Promise<T>,
  options: AnalyticsCoalesceOptions = DEFAULT_ANALYTICS_COALESCE,
): Promise<AnalyticsResult<T>> {
  const store = analyticsStore;
  if (!store) {
    return { value: await compute(), stale: false, computed: true };
  }

  const key = analyticsCacheKey(tenantId, scope, filters);
  const lockKey = `${key}:lock`;
  const pollMs = options.pollMs ?? 50;
  const waitMs = options.waitMs ?? 2_000;

  // 1. Fresh hit.
  try {
    const cached = await store.get(key);
    if (cached !== null) {
      const parsed = JSON.parse(cached) as { value: T; storedAt: number };
      const ageSeconds = (Date.now() - parsed.storedAt) / 1000;
      if (ageSeconds <= options.freshSeconds) {
        return { value: parsed.value, stale: false, computed: false };
      }
      if (ageSeconds <= options.freshSeconds + options.staleSeconds) {
        // 2. Stale hit: serve immediately, refresh in the background if we win
        //    the lock. Background failures are swallowed; the stale value
        //    remains valid until it falls out of the stale window.
        void (async () => {
          try {
            if (await store.acquireLock(lockKey, options.lockSeconds)) {
              try {
                const value = await compute();
                await store.set(
                  key,
                  JSON.stringify({ value, storedAt: Date.now() }),
                  options.freshSeconds + options.staleSeconds,
                );
              } finally {
                await store.releaseLock(lockKey);
              }
            }
          } catch {
            /* keep serving stale */
          }
        })();
        return { value: parsed.value, stale: true, computed: false };
      }
    }
  } catch {
    // Cache read failed: fail open by computing directly.
    return { value: await compute(), stale: false, computed: true };
  }

  // 3. Cold miss: single-flight.
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    let acquired = false;
    try {
      acquired = await store.acquireLock(lockKey, options.lockSeconds);
    } catch {
      return { value: await compute(), stale: false, computed: true };
    }
    if (acquired) {
      try {
        const value = await compute();
        await store.set(
          key,
          JSON.stringify({ value, storedAt: Date.now() }),
          options.freshSeconds + options.staleSeconds,
        );
        return { value, stale: false, computed: true };
      } finally {
        try {
          await store.releaseLock(lockKey);
        } catch {
          /* lock will expire */
        }
      }
    }
    // Another caller is computing: wait briefly and re-check the cache.
    await sleep(pollMs);
    try {
      const cached = await store.get(key);
      if (cached !== null) {
        const parsed = JSON.parse(cached) as { value: T; storedAt: number };
        return { value: parsed.value, stale: false, computed: false };
      }
    } catch {
      return { value: await compute(), stale: false, computed: true };
    }
  }

  // Timed out waiting: compute directly rather than failing the request.
  return { value: await compute(), stale: false, computed: true };
}

/** Builds a JSON error response with the given status. */
function errorResponse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Enforces `policy` for the given request.
 *
 * @returns `null` when the request satisfies the policy, otherwise a
 *          `NextResponse` with status 401, 403, or 503.
 */
export async function requirePolicy(
  request: Request,
  policy: ApiPolicy,
  resolver?: SessionResolver,
): Promise<NextResponse | null> {
  // Public routes never require a session.
  if (policy === 'public') {
    return null;
  }

  const resolve = resolver ?? sessionResolver;
  if (!resolve) {
    // Fail closed: without a configured resolver we cannot authenticate.
    return errorResponse(
      503,
      'policy_unavailable',
      'Authentication policy engine is not configured.',
    );
  }

  let session: PolicySession | null;
  try {
    session = await resolve(request);
  } catch {
    return errorResponse(
      503,
      'policy_unavailable',
      'Authentication policy engine is unavailable.',
    );
  }

  if (!session || !session.authenticated) {
    return errorResponse(401, 'unauthenticated', 'Authentication required.');
  }

  if (policy === 'authenticated') {
    return null;
  }

  // policy === 'privileged'
  const entry = resolveRoutePolicy(getPathname(request));
  const requiredRoles = entry?.roles ?? DEFAULT_PRIVILEGED_ROLES;
  if (!hasRequiredRole(session.roles, requiredRoles)) {
    return errorResponse(403, 'forbidden', 'Insufficient privileges.');
  }

  return null;
}

// ── Nested-resource authorization (issue #236) ──────────────────────────────

/** Relationship a caller has to a nested resource. */
export type Principal = 'owner' | 'collaborator' | 'donor' | 'anonymous';

/** Kinds of nested resources covered by the policy matrix. */
export type NestedResourceKind =
  | 'campaign'
  | 'collaborator'
  | 'donation'
  | 'sponsorship_receipt'
  | 'backer';

/** Actions that can be performed on a nested resource. */
export type NestedAction =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'list'
  | 'manage';

/** A concrete nested resource reference. */
export interface NestedResource {
  /** Resource kind, e.g. 'donation'. */
  readonly kind: NestedResourceKind;
  /** Stable identifier of the resource (used for logging/auditing). */
  readonly id: string;
  /** Whether the resource is publicly visible (affects anonymous 404s). */
  readonly public?: boolean;
}

/** Result of resolving a caller's relationship to a nested resource. */
export type RelationshipResolver = (
  request: Request,
  resource: NestedResource,
) => Principal | null | Promise<Principal | null>;

/**
 * Default relationship resolver. Integrations replace this via
 * `setRelationshipResolver`. The default fails closed: every caller is
 * treated as anonymous unless a resolver has been configured.
 */
let relationshipResolver: RelationshipResolver | null = null;

/** Configure the relationship resolver used by `resolvePrincipal`. */
export function setRelationshipResolver(resolver: RelationshipResolver | null): void {
  relationshipResolver = resolver;
}

/** Returns the currently configured relationship resolver, if any. */
export function getRelationshipResolver(): RelationshipResolver | null {
  return relationshipResolver;
}

/**
 * Policy matrix: allowed principals per `kind:action` key. Keys not present
 * are forbidden for every principal. Donor entries marked `donorScoped` only
 * apply to the donor's own records; the resolver is responsible for reporting
 * `donor` only for those rows.
 */
const NESTED_POLICY_MATRIX: Readonly<
  Record<string, readonly Principal[]>
> = {
  'campaign:read': ['owner', 'collaborator', 'donor', 'anonymous'],
  'campaign:update': ['owner', 'collaborator'],
  'campaign:delete': ['owner'],
  'collaborator:list': ['owner', 'collaborator'],
  'collaborator:manage': ['owner'],
  'donation:read': ['owner', 'collaborator', 'donor'],
  'donation:create': ['owner', 'collaborator', 'donor'],
  'donation:update': ['owner', 'donor'],
  'donation:delete': ['owner'],
  'sponsorship_receipt:read': ['owner', 'collaborator', 'donor'],
  'backer:read': ['owner', 'collaborator', 'donor'],
};

/**
 * Returns the principals permitted to perform `action` on `kind`, or an empty
 * array when the combination is not in the matrix (fail closed).
 */
export function allowedPrincipals(
  kind: NestedResourceKind,
  action: NestedAction,
): readonly Principal[] {
  return NESTED_POLICY_MATRIX[`${kind}:${action}`] ?? [];
}

/**
 * Pure authorization decision for a nested resource. Returns true when
 * `principal` may perform `action` on `resource`.
 */
export function canAccessNestedResource(
  principal: Principal,
  resource: NestedResource,
  action: NestedAction,
): boolean {
  return allowedPrincipals(resource.kind, action).includes(principal);
}

/**
 * Resolves the caller's principal for `resource` using the configured
 * relationship resolver. Returns 'anonymous' when no resolver is configured,
 * the resolver returns null, or the resolver throws (fail closed).
 */
export async function resolvePrincipal(
  request: Request,
  resource: NestedResource,
  resolver?: RelationshipResolver,
): Promise<Principal> {
  const resolve = resolver ?? relationshipResolver;
  if (!resolve) {
    return 'anonymous';
  }
  try {
    const principal = await resolve(request, resource);
    return principal ?? 'anonymous';
  } catch {
    return 'anonymous';
  }
}

/**
 * Enforces nested-resource authorization for `request`.
 *
 * @returns `null` when allowed, otherwise a `NextResponse` with an explicit
 *          401, 403, 404, or 503 status.
 */
export async function requireNestedPolicy(
  request: Request,
  resource: NestedResource,
  action: NestedAction,
  resolver?: RelationshipResolver,
): Promise<NextResponse | null> {
  const resolve = resolver ?? relationshipResolver;
  if (!resolve) {
    // Fail closed: without a resolver we cannot establish a relationship.
    return errorResponse(
      503,
      'policy_unavailable',
      'Nested-resource policy engine is not configured.',
    );
  }

  let principal: Principal;
  try {
    const resolved = await resolve(request, resource);
    principal = resolved ?? 'anonymous';
  } catch {
    return errorResponse(
      503,
      'policy_unavailable',
      'Nested-resource policy engine is unavailable.',
    );
  }

  if (canAccessNestedResource(principal, resource, action)) {
    return null;
  }

  if (principal === 'anonymous') {
    // Hide existence of non-public resources from anonymous callers.
    if (!resource.public) {
      return errorResponse(404, 'not_found', 'Resource not found.');
    }
    return errorResponse(401, 'unauthenticated', 'Authentication required.');
  }

  return errorResponse(403, 'forbidden', 'Insufficient privileges.');
}