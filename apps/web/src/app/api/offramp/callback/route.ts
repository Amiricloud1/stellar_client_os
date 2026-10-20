import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { offrampSettlementService } from "@/services/offramp-settlement.service";
import type { PayoutStatus, SettlementFailureCategory } from "@/types/offramp";

const CallbackSchema = z.object({
  callbackId: z.string().min(1, "callbackId is required"),
  transactionReference: z.string().min(1, "transactionReference is required"),
  providerId: z.string().min(1, "providerId is required"),
  status: z.enum([
    "pending",
    "processing",
    "confirmed",
    "completed",
    "failed",
    "expired",
    "timeout",
    "delayed",
  ]),
  providerStatus: z.string().optional(),
  message: z.string().optional(),
  failureCategory: z
    .enum([
      "quote_expired",
      "bridge_timeout",
      "provider_rejected",
      "provider_transient_error",
      "compliance_hold",
      "insufficient_liquidity",
      "invalid_bank_details",
      "system_timeout",
    ])
    .optional(),
  timestamp: z.string().optional(),
  signature: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * POST /api/offramp/callback
 *
 * Webhook/callback endpoint for offramp payout providers (Cashwyre, AutoRamp).
 * Idempotently processes status updates and deduplicates replays.
 */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json();
    const parseResult = CallbackSchema.safeParse(rawBody);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid callback payload",
          details: parseResult.error.flatten(),
        },
        { status: 400 }
      );
    }

    const payload = parseResult.data;

    const result = offrampSettlementService.processProviderCallback({
      callbackId: payload.callbackId,
      transactionReference: payload.transactionReference,
      providerId: payload.providerId,
      status: payload.status as PayoutStatus,
      providerStatus: payload.providerStatus,
      message: payload.message,
      failureCategory: payload.failureCategory as SettlementFailureCategory | undefined,
      timestamp: payload.timestamp || new Date().toISOString(),
      signature: payload.signature,
      metadata: payload.metadata,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal callback error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
