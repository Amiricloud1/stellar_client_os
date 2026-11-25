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

  // ==================== VALIDATION TESTS (ISSUE #279) ====================

  describe("Callback Validation Security", () => {
    const TEST_SECRET = "test-webhook-secret-key";

    beforeEach(() => {
      vi.stubEnv("OFFRAMP_WEBHOOK_SECRET", TEST_SECRET);
      vi.stubEnv("NEXT_PUBLIC_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
      vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "testnet");
      offrampSettlementService.clear();
    });

    it("rejects callback with invalid HMAC signature (origin validation)", async () => {
      offrampSettlementService.createSettlement({
        transactionReference: "tx-sig-test",
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

      const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify({
          callbackId: "cb-invalid-sig",
          transactionReference: "tx-sig-test",
          providerId: "cashwyre",
          status: "completed",
          timestamp: new Date().toISOString(),
          signature: "invalid-signature-12345",
        }),
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(401);
      expect(json.success).toBe(false);
      expect(json.code).toBe("INVALID_SIGNATURE");
    });

    it("rejects callback with expired timestamp (replay attack)", async () => {
      offrampSettlementService.createSettlement({
        transactionReference: "tx-replay-test",
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

      // Timestamp from 10 minutes ago
      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify({
          callbackId: "cb-replay-attack",
          transactionReference: "tx-replay-test",
          providerId: "cashwyre",
          status: "completed",
          timestamp: oldTimestamp,
        }),
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.code).toBe("CALLBACK_EXPIRED");
      expect(json.error).toContain("too old");
    });

    it("rejects callback from wrong network (cross-network attack)", async () => {
      vi.stubEnv("NODE_ENV", "production");

      offrampSettlementService.createSettlement({
        transactionReference: "tx-network-test",
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

      const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify({
          callbackId: "cb-wrong-network",
          transactionReference: "tx-network-test",
          providerId: "cashwyre",
          status: "completed",
          timestamp: new Date().toISOString(),
          networkPassphrase: "Public Global Stellar Network ; September 2015", // Wrong network!
        }),
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.success).toBe(false);
      expect(json.code).toBe("NETWORK_MISMATCH");
    });

    it("rejects invalid state transition (state validation)", async () => {
      offrampSettlementService.createSettlement({
        transactionReference: "tx-state-test",
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

      // Try to go directly from pending to completed (invalid)
      const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify({
          callbackId: "cb-invalid-state",
          transactionReference: "tx-state-test",
          providerId: "cashwyre",
          status: "completed",
          timestamp: new Date().toISOString(),
        }),
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.success).toBe(false);
      expect(json.code).toBe("INVALID_STATE_TRANSITION");
    });

    it("accepts callback with valid signature and all validations pass", async () => {
      offrampSettlementService.createSettlement({
        transactionReference: "tx-valid-all",
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

      // First transition to processing
      await POST(
        new NextRequest("http://localhost:3000/api/offramp/callback", {
          method: "POST",
          body: JSON.stringify({
            callbackId: "cb-step-1",
            transactionReference: "tx-valid-all",
            providerId: "cashwyre",
            status: "processing",
            timestamp: new Date().toISOString(),
            networkPassphrase: "Test SDF Network ; September 2015",
            network: "testnet",
          }),
        })
      );

      // Then to completed with valid signature
      const payload = {
        callbackId: "cb-valid-sig",
        transactionReference: "tx-valid-all",
        providerId: "cashwyre",
        status: "completed" as const,
        timestamp: new Date().toISOString(),
      };

      const req = new NextRequest("http://localhost:3000/api/offramp/callback", {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          networkPassphrase: "Test SDF Network ; September 2015",
          network: "testnet",
        }),
      });

      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data.currentStatus).toBe("completed");
    });
  });
});
