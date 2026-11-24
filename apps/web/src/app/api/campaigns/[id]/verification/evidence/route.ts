import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_API_KEY_ENV, hasAdminToken } from "@/lib/admin-auth";
import {
  isLocationPrecisionError,
  LOCATION_PRECISION_LEVELS,
  minimizeEvidenceLocation,
  type LocationViewerRole,
} from "@/lib/location-precision";
import { isQuarantineEvidenceKey } from "@/lib/s3";
import {
  getCampaign,
  getCampaignDataSource,
} from "@/services/campaign.service";
import {
  getEvidenceQuarantineService,
  isEvidenceQuarantineError,
  type EvidenceActor,
} from "@/services/evidence-quarantine.service";
import type { VerificationEvidence } from "@/types/campaign-verification";

const EvidenceSchema = z.object({
  id: z.string().trim().min(1).max(256),
  type: z.enum(["photo", "video"]),
  url: z.string().url(),
  capturedAt: z.number().int().positive(),
  uploadedAt: z.number().int().positive().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  locationPrecision: z.enum(LOCATION_PRECISION_LEVELS).optional(),
  quarantineId: z.string().trim().min(1).max(256).optional(),
  storageKey: z.string().trim().min(1).max(512).optional(),
  verifierId: z.string().trim().min(1).max(256).optional(),
  caption: z.string().max(2_000).optional(),
  contentHash: z.string().max(256).optional(),
  underwriterId: z.string().trim().min(1).max(256).optional(),
  insurancePolicyId: z.string().trim().min(1).max(256).optional(),
});

function resolveEvidenceActor(
  request: NextRequest,
  fallbackActorId?: string
): { actor: EvidenceActor; viewerRole: LocationViewerRole } {
  const actorId =
    request.headers.get("x-actor-id")?.trim() || fallbackActorId || "";
  if (hasAdminToken(request, ADMIN_API_KEY_ENV)) {
    return {
      actor: { id: actorId || "admin", role: "admin" },
      viewerRole: "admin",
    };
  }
  return {
    actor: { id: actorId, role: "uploader" },
    viewerRole: actorId ? "uploader" : "public",
  };
}

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const campaignId = (await params).id;
  const campaign = await getCampaign(campaignId);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const parsed = EvidenceSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid evidence", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { actor, viewerRole } = resolveEvidenceActor(
    request,
    parsed.data.verifierId
  );

  // Enforce #280: block direct publication of quarantined storage paths without
  // a verified clean quarantine record.
  const referencesQuarantine =
    isQuarantineEvidenceKey(parsed.data.url) ||
    (parsed.data.storageKey !== undefined &&
      isQuarantineEvidenceKey(parsed.data.storageKey));

  if (referencesQuarantine && !parsed.data.quarantineId) {
    return NextResponse.json(
      {
        error:
          "Quarantined evidence cannot be published without passing security scanning",
        code: "QUARANTINE_NOT_CLEAN",
        recoveryAction: "await_scan",
      },
      { status: 409 }
    );
  }

  // Enforce #281: minimize coordinate precision at the authoritative ingestion
  // boundary prior to persistence or public publication.
  let minimizedPayload: typeof parsed.data;
  try {
    minimizedPayload = minimizeEvidenceLocation(parsed.data, {
      precision: parsed.data.locationPrecision,
      actorRole: viewerRole,
    });
  } catch (error) {
    if (isLocationPrecisionError(error)) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          recoveryAction: error.recoveryAction,
        },
        { status: error.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Invalid evidence coordinates" },
      { status: 400 }
    );
  }

  if (
    (campaign.verificationEvidence ?? []).some(
      (item) => item.id === minimizedPayload.id
    )
  ) {
    return NextResponse.json(
      { error: "Evidence already exists" },
      { status: 409 }
    );
  }

  let publishedQuarantineMeta:
    | {
        quarantineId: string;
        scanStatus: "published";
        publishedKey?: string;
        contentHash?: string;
      }
    | undefined;

  if (minimizedPayload.quarantineId) {
    try {
      const promoted = getEvidenceQuarantineService().markPublished(
        minimizedPayload.quarantineId,
        campaignId,
        actor
      );
      publishedQuarantineMeta = {
        quarantineId: promoted.id,
        scanStatus: "published",
        publishedKey: promoted.publishedKey,
        contentHash: minimizedPayload.contentHash ?? promoted.contentSha256,
      };
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
        { error: "Failed to verify quarantine scan state" },
        { status: 500 }
      );
    }
  }

  const { storageKey: _storageKey, ...cleanPayload } = minimizedPayload;
  void _storageKey;

  const evidence: VerificationEvidence = {
    ...cleanPayload,
    ...publishedQuarantineMeta,
    campaignId,
    uploadedAt: cleanPayload.uploadedAt ?? Date.now(),
  };

  const updated = await getCampaignDataSource().saveCampaign({
    ...campaign,
    verificationEvidence: [...(campaign.verificationEvidence ?? []), evidence],
    updatedAt: Date.now(),
  });
  return NextResponse.json(
    { data: updated.verificationEvidence?.at(-1) },
    { status: 201 }
  );
}
