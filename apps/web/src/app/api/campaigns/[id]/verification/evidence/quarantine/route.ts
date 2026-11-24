import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_API_KEY_ENV, hasAdminToken } from "@/lib/admin-auth";
import { getCampaign } from "@/services/campaign.service";
import {
  getEvidenceQuarantineService,
  isEvidenceQuarantineError,
  type EvidenceActor,
} from "@/services/evidence-quarantine.service";

export const runtime = "nodejs";

const ScanRequestSchema = z.object({
  quarantineId: z.string().trim().min(1).max(256),
  contentBase64: z.string().min(1),
});

function resolveActor(request: NextRequest): EvidenceActor {
  const actorId = request.headers.get("x-actor-id")?.trim() ?? "";
  if (hasAdminToken(request, ADMIN_API_KEY_ENV)) {
    return { id: actorId || "admin", role: "admin" };
  }
  return { id: actorId, role: "uploader" };
}

/**
 * GET /api/campaigns/:id/verification/evidence/quarantine?quarantineId=...
 * Returns the explicit quarantine & scan status (plus recoveryAction) for a
 * single quarantined upload or all quarantined uploads for the campaign.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const campaignId = (await params).id;
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const actor = resolveActor(request);
  const service = getEvidenceQuarantineService();
  const quarantineId = request.nextUrl.searchParams.get("quarantineId");

  if (quarantineId) {
    const record = service.getRecord(quarantineId);
    if (!record || record.campaignId !== campaignId) {
      return NextResponse.json(
        { error: "Quarantine record not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    if (actor.role !== "admin" && actor.id !== record.uploaderId) {
      return NextResponse.json(
        {
          error: "Not authorized to view this quarantine record",
          code: "UNAUTHORIZED",
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ data: record }, { status: 200 });
  }

  if (actor.role !== "admin") {
    return NextResponse.json(
      {
        error: "Admin authorization required to list all quarantined uploads",
        code: "UNAUTHORIZED",
      },
      { status: 403 }
    );
  }

  return NextResponse.json(
    { data: service.listByCampaign(campaignId) },
    { status: 200 }
  );
}

/**
 * POST /api/campaigns/:id/verification/evidence/quarantine
 * Runs (or retries) the security scan for a quarantined upload. Returns
 * explicit scan status, threat findings, and operator/user recoveryAction.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const campaignId = (await params).id;
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const parsed = ScanRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid quarantine scan request",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const service = getEvidenceQuarantineService();
  const existing = service.getRecord(parsed.data.quarantineId);
  if (!existing) {
    return NextResponse.json(
      {
        error: "Quarantine record not found",
        code: "NOT_FOUND",
        recoveryAction: "reupload_clean_file",
      },
      { status: 404 }
    );
  }
  if (existing.campaignId !== campaignId) {
    return NextResponse.json(
      {
        error: "Quarantine record belongs to a different campaign",
        code: "UNAUTHORIZED",
        recoveryAction: "none",
      },
      { status: 403 }
    );
  }

  const actor = resolveActor(request);
  const content = Buffer.from(parsed.data.contentBase64, "base64");

  try {
    const result = await service.scanEvidence(
      parsed.data.quarantineId,
      content,
      actor
    );
    const status =
      result.status === "clean" || result.status === "published"
        ? 200
        : result.status === "infected"
          ? 422
          : 503;
    return NextResponse.json({ data: result }, { status });
  } catch (error) {
    if (isEvidenceQuarantineError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          status: error.recordStatus,
          recoveryAction: error.recoveryAction,
        },
        { status: error.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Failed to scan quarantined evidence" },
      { status: 500 }
    );
  }
}
