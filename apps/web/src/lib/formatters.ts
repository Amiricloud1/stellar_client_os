/**
 * Centralized Locale-Aware Amount, Currency, and Date Formatting (Issue #77)
 *
 * Provides deterministic, locale-sensitive formatting for:
 * - Blockchain asset precision (Stellar 7-decimal stroops, fiat tokens, carbon credits)
 * - Locale separators (thousands, decimals, currency symbols) across BCP-47 locales
 * - UTC and timezone-aware date/time formatting to ensure deterministic SSR/client output
 * - Absent translations and invalid locale fallback handling
 */

// ── Asset Precision Definitions ───────────────────────────────────────────────

export interface AssetPrecisionConfig {
  code: string;
  decimals: number;
  displayDecimals: number;
  symbol?: string;
  name?: string;
}

export const ASSET_PRECISIONS: Record<string, AssetPrecisionConfig> = {
  XLM: {
    code: "XLM",
    decimals: 7,
    displayDecimals: 2,
    symbol: "XLM",
    name: "Stellar Lumens",
  },
  USDC: {
    code: "USDC",
    decimals: 7,
    displayDecimals: 2,
    symbol: "$",
    name: "USD Coin",
  },
  EURC: {
    code: "EURC",
    decimals: 7,
    displayDecimals: 2,
    symbol: "€",
    name: "Euro Coin",
  },
  USD: {
    code: "USD",
    decimals: 2,
    displayDecimals: 2,
    symbol: "$",
    name: "US Dollar",
  },
  EUR: {
    code: "EUR",
    decimals: 2,
    displayDecimals: 2,
    symbol: "€",
    name: "Euro",
  },
  CARBON: {
    code: "CARBON",
    decimals: 2,
    displayDecimals: 2,
    symbol: "tCO2e",
    name: "Carbon Credits",
  },
};

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_ASSET_DECIMALS = 7;
export const DEFAULT_DISPLAY_DECIMALS = 2;

/**
 * Validates and normalizes a BCP-47 locale tag, falling back to DEFAULT_LOCALE on error.
 */
