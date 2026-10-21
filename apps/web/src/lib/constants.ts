import { env } from "./env";

export const PAYMENT_STREAM_CONTRACT_ID = env.NEXT_PUBLIC_PAYMENT_STREAM_CONTRACT_ID;
export const DISTRIBUTOR_CONTRACT_ID = env.NEXT_PUBLIC_DISTRIBUTOR_CONTRACT_ID;
export const PLANTER_CONTRACT_ID = env.NEXT_PUBLIC_PLANTER_CONTRACT_ID;
export const SOROBAN_RPC_URL = env.NEXT_PUBLIC_SOROBAN_RPC_URL;
export const NETWORK_PASSPHRASE = env.NEXT_PUBLIC_NETWORK_PASSPHRASE;
export const STELLAR_NETWORK = env.NEXT_PUBLIC_STELLAR_NETWORK;

// Distribution
export const distributionType = ["equal", "weighted"] as const;
export const supportedNetwork = ["mainnet", "testnet"] as const;
export const distributionStatus = ["completed", "failed", "pending"] as const;
export const distributionState = [
    "process-started",
    "initiate-distribution",
    "process-completed",
    "request-confirmed",
    "request-confirmation",
] as const;

// Payment Stream
export const paymentStreamStatus = ["active", "paused", "canceled", "completed"] as const;
export const validPageLimits = [10, 20, 50, 100] as const;

// Stellar Explorer
const isTestnet = NETWORK_PASSPHRASE?.includes("Test SDF Network");
export const STELLAR_EXPERT_URL = isTestnet 
    ? "https://stellar.expert/explorer/testnet" 
    : "https://stellar.expert/explorer/public";

// ---------------------------------------------------------------------------
// API versioning & deprecation policy
// ---------------------------------------------------------------------------
// The API version below MUST stay aligned with `docs/openapi.yaml`
// (`info.version` and the `x-api-version` extension). CI validates this
// alignment; see `docs/api-versioning.md` for the full compatibility and
// sunset policy.
//
// Compatibility rules (summary):
// - Additive, backwards-compatible changes (new optional fields, new
//   endpoints, new enum values that clients are expected to tolerate) do NOT
//   require a major version bump.
// - Breaking changes (removing/renaming fields, tightening validation,
//   changing semantics, removing endpoints) require a new major version.
// - Deprecated operations remain available for at least
//   `API_DEPRECATION_WINDOW_DAYS` after the `Deprecation` header is first
//   emitted, and MUST advertise a `Sunset` date.
// ---------------------------------------------------------------------------

/** Current public API version. Keep in sync with docs/openapi.yaml. */
export const API_VERSION = "1.0.0" as const;

/** Minimum notice period (in days) before a deprecated operation is removed. */
export const API_DEPRECATION_WINDOW_DAYS = 90;

/** Header names used to communicate deprecation state to clients. */
export const DEPRECATION_HEADER = "Deprecation";
export const SUNSET_HEADER = "Sunset";
export const API_VERSION_HEADER = "X-API-Version";

export interface DeprecationOptions {
    /**
     * When the operation was (or will be) deprecated. Defaults to now.
     * Emitted as an RFC 7231 / IMF-fixdate string in the `Deprecation` header.
     */
    deprecatedAt?: Date | string;
    /**
     * When the operation will be removed. If omitted, it is derived from
     * `deprecatedAt` plus `API_DEPRECATION_WINDOW_DAYS`.
     */
    sunsetAt?: Date | string;
    /** Optional link to migration documentation. */
    link?: string;
    /** Optional human-readable message. */
    message?: string;
}

function toHttpDate(value: Date | string): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new TypeError(`Invalid date supplied for deprecation metadata: ${String(value)}`);
    }
    return date.toUTCString();
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Build the deprecation-related response headers for an operation.
 *
 * Returns a plain record so it can be spread into any `HeadersInit`
 * (e.g. `new Response(body, { headers: { ...withDeprecationHeaders() } })`).
 */
export function withDeprecationHeaders(options: DeprecationOptions = {}): Record<string, string> {
    const deprecatedAt = options.deprecatedAt ?? new Date();
    const deprecatedDate =
        deprecatedAt instanceof Date ? deprecatedAt : new Date(deprecatedAt);
    if (Number.isNaN(deprecatedDate.getTime())) {
        throw new TypeError(`Invalid deprecatedAt value: ${String(deprecatedAt)}`);
    }

    const sunsetDate = options.sunsetAt
        ? options.sunsetAt instanceof Date
            ? options.sunsetAt
            : new Date(options.sunsetAt)
        : addDays(deprecatedDate, API_DEPRECATION_WINDOW_DAYS);
    if (Number.isNaN(sunsetDate.getTime())) {
        throw new TypeError(`Invalid sunsetAt value: ${String(options.sunsetAt)}`);
    }

    const headers: Record<string, string> = {
        [DEPRECATION_HEADER]: toHttpDate(deprecatedDate),
        [SUNSET_HEADER]: toHttpDate(sunsetDate),
        [API_VERSION_HEADER]: API_VERSION,
    };

    if (options.link) {
        headers.Link = `<${options.link}>; rel="deprecation"`;
    }
    if (options.message) {
        headers["Warning"] = `299 - "${options.message}"`;
    }

    return headers;
}

/**
 * Merge deprecation headers into an existing `HeadersInit` without mutating
 * the input. Useful for wrapping responses from route handlers.
 */
export function applyDeprecationHeaders(
    init: HeadersInit | undefined,
    options: DeprecationOptions = {},
): Headers {
    const headers = new Headers(init);
    const deprecationHeaders = withDeprecationHeaders(options);
    for (const [key, value] of Object.entries(deprecationHeaders)) {
        headers.set(key, value);
    }
    return headers;
}

/**
 * Returns true when the given sunset date has passed, meaning the operation
 * is eligible for removal. Useful for tests and runtime guards.
 */
export function isPastSunset(sunsetAt: Date | string, now: Date = new Date()): boolean {
    const sunset = sunsetAt instanceof Date ? sunsetAt : new Date(sunsetAt);
    if (Number.isNaN(sunset.getTime())) {
        throw new TypeError(`Invalid sunsetAt value: ${String(sunsetAt)}`);
    }
    return now.getTime() >= sunset.getTime();
}