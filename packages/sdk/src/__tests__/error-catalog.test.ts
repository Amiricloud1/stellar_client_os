import { describe, it, expect } from "vitest";
import { ERROR_CATALOG, lookupContractError } from "../utils/error-catalog.js";
import catalogData from "../utils/error-catalog.json";

describe("Error Catalog & Mapping (Issue #39)", () => {
  it("loads error catalog metadata successfully", () => {
    expect(catalogData.version).toBe("1.0.0");
    expect(catalogData.contracts).toBeDefined();
    expect(catalogData.contracts["payment-stream"]).toBeDefined();
    expect(catalogData.contracts["distributor"]).toBeDefined();
    expect(catalogData.contracts["campaign-funding"]).toBeDefined();
  });

  it("maps payment stream error codes to stable descriptions", () => {
    const err1 = lookupContractError(1, "payment-stream");
    expect(err1.name).toBe("AlreadyInitialized");
    expect(err1.retryable).toBe(false);

    const err10 = lookupContractError(10, "payment-stream");
    expect(err10.name).toBe("InsufficientWithdrawable");
    expect(err10.retryable).toBe(true);

    const err17 = lookupContractError(17, "payment-stream");
    expect(err17.name).toBe("ContractPaused");
  });

  it("maps campaign funding error codes correctly", () => {
    const err39 = lookupContractError(39, "campaign-funding");
    expect(err39.name).toBe("EscrowAlreadyInitialized");
    expect(err39.retryable).toBe(false);

    const err43 = lookupContractError(43, "campaign-funding");
    expect(err43.name).toBe("EscrowDisputed");
    expect(err43.retryable).toBe(true);
  });

  it("handles fallback lookup across contracts when contract name is omitted", () => {
    const err = lookupContractError(10);
    expect(err.name).toBe("InsufficientWithdrawable");
    expect(err.code).toBe(10);
  });

  it("returns stable unknown error object for non-existent codes", () => {
    const unknownErr = lookupContractError(9999);
    expect(unknownErr.name).toBe("UnknownContractError");
    expect(unknownErr.code).toBe(9999);
    expect(unknownErr.retryable).toBe(false);
  });
});
