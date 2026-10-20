import { describe, it, expect } from "vitest";
import { normalizeError, redactSensitive } from "../utils/normalizeError.js";

const SECRET = "S" + "A".repeat(55);
const XDR = "AAAA".repeat(30);

describe("normalizeError", () => {
  it("maps contract errors to CONTRACT_ERROR with numeric code", () => {
    const n = normalizeError(new Error("HostError: Error(Contract, #41)"));
    expect(n).toMatchObject({ category: "contract", code: "CONTRACT_ERROR", contractCode: 41, retryable: false });
  });

  it("classifies wallet rejections as non-retryable", () => {
    const n = normalizeError(new Error("User declined access"));
    expect(n.code).toBe("WALLET_REJECTED");
    expect(n.category).toBe("wallet");
    expect(n.retryable).toBe(false);
  });

  it("classifies wallet not connected and unavailable", () => {
    expect(normalizeError("Wallet not connected").code).toBe("WALLET_NOT_CONNECTED");
    expect(normalizeError("Freighter is not installed").code).toBe("WALLET_UNAVAILABLE");
  });

  it("uses HTTP status for RPC rate limiting and outages", () => {
    expect(normalizeError({ message: "nope", status: 429 })).toMatchObject({ code: "RPC_RATE_LIMITED", retryable: true });
    expect(normalizeError({ message: "nope", response: { status: 503 } })).toMatchObject({ code: "RPC_UNAVAILABLE", retryable: true });
  });

  it("classifies simulation failures and restore requirements", () => {
    expect(normalizeError("simulation failed: trap").code).toBe("SIMULATION_FAILED");
    expect(normalizeError("simulation returned restorePreamble").code).toBe("SIMULATION_RESTORE_REQUIRED");
  });

  it("classifies network timeouts as retryable", () => {
    expect(normalizeError(new Error("ETIMEDOUT"))).toMatchObject({ code: "NETWORK_TIMEOUT", retryable: true });
    expect(normalizeError(new Error("Failed to fetch")).code).toBe("NETWORK_ERROR");
  });

  it("handles malformed provider responses without throwing", () => {
    expect(normalizeError(new SyntaxError("Unexpected token < in JSON")).code).toBe("RPC_BAD_RESPONSE");
    expect(normalizeError(undefined)).toMatchObject({ code: "UNKNOWN", message: "Unknown error" });
    expect(normalizeError(null).code).toBe("UNKNOWN");
    expect(normalizeError(42).code).toBe("UNKNOWN");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => normalizeError(circular)).not.toThrow();
  });

  it("reads codes from the cause chain", () => {
    const err = new Error("wrapped", { cause: new Error("Error(Contract, #7)") });
    expect(normalizeError(err)).toMatchObject({ code: "CONTRACT_ERROR", contractCode: 7 });
  });

  it("never leaks secret seeds or signed XDR", () => {
    const n = normalizeError(new Error(`failed for ${SECRET} envelope ${XDR}`, { cause: XDR }));
    const serialized = JSON.stringify(n);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(XDR);
    expect(n.message).toContain("[REDACTED_SECRET]");
    expect(n.message).toContain("[REDACTED_XDR]");
  });

  it("truncates very long messages", () => {
    expect(redactSensitive("x ".repeat(1000)).length).toBeLessThanOrEqual(501);
  });
});
