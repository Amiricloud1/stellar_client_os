/**
 * GET /api/livez — Kubernetes / container orchestrator liveness probe (issue #101)
 *
 * Strictly verifies that the application process and HTTP server are responsive
 * without probing any external dependencies (Horizon, Soroban RPC, Redis, S3).
 * This ensures transient downstream dependency outages never cause orchestrators
 * to restart healthy application containers.
 */

import { NextResponse } from "next/server";
import { evaluateLiveness } from "@/lib/dependency-health";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS: Record<string, string> = { "Cache-Control": "no-store" };

export async function GET(): Promise<NextResponse> {
  const envelope = evaluateLiveness();
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
