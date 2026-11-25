import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  validateCallbackSignature,
  validateCallbackTimestamp,
  validateStateTransition,
  validateCallbackNetwork,
  validateCallback,
  generateCallbackSignature,
  CallbackValidationError,
  CALLBACK_VALIDATION_CONFIG,
  type CallbackWithNetwork,
} from "./callback-validation";
import type { PayoutStatus, ProviderCallbackPayload } from "@/types/offramp";

describe("callback-validation", () => {
  const TEST_SECRET = "test-webhook-secret-key";
  const TEST_NETWORK = "Test SDF Network ; September 2015";

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("OFFRAMP_WEBHOOK_SECRET", TEST_SECRET);
    vi.stubEnv("NEXT_PUBLIC_NETWORK_PASSPHRASE", TEST_NETWORK);
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "testnet");
  });

  describe("validateCallbackSignature", () => {
    it("validates a correct HMAC signature", () => {
      const payload: ProviderCallbackPayload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const signature = generateCallbackSignature(payload, TEST_SECRET);
      const result = validateCallbackSignature(payload, signature, TEST_SECRET);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("rejects an invalid signature", () => {
      const payload: ProviderCallbackPayload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const result = validateCallbackSignature(payload, "invalid-signature", TEST_SECRET);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("INVALID_SIGNATURE");
      expect(result.error?.httpStatus).toBe(401);
    });

    it("rejects a signature with tampered payload", () => {
      const payload: ProviderCallbackPayload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const signature = generateCallbackSignature(payload, TEST_SECRET);

      // Tamper with the payload
      const tamperedPayload = { ...payload, status: "failed" as PayoutStatus };
      const result = validateCallbackSignature(tamperedPayload, signature, TEST_SECRET);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("INVALID_SIGNATURE");
    });

    it("requires signature in production mode", () => {
      vi.stubEnv("NODE_ENV", "production");

      const payload: ProviderCallbackPayload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const result = validateCallbackSignature(payload, undefined, TEST_SECRET);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("MISSING_SIGNATURE");
      expect(result.error?.httpStatus).toBe(401);
    });

    it("allows unsigned callbacks in non-production mode", () => {
      const payload: ProviderCallbackPayload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const result = validateCallbackSignature(payload, undefined, TEST_SECRET);

      expect(result.valid).toBe(true);
    });

    it("uses timing-safe comparison to prevent timing attacks", () => {
      const payload: ProviderCallbackPayload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const correctSignature = generateCallbackSignature(payload, TEST_SECRET);
      
      // Create a signature that differs by one character
      const wrongSignature = correctSignature.substring(0, correctSignature.length - 1) + "a";
      
      const result = validateCallbackSignature(payload, wrongSignature, TEST_SECRET);

      expect(result.valid).toBe(false);
    });
  });

  describe("validateCallbackTimestamp", () => {
    it("accepts a recent timestamp", () => {
      const now = Date.now();
      const timestamp = new Date(now - 60 * 1000).toISOString(); // 1 minute ago

      const result = validateCallbackTimestamp(timestamp, now);

      expect(result.valid).toBe(true);
    });

    it("rejects a timestamp older than MAX_CALLBACK_AGE_MS (replay attack)", () => {
      const now = Date.now();
      const oldTimestamp = new Date(now - 10 * 60 * 1000).toISOString(); // 10 minutes ago

      const result = validateCallbackTimestamp(oldTimestamp, now);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("CALLBACK_EXPIRED");
      expect(result.error?.message).toContain("too old");
    });

    it("rejects a timestamp from the future beyond clock skew tolerance", () => {
      const now = Date.now();
      const futureTimestamp = new Date(now + 60 * 1000).toISOString(); // 1 minute in future

      const result = validateCallbackTimestamp(futureTimestamp, now);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("CALLBACK_FROM_FUTURE");
    });

    it("accepts a timestamp slightly in the future within clock skew tolerance", () => {
      const now = Date.now();
      const nearFutureTimestamp = new Date(now + 15 * 1000).toISOString(); // 15 seconds in future

      const result = validateCallbackTimestamp(nearFutureTimestamp, now);

      expect(result.valid).toBe(true);
    });

    it("rejects missing timestamp", () => {
      const result = validateCallbackTimestamp(undefined, Date.now());

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("MISSING_TIMESTAMP");
    });

    it("rejects invalid timestamp format", () => {
      const result = validateCallbackTimestamp("not-a-date", Date.now());

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("INVALID_TIMESTAMP");
    });
  });

  describe("validateStateTransition", () => {
    it("allows valid state transitions", () => {
      const validTransitions: Array<[PayoutStatus, PayoutStatus]> = [
        ["pending", "processing"],
        ["pending", "confirmed"],
        ["confirmed", "processing"],
        ["processing", "completed"],
        ["processing", "failed"],
        ["processing", "delayed"],
        ["delayed", "completed"],
        ["timeout", "failed"],
      ];

      validTransitions.forEach(([from, to]) => {
        const result = validateStateTransition(from, to);
        expect(result.valid).toBe(true);
      });
    });

    it("rejects invalid state transitions", () => {
      const invalidTransitions: Array<[PayoutStatus, PayoutStatus]> = [
        ["pending", "completed"], // Cannot skip to completed
        ["confirmed", "expired"], // Cannot go back to expired
        ["processing", "pending"], // Cannot go backwards
        ["delayed", "pending"], // Cannot go backwards
      ];

      invalidTransitions.forEach(([from, to]) => {
        const result = validateStateTransition(from, to);
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe("INVALID_STATE_TRANSITION");
      });
    });

    it("allows same-state transitions (idempotent)", () => {
      const states: PayoutStatus[] = ["pending", "processing", "completed"];

      states.forEach((status) => {
        const result = validateStateTransition(status, status);
        expect(result.valid).toBe(true);
      });
    });

    it("rejects transitions from terminal states", () => {
      const terminalStates: PayoutStatus[] = ["completed", "failed", "expired"];

      terminalStates.forEach((terminal) => {
        const result = validateStateTransition(terminal, "processing");
        expect(result.valid).toBe(false);
        expect(result.error?.code).toBe("INVALID_STATE_TRANSITION");
        expect(result.error?.message).toContain("terminal state");
      });
    });

    it("allows duplicate callbacks of same terminal state", () => {
      const result = validateStateTransition("completed", "completed");
      expect(result.valid).toBe(true);
    });
  });

  describe("validateCallbackNetwork", () => {
    it("accepts callback with matching network passphrase", () => {
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
        networkPassphrase: TEST_NETWORK,
      };

      const result = validateCallbackNetwork(payload, TEST_NETWORK);

      expect(result.valid).toBe(true);
    });

    it("rejects callback with wrong network passphrase (cross-network attack)", () => {
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      };

      const result = validateCallbackNetwork(payload, TEST_NETWORK);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("NETWORK_MISMATCH");
      expect(result.error?.message).toContain("does not match");
    });

    it("accepts callback with matching network name", () => {
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
        network: "testnet",
      };

      const result = validateCallbackNetwork(payload);

      expect(result.valid).toBe(true);
    });

    it("rejects callback with wrong network name", () => {
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
        network: "mainnet",
      };

      const result = validateCallbackNetwork(payload);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("NETWORK_MISMATCH");
    });

    it("requires network information in production mode", () => {
      vi.stubEnv("NODE_ENV", "production");

      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const result = validateCallbackNetwork(payload);

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("MISSING_NETWORK");
    });

    it("allows missing network in non-production mode", () => {
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const result = validateCallbackNetwork(payload);

      expect(result.valid).toBe(true);
    });
  });

  describe("validateCallback (comprehensive)", () => {
    it("validates a complete, valid callback", () => {
      const now = Date.now();
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(now - 30 * 1000).toISOString(),
        networkPassphrase: TEST_NETWORK,
        network: "testnet",
      };

      const signature = generateCallbackSignature(payload, TEST_SECRET);
      payload.signature = signature;

      const result = validateCallback(payload, "processing", {
        webhookSecret: TEST_SECRET,
        now,
      });

      expect(result.valid).toBe(true);
    });

    it("rejects callback with invalid signature", () => {
      const now = Date.now();
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(now - 30 * 1000).toISOString(),
        signature: "invalid-signature",
        networkPassphrase: TEST_NETWORK,
      };

      const result = validateCallback(payload, "processing", {
        webhookSecret: TEST_SECRET,
        now,
      });

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("INVALID_SIGNATURE");
    });

    it("rejects callback with expired timestamp (replay attack)", () => {
      const now = Date.now();
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(now - 10 * 60 * 1000).toISOString(), // 10 minutes old
        networkPassphrase: TEST_NETWORK,
      };

      const signature = generateCallbackSignature(payload, TEST_SECRET);
      payload.signature = signature;

      const result = validateCallback(payload, "processing", {
        webhookSecret: TEST_SECRET,
        now,
      });

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("CALLBACK_EXPIRED");
    });

    it("rejects callback with wrong network (cross-network attack)", () => {
      const now = Date.now();
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: new Date(now - 30 * 1000).toISOString(),
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      };

      const signature = generateCallbackSignature(payload, TEST_SECRET);
      payload.signature = signature;

      const result = validateCallback(payload, "processing", {
        webhookSecret: TEST_SECRET,
        now,
      });

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("NETWORK_MISMATCH");
    });

    it("rejects callback with invalid state transition", () => {
      const now = Date.now();
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "processing",
        timestamp: new Date(now - 30 * 1000).toISOString(),
        networkPassphrase: TEST_NETWORK,
      };

      const signature = generateCallbackSignature(payload, TEST_SECRET);
      payload.signature = signature;

      const result = validateCallback(payload, "completed", {
        webhookSecret: TEST_SECRET,
        now,
      });

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("INVALID_STATE_TRANSITION");
    });

    it("allows skipping individual validation checks", () => {
      const payload: CallbackWithNetwork = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed",
        timestamp: "invalid-timestamp",
        signature: "invalid-signature",
      };

      const result = validateCallback(payload, undefined, {
        skipSignature: true,
        skipTimestamp: true,
        skipNetwork: true,
      });

      expect(result.valid).toBe(true);
    });
  });

  describe("generateCallbackSignature", () => {
    it("generates consistent signatures for the same payload", () => {
      const payload = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed" as PayoutStatus,
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const sig1 = generateCallbackSignature(payload, TEST_SECRET);
      const sig2 = generateCallbackSignature(payload, TEST_SECRET);

      expect(sig1).toBe(sig2);
      expect(sig1).toHaveLength(64); // SHA-256 hex is 64 characters
    });

    it("generates different signatures for different payloads", () => {
      const payload1 = {
        callbackId: "cb-001",
        transactionReference: "tx-001",
        providerId: "cashwyre",
        status: "completed" as PayoutStatus,
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      const payload2 = { ...payload1, callbackId: "cb-002" };

      const sig1 = generateCallbackSignature(payload1, TEST_SECRET);
      const sig2 = generateCallbackSignature(payload2, TEST_SECRET);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe("CallbackValidationError", () => {
    it("creates error with correct properties", () => {
      const error = new CallbackValidationError("Test message", "TEST_CODE", 403);

      expect(error.message).toBe("Test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.httpStatus).toBe(403);
      expect(error.name).toBe("CallbackValidationError");
    });

    it("defaults to 400 status code", () => {
      const error = new CallbackValidationError("Test message", "TEST_CODE");

      expect(error.httpStatus).toBe(400);
    });
  });
});
