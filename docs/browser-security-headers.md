# Production Browser Security Headers Policy (Issue #99)

This document defines the production HTTP security headers configured for `@fundable/web` (`apps/web/src/lib/security-headers.ts` and `apps/web/next.config.ts`), the narrowly required external origins permitted by our Content Security Policy (CSP), and compatibility considerations for embeddable widgets.

---

## 1. Enforced Security Headers

All standard application routes (`/((?!api/campaigns/[^/]+/widget).*)`) serve the following headers:

| Header | Value | Security Objective |
| :--- | :--- | :--- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src ...; connect-src ...; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests` | Mitigates XSS, data exfiltration, unauthorized script execution, and clickjacking. Strictly omits `'unsafe-eval'` in production. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Enforces HTTPS-only connections for 2 years across all subdomains (HSTS Preload compliant). |
| `X-Frame-Options` | `DENY` | Prevents framing of application pages in legacy and modern browsers. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Sends full path on same-origin requests, only origin on cross-origin HTTPS, and nothing on HTTPS→HTTP downgrades. |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-sniffing of script and stylesheet responses. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(self), payment=(), usb=()` | Disables unused sensitive browser APIs while permitting same-origin geolocation for tree-planting site verification. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isolates the browsing context group from cross-origin popups. |
| `X-DNS-Prefetch-Control` | `off` | Prevents privacy-leaking speculative DNS resolution. |

---

## 2. Narrowly Required External Origins

Every external origin in `NARROW_REQUIRED_ORIGINS` (`apps/web/src/lib/security-headers.ts`) is scoped to the specific CSP directive that requires it:

| Origin | CSP Directive | Purpose |
| :--- | :--- | :--- |
| `https://horizon.stellar.org` | `connect-src` | Stellar Mainnet Horizon REST API for account balances and transaction history |
| `https://horizon-testnet.stellar.org` | `connect-src` | Stellar Testnet Horizon REST API |
| `https://soroban-testnet.stellar.org` | `connect-src` | Soroban Testnet JSON-RPC endpoint for contract simulation and submission |
| `https://mainnet.sorobanrpc.com` | `connect-src` | Soroban Mainnet JSON-RPC endpoint for contract simulation and submission |
| `https://*.ingest.sentry.io` | `connect-src` | Sentry client error and performance telemetry ingestion |
| `https://*.amazonaws.com` | `img-src` | AWS S3 presigned campaign evidence and milestone proof photo bucket |
| `https://ipfs.io` | `img-src` | Public IPFS gateway for immutable campaign metadata and NFT assets |
| `https://*.ipfs.dweb.link` | `img-src` | Subdomain-isolated IPFS gateway fallback for campaign evidence media |
| `https://images.unsplash.com` | `img-src` | Curated campaign placeholder imagery |
| `https://*.tile.openstreetmap.org` | `img-src` | Leaflet / OpenStreetMap raster tiles for planting site maps |
| `https://demotiles.maplibre.org` | `img-src` | MapLibre GL vector map tiles for global reforestation stream visualization |

### Dynamic Environment Origin Sanitization
Custom endpoints configured via `NEXT_PUBLIC_STELLAR_HORIZON_URL`, `NEXT_PUBLIC_SOROBAN_RPC_URL`, `NEXT_PUBLIC_API_URL`, or `NEXT_PUBLIC_BACKEND_BASE_URL` are passed through `sanitizeAllowedOrigin()`:
- Strips paths, query strings, and fragments down to `scheme://host[:port]`.
- Rejects wildcards (`*`), embedded credentials, and non-HTTP(S) protocols.
- Rejects plain `http:` origins in production (`isProduction: true`), permitting loopback `http://localhost` / `http://127.0.0.1` only during local development.

---

## 3. Compatibility & Embeddable Widget Boundary

- **Embeddable Campaign Widget (`/api/campaigns/:id/widget`):**
  - The HTML impact widget is designed to be embedded via `<iframe>` on third-party partner websites.
  - For `/api/campaigns/:id/widget` HTML responses, `allowFraming: true` omits `X-Frame-Options` and sets `frame-ancestors *` while still enforcing HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and all other CSP directives.
  - The JSON metadata mode (`?format=meta`) is not framed and retains `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
