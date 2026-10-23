/**
 * Production browser security headers policy — issue #99
 *
 * Defines Content-Security-Policy (CSP), HTTP Strict Transport Security (HSTS),
 * frame protection (`X-Frame-Options` & `frame-ancestors`), `Referrer-Policy`,
 * `X-Content-Type-Options`, `Permissions-Policy`, and `Cross-Origin-Opener-Policy`.
 *
 * Explicitly documents and enforces narrowly required external origins for
 * Stellar Horizon, Soroban RPC, S3/IPFS evidence media, geospatial map tiles,
 * and Sentry error telemetry.
 */

export interface RequiredOriginDescriptor {
  origin: string;
  directive: "connect-src" | "img-src";
  purpose: string;
}

/**
 * Canonical inventory of narrowly required external origins for the Fundable web client.
 */
export const NARROW_REQUIRED_ORIGINS: readonly RequiredOriginDescriptor[] = [
  {
    origin: "https://horizon.stellar.org",
    directive: "connect-src",
    purpose: "Stellar Mainnet Horizon REST API for account balances and transaction history",
  },
  {
    origin: "https://horizon-testnet.stellar.org",
    directive: "connect-src",
    purpose: "Stellar Testnet Horizon REST API",
  },
  {
    origin: "https://soroban-testnet.stellar.org",
    directive: "connect-src",
    purpose: "Soroban Testnet JSON-RPC endpoint for contract simulation and submission",
  },
  {
    origin: "https://mainnet.sorobanrpc.com",
    directive: "connect-src",
    purpose: "Soroban Mainnet JSON-RPC endpoint for contract simulation and submission",
  },
  {
    origin: "https://*.ingest.sentry.io",
    directive: "connect-src",
    purpose: "Sentry client error and performance telemetry ingestion",
  },
  {
    origin: "https://*.amazonaws.com",
    directive: "img-src",
    purpose: "AWS S3 presigned campaign evidence and milestone proof photo bucket",
  },
  {
    origin: "https://ipfs.io",
    directive: "img-src",
    purpose: "Public IPFS gateway for immutable campaign metadata and NFT assets",
  },
  {
    origin: "https://*.ipfs.dweb.link",
    directive: "img-src",
    purpose: "Subdomain-isolated IPFS gateway fallback for campaign evidence media",
  },
  {
    origin: "https://images.unsplash.com",
    directive: "img-src",
    purpose: "Curated campaign placeholder imagery",
  },
  {
    origin: "https://*.tile.openstreetmap.org",
    directive: "img-src",
    purpose: "Leaflet / OpenStreetMap raster tiles for planting site maps",
  },
  {
    origin: "https://demotiles.maplibre.org",
    directive: "img-src",
    purpose: "MapLibre GL vector map tiles for global reforestation stream visualization",
  },
] as const;

export const HSTS_HEADER_VALUE = "max-age=63072000; includeSubDomains; preload";
export const REFERRER_POLICY_VALUE = "strict-origin-when-cross-origin";
export const FRAME_OPTIONS_DENY_VALUE = "DENY";
export const CONTENT_TYPE_OPTIONS_VALUE = "nosniff";
export const PERMISSIONS_POLICY_VALUE =
  "camera=(), microphone=(), geolocation=(self), payment=(), usb=()";
export const DNS_PREFETCH_CONTROL_VALUE = "off";
export const COOP_HEADER_VALUE = "same-origin";

export interface SecurityHeaderEntry {
  key: string;
  value: string;
}

