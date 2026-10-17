import { StrKey } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";
import {
  ADMIN_API_KEY_ENV,
  checkPolicy,
  hasBearerToken,
  type ApiPolicy,
} from "./api-policy";

/**
 * Admin API authorization.
 *
 * This module is a thin compatibility layer over `./api-policy`, which owns the
 * single implementation of API authentication policy (issue #54). New code
 * should import from `./api-policy` directly.
 *
 * Privileged routes MUST go through `requirePolicy(request, 'privileged')`
 * (or `checkPolicy(request, 'privileged')` when a `NextResponse | null` is
 * preferred); do not hand-roll bearer-token comparisons in route handlers.
 *
 * The admin key is read from the `Authorization` header only, never from the
 * query string, so it cannot end up in access logs or browser history. The
 * check fails closed: when `ADMIN_API_KEY` is not configured the endpoint
 * answers 503 rather than serving admin data to anyone.
 */
export { ADMIN_API_KEY_ENV };

/**
 * Returns true when the request carries `Authorization: Bearer <token>` matching
 * the secret stored in `process.env[envVar]`. An unset secret denies everyone,
 * so privileged endpoints stay closed until an operator configures them.
 *
 * @deprecated Use `checkPolicy(request, 'privileged')` from `./api-policy`.
 */
export function hasAdminToken(request: Request, envVar: string): boolean {
  return hasBearerToken(request, envVar);
}

export function isStellarAccount(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/**
 * Returns `null` when the request satisfies the `privileged` policy, or the
 * response to send instead: 503 when no key is configured, 401 when the key is
 * missing or wrong.
 *
 * @deprecated Use `checkPolicy(request, 'privileged')` from `./api-policy`.
 */
export function authorizeAdminRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): NextResponse | null {
  return checkPolicy(request, "privileged" satisfies ApiPolicy, env);
}
