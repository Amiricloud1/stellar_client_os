import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { offrampSettlementService } from "@/services/offramp-settlement.service";
import type { PayoutStatus } from "@/types/offramp";

const ReconcileRequestSchema = z.object({
  transactionReference: z.string().min(1, "transactionReference is required"),
  targetStatus: z
    .enum(["completed", "failed", "processing", "timeout"])
    .default("completed"),
  message: z.string().optional(),
});

/**
 * GET /api/offramp/reconcile
 *
 * Lists all delayed or timed-out settlements requiring operator/system attention.
 */
export async function GET() {
  const delayed = offrampSettlementService.listDelayedSettlements();
  return NextResponse.json({
    success: true,
    data: {
      delayedCount: delayed.length,
      delayedSettlements: delayed,
    },
  });
}

/**
 * POST /api/offramp/reconcile
 *
 * Manually or automatically reconciles a delayed settlement.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parseResult = ReconcileRequestSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { success: false, error: "Validation failed", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { transactionReference, targetStatus, message } = parseResult.data;

    const result = await offrampSettlementService.reconcileSettlement(
      transactionReference,
      async () => ({
        status: targetStatus as PayoutStatus,
        message: message || `Manually reconciled to ${targetStatus}`,
      })
    );

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Reconciliation failed";
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }
}
