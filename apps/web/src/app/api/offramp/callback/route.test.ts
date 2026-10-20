import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { offrampSettlementService } from "@/services/offramp-settlement.service";

describe("POST /api/offramp/callback API Route", () => {
  beforeEach(() => {
    offrampSettlementService.clear();
  });

  it("returns 400 when callback body is invalid", async () => {
    const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
      method: "POST",
      body: JSON.stringify({ invalid: true }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toBe("Invalid callback payload");
  });

  it("successfully processes provider callback for active settlement", async () => {
    // Setup settlement
    offrampSettlementService.createSettlement({
      transactionReference: "tx-ref-api-1",
      providerId: "cashwyre",
      walletAddress: "GABC123",
      token: "USDC",
      amount: 100,
      fiatAmount: 155000,
      currency: "NGN",
      bankCode: "044",
      accountNumber: "0123456789",
      quoteExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
      method: "POST",
      body: JSON.stringify({
        callbackId: "cb-api-001",
        transactionReference: "tx-ref-api-1",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date().toISOString(),
      }),
    });

    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.actionTaken).toBe("transitioned");
    expect(json.data.currentStatus).toBe("completed");
  });

  it("handles duplicate callbacks idempotently over HTTP API", async () => {
    offrampSettlementService.createSettlement({
      transactionReference: "tx-ref-api-2",
      providerId: "cashwyre",
      walletAddress: "GABC123",
      token: "USDC",
      amount: 50,
      fiatAmount: 77500,
      currency: "NGN",
      bankCode: "044",
      accountNumber: "0123456789",
      quoteExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const body = {
      callbackId: "cb-api-replay",
      transactionReference: "tx-ref-api-2",
      providerId: "cashwyre",
      status: "completed",
      timestamp: new Date().toISOString(),
    };

    // First call
    const res1 = await POST(
      new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
    const json1 = await res1.json();
    expect(json1.data.actionTaken).toBe("transitioned");

    // Replay duplicate call
    const res2 = await POST(
      new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
    const json2 = await res2.json();
    expect(json2.status).toBe(undefined); // response was 200
    expect(json2.success).toBe(true);
    expect(json2.data.actionTaken).toBe("duplicate_ignored");
    expect(json2.data.isDuplicate).toBe(true);
  });
});
