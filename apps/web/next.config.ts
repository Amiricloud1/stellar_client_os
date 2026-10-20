import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import { buildNextConfigHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  /* config options here */
  turbopack: {
    root: "../../",
  },

  /**
   * Production browser security headers (CSP, HSTS, X-Frame-Options,
   * Referrer-Policy, X-Content-Type-Options, Permissions-Policy) and
   * CORS headers for image responses served through Next.js routes.
   */
  async headers() {
    return buildNextConfigHeaders();
  },

  images: {
    /**
     * remotePatterns replaces the deprecated `domains` config.
     * Even though all campaign Image components use unoptimized={true} today
     * (bypassing the optimisation pipeline), these patterns future-proof the
     * config and allow the Next.js Image component to validate external URLs
     * without throwing in strict mode.
     *
     * Covers:
     *   - AWS S3 evidence bucket (us-east-1; adjust region if the bucket moves)
     *   - IPFS public gateway fallback
     *   - Unsplash (used in campaign wizard placeholder / sample data)
     */
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "ipfs.io",
        pathname: "/ipfs/**",
      },
      {
        protocol: "https",
        hostname: "**.ipfs.dweb.link",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
    ],
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
