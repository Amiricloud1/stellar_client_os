/**
 * Formats a balance amount string into a human-readable format.
 *
 * Requirements:
 * - 6.1: Format with thousands separators (commas)
 * - 6.2: Display scientific notation for amounts < 0.0000001
 * - 6.3: Display "0" for zero balance
 * - 6.4: Preserve trailing zeros up to 2 decimal places
 * - 6.5: Handle very large values without overflow
 * - 2.2: Max 7 decimal places precision
 * - 2.4: Round to 7 decimal places when needed
 *
 * @param amount - Raw balance string from Horizon API
 * @returns Formatted balance string
 *
 * @example
 * formatBalance("1234567.89") // "1,234,567.89"
 * formatBalance("0.00000001") // "1e-8"
 * formatBalance("0") // "0"
 * formatBalance("100.5") // "100.50"
 */
export function formatBalance(amount: string): string {
  // Handle empty or invalid input
  if (!amount || amount.trim() === "") {
    return "0";
  }

  // Parse the amount as a number
  const numericAmount = parseFloat(amount);

  // Handle NaN, Infinity, or invalid numbers
  if (!isFinite(numericAmount)) {
    return "0";
  }

  // Requirement 6.3: Display "0" for zero balance
  if (numericAmount === 0) {
    return "0";
  }

  // Requirement 6.2: Use scientific notation for very small numbers (< 0.0000001)
  if (Math.abs(numericAmount) < 0.0000001) {
    return numericAmount.toExponential();
  }

  // Requirement 2.4: Round to max 7 decimal places
  // Use a more precise rounding approach to avoid floating point errors
  const roundedAmount = Math.round(numericAmount * 1e7) / 1e7;

  // Convert to string with appropriate decimal places
  let formattedAmount: string;

  // Determine the number of decimal places to show
  const absAmount = Math.abs(roundedAmount);

  if (absAmount >= 1) {
    // For amounts >= 1, show up to 2 decimal places (Requirement 6.4)
    // But remove unnecessary trailing zeros beyond 2 decimal places
    formattedAmount = roundedAmount.toFixed(2);
  } else {
    // For amounts < 1, show up to 7 decimal places but remove unnecessary trailing zeros
    formattedAmount = roundedAmount.toFixed(7);
    // Remove trailing zeros beyond 2 decimal places
    const parts = formattedAmount.split(".");
    if (parts[1]) {
      // Keep at least 2 decimal places, remove trailing zeros beyond that
      let decimals = parts[1];
      // Find the last non-zero digit
      let lastNonZero = decimals.length - 1;
      while (lastNonZero > 1 && decimals[lastNonZero] === "0") {
        lastNonZero--;
      }
      decimals = decimals.substring(0, lastNonZero + 1);
      // Ensure at least 2 decimal places
      if (decimals.length < 2) {
        decimals = decimals.padEnd(2, "0");
      }
      formattedAmount = parts[0] + "." + decimals;
    }
  }

  // Split into integer and decimal parts
  const [integerPart, decimalPart] = formattedAmount.split(".");

  // Requirement 6.1: Add thousands separators (commas)
  // Handle negative numbers
  const isNegative = integerPart.startsWith("-");
  const absoluteInteger = isNegative ? integerPart.substring(1) : integerPart;

  // Add commas for thousands separators
  const formattedInteger = absoluteInteger.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );

  // Reconstruct the number
  const finalInteger = isNegative ? "-" + formattedInteger : formattedInteger;

  // Combine integer and decimal parts
  if (decimalPart) {
    return finalInteger + "." + decimalPart;
  }

  return finalInteger;
}

// ---------------------------------------------------------------------------
// Exact amount formatting (no floating-point rounding errors)
// ---------------------------------------------------------------------------

/**
 * Exact amount formatter for financial UI.
 *
 * Unlike {@link formatBalance} (which uses `parseFloat` and is susceptible to
 * IEEE-754 rounding), this function parses the decimal string using integer
 * arithmetic (matching Stellar's 7-decimal-place fixed-point representation)
 * so that values like "100.0000001" and "9999999.9999999" round-trip without
 * loss.
 *
 * The output is locale-formatted with thousands separators and up to
 * `maxDecimals` significant decimal digits (trailing zeros stripped beyond
 * 2 places).
 *
 * @param amount    - Stellar decimal string, e.g. "1234567.8900000"
 * @param maxDecimals - Maximum fraction digits to display (default 7)
 * @returns Human-readable string, e.g. "1,234,567.89"
 *
 * @example
 * formatAmountExact("1234567.8900000") // "1,234,567.89"
 * formatAmountExact("0.0000001")       // "0.0000001"
 * formatAmountExact("0")               // "0"
 * formatAmountExact("100.5000000")     // "100.50"
 */
export function formatAmountExact(
  amount: string,
  maxDecimals = 7,
): string {
  if (!amount || amount.trim() === "") return "0";

  const trimmed = amount.trim();

  // Handle edge-case: negative sign
  const negative = trimmed.startsWith("-");
  const abs = negative ? trimmed.slice(1) : trimmed;

  // Split on the decimal point
  const dotIdx = abs.indexOf(".");
  const wholePart = dotIdx === -1 ? abs : abs.slice(0, dotIdx);
  const rawFraction = dotIdx === -1 ? "" : abs.slice(dotIdx + 1);

  // Validate: must be digits only after stripping sign/dot
  if (!/^\d+$/.test(wholePart) || (rawFraction && !/^\d+$/.test(rawFraction))) {
    return "0";
  }

  // Truncate fraction to maxDecimals (Stellar uses 7; we never need more)
  const fraction = rawFraction.slice(0, maxDecimals).padEnd(maxDecimals, "0");

  // Strip trailing zeros, keeping at least 2 decimal digits (Req 6.4)
  let displayFraction = fraction.replace(/0+$/, "");
  if (displayFraction.length > 0 && displayFraction.length < 2) {
    displayFraction = displayFraction.padEnd(2, "0");
  }

  // Handle zero value
  if (wholePart === "0" && displayFraction.replace(/0/g, "") === "") {
    return "0";
  }

  // Add thousands separators to the whole part
  const formattedWhole = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const result =
    displayFraction.length > 0
      ? `${formattedWhole}.${displayFraction}`
      : formattedWhole;

  return negative ? `-${result}` : result;
}

/**
 * Formats a Stellar amount expressed as bigint minor units (7 decimal places)
 * into a human-readable display string with thousands separators.
 *
 * This is the display counterpart of `formatAmount` from `lib/decimal-amount`.
 * The difference is that this function also adds commas to the whole part.
 *
 * @param units - BigInt minor units (1 XLM = 10_000_000n)
 * @returns Formatted string, e.g. "1,234,567.89"
 *
 * @example
 * formatUnitsExact(12345678900000n) // "1,234,567.89"
 * formatUnitsExact(0n)              // "0"
 */
export function formatUnitsExact(units: bigint): string {
  const SCALE = 10_000_000n; // 7 decimal places
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(7, "0");

  // Strip trailing zeros; keep ≥ 2 decimal places only when there is a
  // non-zero fractional part (mirrors formatAmountExact behaviour).
  let displayFrac = frac.replace(/0+$/, "");
  if (displayFrac.length > 0 && displayFrac.length < 2) {
    displayFrac = displayFrac.padEnd(2, "0");
  }

  const formattedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  if (whole === 0n && displayFrac.replace(/0/g, "") === "") return "0";

  const result =
    displayFrac.length > 0
      ? `${formattedWhole}.${displayFrac}`
      : formattedWhole;

  return negative ? `-${result}` : result;
}
