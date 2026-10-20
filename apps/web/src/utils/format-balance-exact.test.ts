/**
 * Tests for exact amount formatting – issue #80
 *
 * Covers formatAmountExact and formatUnitsExact, verifying that
 * financial amounts are rendered without floating-point rounding errors.
 */

import { describe, expect, it } from "vitest";
import { formatAmountExact, formatUnitsExact } from "./format-balance";

// ---------------------------------------------------------------------------
// formatAmountExact
// ---------------------------------------------------------------------------

describe("formatAmountExact", () => {
  // Success cases ─────────────────────────────────────────────────────────

  it("formats integer zero as '0'", () => {
    expect(formatAmountExact("0")).toBe("0");
    expect(formatAmountExact("0.0000000")).toBe("0");
  });

  it("formats a simple integer with thousands separator", () => {
    expect(formatAmountExact("1000")).toBe("1,000");
    expect(formatAmountExact("1234567")).toBe("1,234,567");
  });

  it("strips trailing zeros but keeps at least 2 decimal places", () => {
    expect(formatAmountExact("100.5000000")).toBe("100.50");
    expect(formatAmountExact("100.5600000")).toBe("100.56");
    expect(formatAmountExact("100.5678900")).toBe("100.56789");
  });

  it("preserves all 7 decimal places when all are significant", () => {
    expect(formatAmountExact("0.0000001")).toBe("0.0000001");
    expect(formatAmountExact("9999999.9999999")).toBe("9,999,999.9999999");
  });

  it("rounds large raised/goal amounts correctly", () => {
    // The canonical Stellar maximum supply is 105 billion tokens.
    expect(formatAmountExact("100000000000.0000000")).toBe("100,000,000,000");
  });

  it("handles amounts that would lose precision with parseFloat", () => {
    // parseFloat("1234567.8900001") → 1234567.8900001 (may drift)
    // Our exact formatter must preserve the string representation.
    expect(formatAmountExact("1234567.8900000")).toBe("1,234,567.89");
    expect(formatAmountExact("1234567.8900001")).toBe("1,234,567.8900001");
  });

  it("formats negative amounts", () => {
    expect(formatAmountExact("-1000.50")).toBe("-1,000.50");
    expect(formatAmountExact("-0.0000001")).toBe("-0.0000001");
  });

  it("adds two decimal places when only one significant digit after dot", () => {
    expect(formatAmountExact("5.1")).toBe("5.10");
  });

  // Boundary / failure cases ───────────────────────────────────────────────

  it("returns '0' for empty string", () => {
    expect(formatAmountExact("")).toBe("0");
    expect(formatAmountExact("  ")).toBe("0");
  });

  it("returns '0' for non-numeric input", () => {
    expect(formatAmountExact("abc")).toBe("0");
    expect(formatAmountExact("1,000")).toBe("0"); // pre-formatted input is invalid
  });

  it("truncates fraction beyond 7 decimal places without error", () => {
    // Stellar amounts have at most 7 dp; extra digits should be silently dropped.
    expect(formatAmountExact("1.12345678")).toBe("1.1234567");
  });
});

// ---------------------------------------------------------------------------
// formatUnitsExact (bigint minor-unit formatter)
// ---------------------------------------------------------------------------

describe("formatUnitsExact", () => {
  it("formats zero minor units as '0'", () => {
    expect(formatUnitsExact(0n)).toBe("0");
  });

  it("formats 1 XLM (10_000_000 stroops)", () => {
    // Whole number of XLM has no fractional component → no decimal places
    expect(formatUnitsExact(10_000_000n)).toBe("1");
  });

  it("formats a typical balance", () => {
    // 1234567.89 XLM
    expect(formatUnitsExact(12_345_678_900_000n)).toBe("1,234,567.89");
  });

  it("formats maximum Stellar supply without overflow", () => {
    // 105_000_000_000 XLM = 1_050_000_000_000_000_000n stroops
    const max = 1_050_000_000_000_000_000n;
    const result = formatUnitsExact(max);
    expect(result).toBe("105,000,000,000");
  });

  it("formats amounts with all 7 significant decimal places", () => {
    expect(formatUnitsExact(1n)).toBe("0.0000001");
  });

  it("handles negative minor units", () => {
    // -1 XLM whole number → no decimal places
    expect(formatUnitsExact(-10_000_000n)).toBe("-1");
  });

  it("strips trailing zeros, keeps ≥ 2 decimal places", () => {
    // 50 500 000 = 5.05 XLM
    expect(formatUnitsExact(50_500_000n)).toBe("5.05");
    // 10 100 000 = 1.01 XLM
    expect(formatUnitsExact(10_100_000n)).toBe("1.01");
  });
});
