import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ALLOWED_CONTENT_TYPES,
  buildQuarantineEvidenceKey,
  createPresignedPutUrl,
  loadS3Config,
  type AllowedContentType,
} from "@/lib/s3";
import { getEvidenceQuarantineService } from "@/services/evidence-quarantine.service";

/**
 * POST /api/presign-upload
 *
 * Generates a short-lived pre-signed AWS S3 PUT URL inside the private
 * quarantine namespace for milestone proof photo or insurance claim evidence.
 * Uploaded objects remain quarantined and non-publishable until security
 * scanning completes cleanly.
 *
 * Request body:
 *   { "campaignId": "42", "milestoneId": "1", "contentType": "image/jpeg", "purpose": "milestone" }
 *
 * Response 200:
 *   { "url": "...", "key": "quarantine/evidence/...", "quarantineId": "...", "scanStatus": "quarantined", ... }
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const schema = z.object({
    campaignId: z
      .string()
      .min(1, "campaignId is required")
      .max(128, "campaignId is too long"),
    milestoneId: z
      .string()
      .min(1, "milestoneId is required")
      .max(128, "milestoneId is too long"),
    contentType: z.enum(ALLOWED_CONTENT_TYPES),
    purpose: z.enum(["milestone", "insurance-claim"]).default("milestone"),
    uploaderId: z.string().trim().min(1).max(256).optional(),
  });

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return NextResponse.json({ error: message }, { status: 400 });
  }

  let config;
  try {
    config = loadS3Config();
  } catch (error) {
    console.error("[presign-upload] S3 configuration error", error);
    return NextResponse.json(
      { error: "S3 uploads are not configured" },
      { status: 503 }
    );
  }

  try {
    const milestoneScope =
      parsed.data.purpose === "insurance-claim"
        ? "insurance-claim"
        : parsed.data.milestoneId;
    const contentType = parsed.data.contentType as AllowedContentType;
    const key = buildQuarantineEvidenceKey(
      parsed.data.campaignId,
      milestoneScope,
      contentType
    );
    const result = createPresignedPutUrl(config, {
      key,
      contentType,
    });
    const uploaderId =
      parsed.data.uploaderId ??
      req.headers.get("x-actor-id")?.trim() ??
      "anonymous-uploader";
    const quarantine = getEvidenceQuarantineService().registerUpload({
      campaignId: parsed.data.campaignId,
      milestoneId: milestoneScope,
      uploaderId,
      quarantineKey: key,
      contentType,
    });

    return NextResponse.json({
      url: result.url,
      key: result.key,
      contentType: result.contentType,
      expiresAt: result.expiresAt,
      requestId: result.requestId,
      purpose: parsed.data.purpose,
      quarantineId: quarantine.id,
      scanStatus: quarantine.status,
      recoveryAction: quarantine.recoveryAction,
    });
  } catch (error) {
    console.error("[presign-upload] presigning error", error);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 }
    );
  }
}