export interface SecurityHeaderOptions {
  /** Environment variables used to resolve dynamic RPC/API origins. */
  env?: NodeJS.ProcessEnv;
  /** Whether to generate strict production directives (default: true). */
  isProduction?: boolean;
  /**
   * When true (used only for `/api/campaigns/[id]/widget`), omits `X-Frame-Options`
   * and sets `frame-ancestors *` so third-party partner sites can embed the widget.
   */
  allowFraming?: boolean;
  /** Optional explicit `frame-ancestors` override. */
  frameAncestors?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate and normalize an environment-provided URL into a narrow CSP origin
 * (`scheme://host[:port]`). Rejects wildcards, credentials, non-HTTP(S) schemes,
 * and plain `http:` origins in production.
 */
export function sanitizeAllowedOrigin(
  rawUrl: string | undefined | null,
  isProduction = true
): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.includes("*")) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return null;

    if (parsed.protocol === "https:") {
      return parsed.origin;
    }

    if (parsed.protocol === "http:") {
      if (!isProduction && LOOPBACK_HOSTS.has(parsed.hostname)) {
        return parsed.origin;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build the Content-Security-Policy header value with narrowly scoped origins.
 */
export function buildContentSecurityPolicy(
  options: SecurityHeaderOptions = {}
): string {
  const env = options.env ?? process.env;
  const isProduction =
    options.isProduction ?? (env.NODE_ENV ? env.NODE_ENV === "production" : true);

  const connectOrigins = new Set<string>([
    "'self'",
    ...NARROW_REQUIRED_ORIGINS.filter((o) => o.directive === "connect-src").map(
      (o) => o.origin
    ),
  ]);

  const dynamicConnectCandidates = [
    env.NEXT_PUBLIC_STELLAR_HORIZON_URL,
    env.NEXT_PUBLIC_SOROBAN_RPC_URL,
    env.NEXT_PUBLIC_API_URL,
    env.NEXT_PUBLIC_BACKEND_BASE_URL,
    env.NEXT_PUBLIC_POLYGON_RPC_URL,
  ];

  for (const candidate of dynamicConnectCandidates) {
    const validOrigin = sanitizeAllowedOrigin(candidate, isProduction);
    if (validOrigin) {
      connectOrigins.add(validOrigin);
    }
  }

  const imgOrigins = [
    "'self'",
    "data:",
    "blob:",
    ...NARROW_REQUIRED_ORIGINS.filter((o) => o.directive === "img-src").map(
      (o) => o.origin
    ),
  ];

  const scriptSources = isProduction
    ? ["'self'", "'unsafe-inline'"]
    : ["'self'", "'unsafe-inline'", "'unsafe-eval'"];

  const frameAncestorsValue =
    options.frameAncestors ?? (options.allowFraming ? "*" : "'none'");

  const directives: string[] = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgOrigins.join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${Array.from(connectOrigins).join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestorsValue}`,
  ];

  if (isProduction) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

/**
 * Build the complete set of production browser security headers.
 */
export function buildSecurityHeaders(
  options: SecurityHeaderOptions = {}
): SecurityHeaderEntry[] {
  const headers: SecurityHeaderEntry[] = [
    {
      key: "Content-Security-Policy",
      value: buildContentSecurityPolicy(options),
    },
    {
      key: "Strict-Transport-Security",
      value: HSTS_HEADER_VALUE,
    },
    {
      key: "Referrer-Policy",
      value: REFERRER_POLICY_VALUE,
    },
    {
      key: "X-Content-Type-Options",
      value: CONTENT_TYPE_OPTIONS_VALUE,
    },
    {
      key: "Permissions-Policy",
      value: PERMISSIONS_POLICY_VALUE,
    },
    {
      key: "X-DNS-Prefetch-Control",
      value: DNS_PREFETCH_CONTROL_VALUE,
    },
    {
      key: "Cross-Origin-Opener-Policy",
      value: COOP_HEADER_VALUE,
    },
  ];

  if (!options.allowFraming) {
    headers.push({
      key: "X-Frame-Options",
      value: FRAME_OPTIONS_DENY_VALUE,
    });
  }

  return headers;
}

/**
 * Apply production browser security headers to a standard Web/Next.js `Response`
 * and return the response for testing or route/middleware composition.
 */
export function applySecurityHeaders<T extends Response>(
  response: T,
  options: SecurityHeaderOptions = {}
): T {
  const securityHeaders = buildSecurityHeaders(options);
  for (const { key, value } of securityHeaders) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Build the Next.js `headers()` route table combining production security headers
 * with CORS rules for image and campaign media routes.
 */
export function buildNextConfigHeaders(env: NodeJS.ProcessEnv = process.env) {
  return [
    {
      // All standard application pages and API routes (excluding embeddable widget)
      source: "/((?!api/campaigns/[^/]+/widget).*)",
      headers: buildSecurityHeaders({ env, isProduction: true, allowFraming: false }),
    },
    {
      // Embeddable campaign impact widget explicitly permits iframe embedding
      source: "/api/campaigns/:id/widget",
      headers: buildSecurityHeaders({ env, isProduction: true, allowFraming: true }),
    },
    {
      // Next.js image optimisation endpoint
      source: "/_next/image",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Access-Control-Allow-Methods", value: "GET, HEAD, OPTIONS" },
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        { key: "Vary", value: "Origin" },
      ],
    },
    {
      // API routes that return or redirect to evidence media (S3, IPFS, CDN)
      source: "/api/campaigns/:path*",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Access-Control-Allow-Methods", value: "GET, HEAD, OPTIONS" },
        { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        { key: "Vary", value: "Origin" },
      ],
    },
  ];
}
