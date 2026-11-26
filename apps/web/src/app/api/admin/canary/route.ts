/**
 * GET  /api/admin/canary — current canary release and rollback state.
 * POST /api/admin/canary — rehearse, start, evaluate, advance, or roll back.
 *
 * This route is the authoritative HTTP boundary for issue #282. It requires the
 * privileged admin policy (`ADMIN_API_KEY`) and never mutates state on GET.
 *
 * Actions:
 *   - `rehearse`  dry-run the rollback criteria for a release pair.
 *   - `start`     begin a canary at the first traffic stage. Requires a
 *                 matching successful rehearsal.
 *   - `evaluate`  refresh critical-journey and data-integrity signals. Critical
 *                 signals automatically stop the rollout and roll back.
 *   - `advance`   promote to the next traffic stage after a fresh healthy
 *                 evaluation and the observation window.
 *   - `rollback`  stop traffic and restore the previous release.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdminRequest } from "@/lib/admin-auth";
import {
  CanaryReleaseError,
  getCanaryReleaseController,
  type CanaryStatus,
} from "@/lib/canary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = "private, no-store, max-age=0";

const actor = z.string().trim().min(1).max(128);
const release = z.string().trim().min(1).max(128);
const reason = z.string().trim().min(3).max(500);

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("rehearse"), release, previousRelease: release, actor }),
  z.object({ action: z.literal("start"), release, previousRelease: release, actor }),
  z.object({ action: z.literal("evaluate") }),
  z.object({ action: z.literal("advance"), actor }),
  z.object({ action: z.literal("rollback"), actor, reason }),
]);

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE },
  });
}

function statusPayload(data: CanaryStatus): Record<string, unknown> {
  return { data };
}

function statusCodeFor(error: CanaryReleaseError): number {
  switch (error.code) {
    case "INVALID_ARGUMENT":
      return 400;
    case "INVALID_STATE":
    case "REHEARSAL_REQUIRED":
    case "OBSERVATION_WINDOW_NOT_MET":
    case "HEALTH_GATE_BLOCKED":
    case "ROLLBACK_TRIGGERED":
      return 409;
    case "ROLLBACK_NOT_READY":
      return 503;
    default:
      return 500;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeAdminRequest(request);
  if (unauthorized) return unauthorized;

  return json(statusPayload(getCanaryReleaseController().getStatus()));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = authorizeAdminRequest(request);
  if (unauthorized) return unauthorized;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const parsed = ActionSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      { error: "Invalid canary action.", details: parsed.error.flatten() },
      400,
    );
  }

  const controller = getCanaryReleaseController();

  try {
    switch (parsed.data.action) {
      case "rehearse": {
        const rehearsal = await controller.rehearseRollback(parsed.data);
        if (!rehearsal.passed) {
          return json(
            {
              error: "ROLLBACK_REHEARSAL_FAILED",
              message:
                "Rollback criteria did not pass rehearsal; the release cannot start.",
              data: rehearsal,
            },
            409,
          );
        }
        return json({ data: rehearsal });
      }

      case "start":
        return json(statusPayload(controller.start(parsed.data)));

      case "evaluate": {
        const evaluation = await controller.evaluate();
        const status = controller.getStatus();
        const rollbackFailed =
          evaluation.mustRollback && status.rollback.status === "failed";
        return json(
          {
            data: {
              evaluation,
              status,
              ...(rollbackFailed
                ? {
                    error: "ROLLBACK_HANDLER_FAILED",
                    message:
                      "Traffic was stopped, but the previous release could not be restored automatically. Manual recovery is required.",
                  }
                : {}),
            },
          },
          rollbackFailed ? 502 : 200,
        );
      }

      case "advance":
        return json(statusPayload(await controller.advance(parsed.data.actor)));

      case "rollback": {
        const status = await controller.rollback(parsed.data);
        if (status.rollback.status === "failed") {
          return json(
            {
              error: "ROLLBACK_HANDLER_FAILED",
              message:
                "Traffic was stopped, but the previous release could not be restored automatically. Manual recovery is required.",
              data: status,
            },
            502,
          );
        }
        return json(statusPayload(status));
      }
    }
  } catch (error) {
    if (error instanceof CanaryReleaseError) {
      return json(
        {
          error: error.code,
          message: error.message,
          details: error.details,
          data: controller.getStatus(),
        },
        statusCodeFor(error),
      );
    }
    console.error(
      "Canary release action failed",
      error instanceof Error ? error.message : error,
    );
    return json({ error: "Failed to apply canary release action." }, 500);
  }

  return json({ error: "Unsupported canary action." }, 400);
}
