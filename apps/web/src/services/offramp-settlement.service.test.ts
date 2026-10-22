import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  OfframpSettlementService,
  QuoteExpiredError,
  InvalidSettlementStateError,
} from "./offramp-settlement.service";
import { SETTLEMENT_CONFIG } from "@/types/offramp";

describe("OfframpSettlementService Trust Boundaries", () => {
  let service: OfframpSettlementService;
  const baseTime = 1_700_000_000_000;

  beforeEach(() => {
    service = new OfframpSettlementService();
    vi.setSystemTime(baseTime);
  });

  // ==================== 1. QUOTE EXPIRY ====================

  describe("Quote Expiry & TTL Enforcement", () => {
    it("creates settlement when quote is within valid TTL window", () => {
      const expiresAt = new Date(baseTime + 300_000).toISOString(); // 5m in future
      const settlement = service.createSettlement(
        {
          transactionReference: "ref-valid-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 50,
          fiatAmount: 77500,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      expect(settlement.status).toBe("pending");
      expect(settlement.transactionReference).toBe("ref-valid-1");
    });

    it("rejects settlement creation when quote has expired", () => {
      const expiredAt = new Date(baseTime - 1_000).toISOString(); // 1s in past

      expect(() => {
        service.createSettlement(
          {
            transactionReference: "ref-expired-1",
            providerId: "cashwyre",
            walletAddress: "GABC123",
            token: "USDC",
            amount: 50,
            fiatAmount: 77500,
            currency: "NGN",
            bankCode: "044",
            accountNumber: "0123456789",
            quoteExpiresAt: expiredAt,
          },
          baseTime
        );
      }).toThrow(QuoteExpiredError);
    });

    it("evaluates boundary conditions for quote expiry exactly at timestamp", () => {
      const exactTime = new Date(baseTime).toISOString();
      expect(service.isQuoteExpired(exactTime, baseTime)).toBe(true);
      expect(service.isQuoteExpired(exactTime, baseTime - 1)).toBe(false);
      expect(service.isQuoteExpired(exactTime, baseTime + 1)).toBe(true);
    });
  });

  // ==================== 2. BRIDGE CONFIRMATION ====================

  describe("Bridge Confirmation", () => {
    it("confirms bridge transaction for pending settlement", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-confirm-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 100,
          fiatAmount: 155000,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      const confirmed = service.confirmBridgeTransaction(
        "ref-confirm-1",
        "stellar-tx-hash-001",
        baseTime + 5_000
      );

      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.bridgeTxHash).toBe("stellar-tx-hash-001");
    });

    it("rejects bridge confirmation if settlement is already in terminal state", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-terminal-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 100,
          fiatAmount: 155000,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      // Transition to completed via callback
      service.processProviderCallback({
        callbackId: "cb-initial",
        transactionReference: "ref-terminal-1",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(baseTime + 10_000).toISOString(),
      });

      expect(() => {
        service.confirmBridgeTransaction(
          "ref-terminal-1",
          "late-bridge-tx",
          baseTime + 20_000
        );
      }).toThrow(InvalidSettlementStateError);
    });
  });

  // ==================== 3. DUPLICATE CALLBACKS & IDEMPOTENCY ====================

  describe("Duplicate Callback Handling & Idempotency", () => {
    it("processes valid status transition on first callback", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-cb-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 25,
          fiatAmount: 38750,
          currency: "NGN",
          bankCode: "058",
          accountNumber: "9876543210",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      const result = service.processProviderCallback({
        callbackId: "event-001",
        transactionReference: "ref-cb-1",
        providerId: "cashwyre",
        status: "processing",
        timestamp: new Date(baseTime + 2_000).toISOString(),
      });

      expect(result.actionTaken).toBe("transitioned");
      expect(result.currentStatus).toBe("processing");
      expect(result.isDuplicate).toBe(false);
    });

    it("idempotently ignores exact duplicate callbackId without side effects", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-cb-2",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 25,
          fiatAmount: 38750,
          currency: "NGN",
          bankCode: "058",
          accountNumber: "9876543210",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      // First delivery
      const first = service.processProviderCallback({
        callbackId: "event-duplicate-test",
        transactionReference: "ref-cb-2",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(baseTime + 3_000).toISOString(),
      });
      expect(first.actionTaken).toBe("transitioned");
      expect(first.currentStatus).toBe("completed");

      // Duplicate delivery (retry of same callbackId)
      const second = service.processProviderCallback({
        callbackId: "event-duplicate-test",
        transactionReference: "ref-cb-2",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(baseTime + 4_000).toISOString(),
      });

      expect(second.actionTaken).toBe("duplicate_ignored");
      expect(second.isDuplicate).toBe(true);
      expect(second.currentStatus).toBe("completed");

      const record = service.getSettlement("ref-cb-2");
      expect(record?.processedCallbacks.length).toBe(1);
    });

    it("protects terminal completed state from being overwritten by delayed processing callbacks", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-cb-3",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 10,
          fiatAmount: 15500,
          currency: "NGN",
          bankCode: "058",
          accountNumber: "9876543210",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      // Fast completed callback arrives first
      service.processProviderCallback({
        callbackId: "event-completed",
        transactionReference: "ref-cb-3",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(baseTime + 1_000).toISOString(),
      });

      // Out-of-order delayed processing callback arrives later
      const outOfOrderResult = service.processProviderCallback({
        callbackId: "event-out-of-order",
        transactionReference: "ref-cb-3",
        providerId: "cashwyre",
        status: "processing",
        timestamp: new Date(baseTime + 2_000).toISOString(),
      });

      expect(outOfOrderResult.actionTaken).toBe("duplicate_ignored");
      expect(outOfOrderResult.currentStatus).toBe("completed");
      expect(service.getSettlement("ref-cb-3")?.status).toBe("completed");
    });
  });

  // ==================== 4. PROVIDER FAILURE BEHAVIOR ====================

  describe("Provider Failure Handling", () => {
    it("categorizes and records explicit provider failure with reason", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-fail-1",
          providerId: "autoramp",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 100,
          fiatAmount: 150000,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0000000000",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      const result = service.processProviderCallback({
        callbackId: "cb-fail-01",
        transactionReference: "ref-fail-1",
        providerId: "autoramp",
        status: "failed",
        failureCategory: "invalid_bank_details",
        message: "Destination account does not exist or is frozen",
        timestamp: new Date(baseTime + 5_000).toISOString(),
      });

      expect(result.actionTaken).toBe("transitioned");
      expect(result.currentStatus).toBe("failed");

      const record = service.getSettlement("ref-fail-1");
      expect(record?.failureCategory).toBe("invalid_bank_details");
      expect(record?.failureReason).toBe("Destination account does not exist or is frozen");
    });
  });

  // ==================== 5. TIMEOUT & DELAYED SETTLEMENT ====================

  describe("Timeout & Delayed Settlement Reconciliation", () => {
    it("flags settlement as delayed after threshold is exceeded", () => {
      const expiresAt = new Date(baseTime + 600_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-delay-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 200,
          fiatAmount: 310000,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      // Check immediately — not delayed
      const check1 = service.checkSettlementTimeout("ref-delay-1", baseTime + 10_000);
      expect(check1.isDelayed).toBe(false);
      expect(check1.isTimedOut).toBe(false);

      // Check after 6 minutes (exceeds DELAYED_SETTLEMENT_THRESHOLD_MS of 5 mins)
      const check2 = service.checkSettlementTimeout(
        "ref-delay-1",
        baseTime + SETTLEMENT_CONFIG.DELAYED_SETTLEMENT_THRESHOLD_MS + 1_000
      );
      expect(check2.isDelayed).toBe(true);
      expect(check2.isTimedOut).toBe(false);
      expect(check2.status).toBe("delayed");

      const delayedList = service.listDelayedSettlements(
        baseTime + SETTLEMENT_CONFIG.DELAYED_SETTLEMENT_THRESHOLD_MS + 1_000
      );
      expect(delayedList.length).toBe(1);
      expect(delayedList[0].transactionReference).toBe("ref-delay-1");
    });

    it("transitions settlement to timeout when bridge timeout SLA is breached", () => {
      const expiresAt = new Date(baseTime + 1_200_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-timeout-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 50,
          fiatAmount: 77500,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      // Check after 16 minutes (exceeds BRIDGE_TIMEOUT_MS of 15 mins)
      const timeoutCheck = service.checkSettlementTimeout(
        "ref-timeout-1",
        baseTime + SETTLEMENT_CONFIG.BRIDGE_TIMEOUT_MS + 1_000
      );

      expect(timeoutCheck.isTimedOut).toBe(true);
      expect(timeoutCheck.status).toBe("timeout");

      const record = service.getSettlement("ref-timeout-1");
      expect(record?.failureCategory).toBe("system_timeout");
    });

    it("reconciles a delayed settlement when late provider confirmation arrives", () => {
      const expiresAt = new Date(baseTime + 1_200_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-reconcile-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 50,
          fiatAmount: 77500,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      // Mark delayed
      service.checkSettlementTimeout(
        "ref-reconcile-1",
        baseTime + SETTLEMENT_CONFIG.DELAYED_SETTLEMENT_THRESHOLD_MS + 1_000
      );

      // Late callback arrives 10 minutes later
      const reconcileResult = service.processProviderCallback(
        {
          callbackId: "cb-late-completion",
          transactionReference: "ref-reconcile-1",
          providerId: "cashwyre",
          status: "completed",
          timestamp: new Date(baseTime + 600_000).toISOString(),
        },
        baseTime + 600_000
      );

      expect(reconcileResult.actionTaken).toBe("reconciled");
      expect(reconcileResult.previousStatus).toBe("delayed");
      expect(reconcileResult.currentStatus).toBe("completed");

      const record = service.getSettlement("ref-reconcile-1");
      expect(record?.status).toBe("completed");
      expect(record?.reconciledAt).toBeDefined();
    });

    it("reconciles settlement on-demand via authoritative provider lookup", async () => {
      const expiresAt = new Date(baseTime + 1_200_000).toISOString();
      service.createSettlement(
        {
          transactionReference: "ref-lookup-1",
          providerId: "cashwyre",
          walletAddress: "GABC123",
          token: "USDC",
          amount: 50,
          fiatAmount: 77500,
          currency: "NGN",
          bankCode: "044",
          accountNumber: "0123456789",
          quoteExpiresAt: expiresAt,
        },
        baseTime
      );

      const result = await service.reconcileSettlement(
        "ref-lookup-1",
        async () => ({
          status: "completed",
          message: "Authoritatively confirmed via bank settlement API",
        }),
        baseTime + 400_000
      );

      expect(result.actionTaken).toBe("reconciled");
      expect(result.currentStatus).toBe("completed");
      expect(service.getSettlement("ref-lookup-1")?.reconciledAt).toBeDefined();
    });
  });
});
