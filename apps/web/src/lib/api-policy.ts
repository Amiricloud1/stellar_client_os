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

  // ── Privileged ────────────────────────────────────────────────────────────
  { path: '/api/admin/users', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
  { path: '/api/admin/users/:id', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
  { path: '/api/admin/settings', policy: 'privileged', roles: DEFAULT_PRIVILEGED_ROLES },
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