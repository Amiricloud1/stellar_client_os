import { describe, expect, it } from "vitest";
import {
  formatAssetAmount,
  formatCurrencyAmount,
  formatLocaleDate,
  formatUtcDate,
  formatRelativeTime,
  getLocaleSeparators,
  minorUnitsToNumber,
  normalizeLocale,
  parseDateInput,
} from "./formatters";

describe("Locale-Aware Formatters (Issue #77)", () => {
  describe("normalizeLocale", () => {
    it("returns default locale for undefined, null, or empty string", () => {
      expect(normalizeLocale()).toBe("en-US");
      expect(normalizeLocale("")).toBe("en-US");
      expect(normalizeLocale("   ")).toBe("en-US");
    });

    it("accepts valid BCP-47 locale tags", () => {
      expect(normalizeLocale("de-DE")).toBe("de-DE");
      expect(normalizeLocale("fr-FR")).toBe("fr-FR");
      expect(normalizeLocale("es-ES")).toBe("es-ES");
    });

    it("falls back gracefully for absent/invalid translations", () => {
      expect(normalizeLocale("invalid-nonexistent-locale-12345")).toBe("en-US");
    });
  });

  describe("getLocaleSeparators", () => {
    it("returns correct separators for en-US", () => {
      const { decimal, group } = getLocaleSeparators("en-US");
      expect(decimal).toBe(".");
      expect(group).toBe(",");
    });

    it("returns correct separators for de-DE", () => {
      const { decimal, group } = getLocaleSeparators("de-DE");
      expect(decimal).toBe(",");
      expect(group).toBe(".");
    });

    it("returns correct separators for fr-FR", () => {
      const { decimal } = getLocaleSeparators("fr-FR");
      expect(decimal).toBe(",");
    });
  });

  describe("formatAssetAmount — precision and locales", () => {
    it("formats XLM with default 2 display decimals and suffix symbol", () => {
      const result = formatAssetAmount(1234.5678, { asset: "XLM", locale: "en-US" });
      expect(result).toBe("1,234.57 XLM");
    });

    it("respects custom maxFractionDigits for full Stellar 7-decimal precision", () => {
      const result = formatAssetAmount(1234.5678901, {
        asset: "XLM",
        locale: "en-US",
        minFractionDigits: 7,
        maxFractionDigits: 7,
      });
      expect(result).toBe("1,234.5678901 XLM");
    });

    it("formats with European locale separators (de-DE)", () => {
      const result = formatAssetAmount(1234567.89, { asset: "XLM", locale: "de-DE" });
      expect(result).toBe("1.234.567,89 XLM");
    });

    it("formats USDC with prefix currency symbol", () => {
      const result = formatAssetAmount(5000, { asset: "USDC", locale: "en-US" });
      expect(result).toBe("$5,000.00");
    });

    it("formats EURC with Euro symbol", () => {
      const result = formatAssetAmount(2500.5, { asset: "EURC", locale: "de-DE" });
      expect(result).toBe("€2.500,50");
    });

    it("formats Carbon credits (tCO2e)", () => {
      const result = formatAssetAmount(150.25, { asset: "CARBON", locale: "en-US" });
      expect(result).toBe("150.25 tCO2e");
    });

    it("converts minor units (stroops = 10^-7 XLM) correctly", () => {
      const stroops = 10_000_000n; // 1 XLM
      expect(minorUnitsToNumber(stroops, 7)).toBe(1);

      const formatted = formatAssetAmount(stroops, {
        asset: "XLM",
        isMinorUnits: true,
        locale: "en-US",
      });
      expect(formatted).toBe("1.00 XLM");
    });

    it("converts fractional minor units with high precision", () => {
      const stroops = 12_345_678n; // 1.2345678 XLM
      const formatted = formatAssetAmount(stroops, {
        asset: "XLM",
        isMinorUnits: true,
        maxFractionDigits: 7,
        locale: "en-US",
      });
      expect(formatted).toBe("1.2345678 XLM");
    });

    it("handles zero, null, undefined and negative values gracefully", () => {
      expect(formatAssetAmount(0, { asset: "XLM", locale: "en-US" })).toBe("0.00 XLM");
      expect(formatAssetAmount(null, { asset: "XLM" })).toBe("0.00");
      expect(formatAssetAmount(undefined, { asset: "XLM" })).toBe("0.00");
      expect(formatAssetAmount(-150.5, { asset: "XLM", locale: "en-US" })).toBe("-150.50 XLM");
    });

    it("supports trimTrailingZeros option", () => {
      const result = formatAssetAmount(1234.5, {
        asset: "XLM",
        locale: "en-US",
        trimTrailingZeros: true,
        minFractionDigits: 0,
      });
      expect(result).toBe("1,234.5 XLM");
    });
  });

  describe("formatCurrencyAmount convenience helper", () => {
    it("formats USD currency amounts by default", () => {
      expect(formatCurrencyAmount(199.99, "USD", { locale: "en-US" })).toBe("$199.99");
    });

    it("formats EUR in French locale", () => {
      const formatted = formatCurrencyAmount(1250, "EUR", { locale: "fr-FR" });
      expect(formatted).toContain("1");
      expect(formatted).toContain("250");
      expect(formatted).toContain("€");
    });
  });

  describe("Date & Time Formatting with UTC Handling", () => {
    const fixedTimestampMs = 1718445600000; // 2024-06-15T10:00:00.000Z

    it("parses Unix timestamp in seconds or milliseconds", () => {
      const dateFromMs = parseDateInput(fixedTimestampMs);
      expect(dateFromMs?.toISOString()).toBe("2024-06-15T10:00:00.000Z");

      const dateFromSec = parseDateInput(fixedTimestampMs / 1000);
      expect(dateFromSec?.toISOString()).toBe("2024-06-15T10:00:00.000Z");
    });

    it("formats UTC date consistently regardless of local environment", () => {
      const formatted = formatUtcDate(fixedTimestampMs, {
        locale: "en-US",
        dateStyle: "medium",
      });
      expect(formatted).toBe("Jun 15, 2024");
    });

    it("formats UTC date with time", () => {
      const formatted = formatUtcDate(fixedTimestampMs, {
        locale: "en-US",
        dateStyle: "short",
        timeStyle: "short",
      });
      expect(formatted).toContain("6/15/24");
      expect(formatted).toContain("10:00");
    });

    it("formats date for de-DE locale in UTC", () => {
      const formatted = formatUtcDate(fixedTimestampMs, {
        locale: "de-DE",
        dateStyle: "medium",
      });
      expect(formatted).toBe("15.06.2024");
    });

    it("handles invalid date gracefully", () => {
      expect(formatLocaleDate("not-a-date")).toBe("Invalid date");
      expect(formatUtcDate(null)).toBe("Invalid date");
    });
  });

  describe("formatRelativeTime", () => {
    const now = new Date("2024-06-15T12:00:00Z");

    it("formats past relative times", () => {
      const past = new Date("2024-06-15T10:00:00Z"); // 2 hours ago
      const result = formatRelativeTime(past, { baseDate: now, locale: "en-US" });
      expect(result).toBe("2 hours ago");
    });

    it("formats future relative times", () => {
      const future = new Date("2024-06-17T12:00:00Z"); // in 2 days
      const result = formatRelativeTime(future, { baseDate: now, locale: "en-US" });
      expect(result).toBe("in 2 days");
    });

    it("formats relative time in another locale (es-ES)", () => {
      const past = new Date("2024-06-15T11:00:00Z"); // 1 hour ago
      const result = formatRelativeTime(past, { baseDate: now, locale: "es-ES" });
      expect(result).toContain("hora");
    });
  });
});