export function normalizeLocale(locale?: string): string {
  if (!locale || typeof locale !== "string") return DEFAULT_LOCALE;
  const trimmed = locale.trim();
  if (!trimmed) return DEFAULT_LOCALE;
  try {
    // Check if Intl supports this locale
    return Intl.NumberFormat.supportedLocalesOf([trimmed])[0] || DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * Inspects the grouping and decimal separators for a given locale.
 */
export function getLocaleSeparators(locale?: string): { decimal: string; group: string } {
  const safeLocale = normalizeLocale(locale);
  try {
    const parts = new Intl.NumberFormat(safeLocale).formatToParts(1000.5);
    const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
    const group = parts.find((p) => p.type === "group")?.value ?? ",";
    return { decimal, group };
  } catch {
    return { decimal: ".", group: "," };
  }
}

// ── Amount Formatting Options ─────────────────────────────────────────────────

export interface FormatAmountOptions {
  locale?: string;
  asset?: string;
  decimals?: number;
  minFractionDigits?: number;
  maxFractionDigits?: number;
  showSymbol?: boolean;
  symbolPosition?: "prefix" | "suffix" | "auto";
  useGrouping?: boolean;
  isMinorUnits?: boolean;
  trimTrailingZeros?: boolean;
}

/**
 * Converts minor units (e.g. stroops = 10^-7 XLM) into a floating-point number.
 */
export function minorUnitsToNumber(units: bigint | number | string, decimals: number = DEFAULT_ASSET_DECIMALS): number {
  const bi = typeof units === "bigint" ? units : BigInt(String(units).split(".")[0] || "0");
  const scale = 10 ** decimals;
  return Number(bi) / scale;
}

/**
 * Formats a numeric, bigint, or decimal string amount in a locale-aware manner.
 */
export function formatAssetAmount(
  amount: number | bigint | string | null | undefined,
  options: FormatAmountOptions = {}
): string {
  if (amount == null || amount === "") {
    return "0.00";
  }

  const {
    locale,
    asset,
    decimals,
    minFractionDigits,
    maxFractionDigits,
    showSymbol = true,
    symbolPosition = "auto",
    useGrouping = true,
    isMinorUnits = false,
    trimTrailingZeros = false,
  } = options;

  const safeLocale = normalizeLocale(locale);
  const assetConfig = asset ? ASSET_PRECISIONS[asset.toUpperCase()] : undefined;
  const assetDecimals = decimals ?? assetConfig?.decimals ?? DEFAULT_ASSET_DECIMALS;

  let numericValue: number;

  if (typeof amount === "bigint") {
    numericValue = isMinorUnits ? minorUnitsToNumber(amount, assetDecimals) : Number(amount);
  } else if (typeof amount === "string") {
    if (isMinorUnits) {
      numericValue = minorUnitsToNumber(BigInt(amount), assetDecimals);
    } else {
      numericValue = Number.parseFloat(amount);
    }
  } else {
    numericValue = isMinorUnits ? minorUnitsToNumber(BigInt(Math.floor(amount)), assetDecimals) : amount;
  }

  if (!Number.isFinite(numericValue)) {
    return "0.00";
  }

  const defaultMinFraction = minFractionDigits ?? (assetConfig?.displayDecimals ?? DEFAULT_DISPLAY_DECIMALS);
  const defaultMaxFraction = maxFractionDigits ?? decimals ?? (assetConfig?.displayDecimals ?? DEFAULT_DISPLAY_DECIMALS);

  const formatter = new Intl.NumberFormat(safeLocale, {
    useGrouping,
    minimumFractionDigits: trimTrailingZeros ? 0 : Math.min(defaultMinFraction, 20),
    maximumFractionDigits: Math.min(Math.max(defaultMinFraction, defaultMaxFraction), 20),
  });

  let formatted = formatter.format(numericValue);

  if (trimTrailingZeros && formatted.includes(getLocaleSeparators(safeLocale).decimal)) {
    const { decimal } = getLocaleSeparators(safeLocale);
    const regex = new RegExp(`(\\${decimal}\\d*?[1-9])0+$|\\${decimal}0+$`);
    formatted = formatted.replace(regex, "$1");
  }

  if (!showSymbol || !asset) {
    return formatted;
  }

  const symbol = assetConfig?.symbol ?? asset;
  const isCurrencySymbol = symbol === "$" || symbol === "€" || symbol === "£" || symbol === "¥";

  let placePrefix = false;
  if (symbolPosition === "prefix") placePrefix = true;
  else if (symbolPosition === "suffix") placePrefix = false;
  else placePrefix = isCurrencySymbol;

  if (placePrefix) {
    return `${symbol}${formatted}`;
  }
  return `${formatted} ${symbol}`;
}

/**
 * Convenience helper to format currency amounts with standardized defaults.
 */
export function formatCurrencyAmount(
  amount: number | bigint | string | null | undefined,
  currency: string = "USD",
  options: Omit<FormatAmountOptions, "asset"> = {}
): string {
  return formatAssetAmount(amount, {
    ...options,
    asset: currency,
    showSymbol: options.showSymbol ?? true,
  });
}

// ── Date & Time UTC Formatting ────────────────────────────────────────────────

export type DateStyle = "short" | "medium" | "long" | "full";
export type TimeStyle = "short" | "medium" | "long" | "full";

export interface FormatDateOptions {
  locale?: string;
  utc?: boolean;
  dateStyle?: DateStyle;
  timeStyle?: TimeStyle;
  includeTime?: boolean;
}

/**
 * Normalizes an input date (Date object, timestamp ms or sec, ISO string) into a valid Date.
 */
export function parseDateInput(input: Date | number | string | null | undefined): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === "number") {
    // If timestamp is in seconds (< 10_000_000_000), convert to ms
    const ms = input < 10_000_000_000 ? input * 1000 : input;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof input === "string") {
    const num = Number(input);
    if (!Number.isNaN(num) && /^\d+$/.test(input.trim())) {
      const ms = num < 10_000_000_000 ? num * 1000 : num;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Formats a date into a localized date string with UTC or local timezone handling.
 */
export function formatLocaleDate(
  dateInput: Date | number | string | null | undefined,
  options: FormatDateOptions = {}
): string {
  const date = parseDateInput(dateInput);
  if (!date) return "Invalid date";

  const {
    locale,
    utc = true,
    dateStyle = "medium",
    timeStyle,
    includeTime = false,
  } = options;

  const safeLocale = normalizeLocale(locale);

  const intlOptions: Intl.DateTimeFormatOptions = {
    dateStyle,
    timeZone: utc ? "UTC" : undefined,
  };

  if (includeTime || timeStyle) {
    intlOptions.timeStyle = timeStyle || "short";
  }

  try {
    return new Intl.DateTimeFormat(safeLocale, intlOptions).format(date);
  } catch {
    return date.toISOString().split("T")[0];
  }
}

/**
 * Explicit UTC date formatting wrapper. Always forces UTC timezone.
 */
export function formatUtcDate(
  dateInput: Date | number | string | null | undefined,
  options: Omit<FormatDateOptions, "utc"> = {}
): string {
  return formatLocaleDate(dateInput, { ...options, utc: true });
}

/**
 * Formats relative time (e.g. "3 hours ago", "in 2 days") using Intl.RelativeTimeFormat.
 */
export function formatRelativeTime(
  dateInput: Date | number | string | null | undefined,
  options: { locale?: string; baseDate?: Date | number } = {}
): string {
  const date = parseDateInput(dateInput);
  if (!date) return "Invalid date";

  const base = parseDateInput(options.baseDate) || new Date();
  const safeLocale = normalizeLocale(options.locale);

  const diffMs = date.getTime() - base.getTime();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHours = Math.round(diffMin / 60);
  const diffDays = Math.round(diffHours / 24);
  const diffMonths = Math.round(diffDays / 30);
  const diffYears = Math.round(diffDays / 365);

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;

  if (Math.abs(diffSec) < 60) {
    value = diffSec;
    unit = "second";
  } else if (Math.abs(diffMin) < 60) {
    value = diffMin;
    unit = "minute";
  } else if (Math.abs(diffHours) < 24) {
    value = diffHours;
    unit = "hour";
  } else if (Math.abs(diffDays) < 30) {
    value = diffDays;
    unit = "day";
  } else if (Math.abs(diffMonths) < 12) {
    value = diffMonths;
    unit = "month";
  } else {
    value = diffYears;
    unit = "year";
  }

  try {
    const rtf = new Intl.RelativeTimeFormat(safeLocale, { numeric: "auto" });
    return rtf.format(value, unit);
  } catch {
    // Fallback if RelativeTimeFormat unsupported
    return diffMs < 0 ? `${Math.abs(value)} ${unit}s ago` : `in ${value} ${unit}s`;
  }
}
