import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { offrampSettlementService } from "@/services/offramp-settlement.service";
import { CallbackValidationError } from "@/lib/callback-validation";
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
  networkPassphrase: z.string().optional(),
  network: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * POST /api/offramp/callback
 *
 * Webhook/callback endpoint for offramp payout providers (Cashwyre, AutoRamp).
 * Idempotently processes status updates and deduplicates replays.
 * 
 * Security (Issue #279):
 * - Origin Validation: HMAC signature verification
 * - State Validation: Validates allowed state transitions
 * - Expiry Validation: Rejects callbacks older than 5 minutes
 * - Network Validation: Ensures callback matches configured Stellar network
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

    // Process callback with comprehensive validation (origin, state, expiry, network)
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
      networkPassphrase: payload.networkPassphrase,
      network: payload.network,
      metadata: payload.metadata,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err: unknown) {
    // Handle validation errors with appropriate HTTP status codes
    if (err instanceof CallbackValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: err.message,
          code: err.code,
        },
        { status: err.httpStatus }
      );
    }

    const message = err instanceof Error ? err.message : "Internal callback error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
