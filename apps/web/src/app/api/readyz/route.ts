/**
 * GET /api/readyz — Kubernetes / container orchestrator readiness probe (issue #101)
 *
 * Probes critical external dependencies (Stellar Horizon, Soroban RPC, Redis
 * cache, and S3 object storage) with bounded timeouts:
 * - Returns `200` `{ status: "ok" }` when all dependencies are healthy.
 * - Returns `200` `{ status: "degraded" }` (or `503` when `?strict=true`) when
 *   only optional/fail-safe dependencies (e.g. non-required Redis cache) are degraded.
 * - Returns `503` `{ status: "unhealthy" }` when any critical dependency
 *   (Horizon, Soroban RPC, or required Redis/storage) is down or times out.
 */

import { NextRequest, NextResponse } from "next/server";
import { evaluateReadiness } from "@/lib/dependency-health";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS: Record<string, string> = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const strictParam = req.nextUrl.searchParams.get("strict");
  const timeoutParam = req.nextUrl.searchParams.get("timeoutMs");
  const strict = strictParam === "true" || strictParam === "1";
  const timeoutMs = timeoutParam ? Number(timeoutParam) : undefined;

  const envelope = await evaluateReadiness({ strict, timeoutMs });

  return NextResponse.json(
    {
      status: envelope.status,
      probe: envelope.probe,
      checks: envelope.checks,
      timestamp: envelope.timestamp,
    },
    { status: envelope.httpStatus, headers: NO_STORE_HEADERS }
  );
}
