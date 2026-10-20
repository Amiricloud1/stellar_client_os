/**
 * Exact Decimal Types and Arithmetic for Stellar Soroban Token Amounts.
 *
 * Implements strict string <-> BigInt conversions and checked fixed-point
 * arithmetic without any floating-point math inaccuracies.
 */

export const DEFAULT_STELLAR_DECIMALS = 7;
export const MAX_I128 = (1n << 127n) - 1n;
export const MIN_I128 = -(1n << 127n);
export const U64_MASK = (1n << 64n) - 1n;

export type RoundingMode =
  | 'trunc'
  | 'floor'
  | 'ceil'
  | 'round_half_up'
  | 'round_half_even';

/**
 * Parses a human-readable decimal string into an exact integer base amount (e.g. stroops).
 *
 * Rejects scientific notation, excessive fractional digits, and values exceeding i128.
 *
 * @param value Decimal string or bigint (e.g. "123.4567000", "0.0000001", "-50.0")
 * @param decimals Number of decimal places (defaults to 7 for Stellar standard)
 */
export function parseExactAmount(
  value: string | bigint | number,
  decimals: number = DEFAULT_STELLAR_DECIMALS
): bigint {
  if (decimals < 0 || !Number.isInteger(decimals) || decimals > 36) {
    throw new RangeError(`Invalid decimals: ${decimals}. Must be integer between 0 and 36.`);
  }

  if (typeof value === 'bigint') {
    const scale = 10n ** BigInt(decimals);
    const result = value * scale;
    assertInI128Range(result);
    return result;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError(
        `Unsafe number passed to parseExactAmount: ${value}. Provide as a string to prevent precision loss.`
      );
    }
    value = value.toString();
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    throw new TypeError('Amount string cannot be empty');
  }

  // Strictly disallow exponential notation like "1e7"
  if (/[eE]/.test(trimmed)) {
    throw new TypeError(`Scientific notation is not supported: "${trimmed}". Use standard decimal strings.`);
  }

  const isNegative = trimmed.startsWith('-');
  const isPositive = trimmed.startsWith('+');
  const unsignedStr = isNegative || isPositive ? trimmed.slice(1) : trimmed;

  if (unsignedStr === '') {
    throw new TypeError(`Invalid decimal string: "${trimmed}"`);
  }

  const parts = unsignedStr.split('.');
  if (parts.length > 2) {
    throw new TypeError(`Invalid decimal string with multiple decimal points: "${trimmed}"`);
  }

  const [intPartStr, fracPartStr = ''] = parts;

  if (!/^\d*$/.test(intPartStr) || !/^\d*$/.test(fracPartStr)) {
    throw new TypeError(`Invalid characters in decimal string: "${trimmed}"`);
  }

  if (intPartStr === '' && fracPartStr === '') {
    throw new TypeError(`Invalid decimal string: "${trimmed}"`);
  }

  if (fracPartStr.length > decimals) {
    throw new RangeError(
      `Fractional part "${fracPartStr}" exceeds allowed precision of ${decimals} decimal places.`
    );
  }

  const paddedFrac = fracPartStr.padEnd(decimals, '0');
  const normalizedInt = intPartStr === '' ? '0' : intPartStr;

  const intBig = BigInt(normalizedInt);
  const fracBig = BigInt(paddedFrac);

  const scale = 10n ** BigInt(decimals);
  let total = intBig * scale + fracBig;

  if (isNegative) {
    total = -total;
  }

  assertInI128Range(total);
  return total;
}

/**
 * Formats a raw base amount (e.g. stroops) into a human-readable decimal string.
 *
 * @param amount Raw integer amount in base units
 * @param decimals Number of decimal places (defaults to 7)
 * @param options.trimTrailingZeros Whether to omit trailing zeros after decimal point
 */
export function formatExactAmount(
  amount: bigint | string | number,
  decimals: number = DEFAULT_STELLAR_DECIMALS,
  options?: { trimTrailingZeros?: boolean; minDecimals?: number }
): string {
  if (decimals < 0 || !Number.isInteger(decimals) || decimals > 36) {
    throw new RangeError(`Invalid decimals: ${decimals}. Must be integer between 0 and 36.`);
  }

  const raw = typeof amount === 'bigint' ? amount : BigInt(amount);
  assertInI128Range(raw);

  const isNegative = raw < 0n;
  const abs = isNegative ? -raw : raw;

  if (decimals === 0) {
    return (isNegative ? '-' : '') + abs.toString();
  }

  const scale = 10n ** BigInt(decimals);
  const intPart = abs / scale;
  const fracPart = abs % scale;

  let fracStr = fracPart.toString().padStart(decimals, '0');

  if (options?.trimTrailingZeros) {
    fracStr = fracStr.replace(/0+$/, '');
    const minDecimals = options.minDecimals ?? 0;
    if (fracStr.length < minDecimals) {
      fracStr = fracStr.padEnd(minDecimals, '0');
    }
  }

  const sign = isNegative ? '-' : '';
  if (fracStr === '') {
    return `${sign}${intPart.toString()}`;
  }

  return `${sign}${intPart.toString()}.${fracStr}`;
}

/**
 * Converts a signed 128-bit integer into Soroban XDR i128 hi / lo representation.
 *
 * In Soroban XDR:
 * - `hi` is a signed 64-bit integer (Int64).
 * - `lo` is an unsigned 64-bit integer (Uint64).
 */
export function toExactXdr(rawAmount: bigint): { hi: bigint; lo: bigint } {
  assertInI128Range(rawAmount);

  let unsigned128: bigint;
  if (rawAmount < 0n) {
    // 2's complement 128-bit
    unsigned128 = (1n << 128n) + rawAmount;
  } else {
    unsigned128 = rawAmount;
  }

  const lo = unsigned128 & U64_MASK;
  let hiUnsigned = unsigned128 >> 64n;

  // Convert hi to signed 64-bit BigInt
  let hi: bigint;
  if (hiUnsigned >= (1n << 63n)) {
    hi = hiUnsigned - (1n << 64n);
  } else {
    hi = hiUnsigned;
  }

  return { hi, lo };
}

/**
 * Reconstructs a signed 128-bit integer from Soroban XDR i128 { hi, lo } components.
 */
export function fromExactXdr(hi: bigint | number | string, lo: bigint | number | string): bigint {
  const hiBig = BigInt(hi);
  const loBig = BigInt(lo);

  if (loBig < 0n || loBig > U64_MASK) {
    throw new RangeError(`XDR lo must be an unsigned 64-bit integer, got: ${loBig}`);
  }

  const hiUnsigned = hiBig < 0n ? (1n << 64n) + hiBig : hiBig;
  const unsigned128 = (hiUnsigned << 64n) | loBig;

  let result: bigint;
  if (unsigned128 >= (1n << 127n)) {
    result = unsigned128 - (1n << 128n);
  } else {
    result = unsigned128;
  }

  assertInI128Range(result);
  return result;
}

/**
 * Performs integer division with explicit rounding modes.
 */
export function divideWithRounding(
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode = 'trunc'
): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero');
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;

  if (remainder === 0n) {
    return quotient;
  }

  const isSignOpposite = (numerator < 0n) !== (denominator < 0n);

  switch (rounding) {
    case 'trunc':
      return quotient;

    case 'floor':
      return isSignOpposite ? quotient - 1n : quotient;

    case 'ceil':
      return isSignOpposite ? quotient : quotient + 1n;

    case 'round_half_up': {
      const absRem2 = (remainder < 0n ? -remainder : remainder) * 2n;
      const absDen = denominator < 0n ? -denominator : denominator;
      if (absRem2 >= absDen) {
        return isSignOpposite ? quotient - 1n : quotient + 1n;
      }
      return quotient;
    }

    case 'round_half_even': {
      const absRem2 = (remainder < 0n ? -remainder : remainder) * 2n;
      const absDen = denominator < 0n ? -denominator : denominator;
      if (absRem2 > absDen) {
        return isSignOpposite ? quotient - 1n : quotient + 1n;
      } else if (absRem2 === absDen) {
        // Halfway case: round to nearest even quotient
        if ((quotient & 1n) !== 0n) {
          return isSignOpposite ? quotient - 1n : quotient + 1n;
        }
      }
      return quotient;
    }

    default:
      throw new Error(`Unsupported rounding mode: ${rounding}`);
  }
}

/**
 * Asserts that a BigInt fits within signed 128-bit limits.
 */
function assertInI128Range(val: bigint): void {
  if (val > MAX_I128 || val < MIN_I128) {
    throw new RangeError(
      `Value ${val.toString()} exceeds signed 128-bit integer range [${MIN_I128}, ${MAX_I128}].`
    );
  }
}

/**
 * Immutable Exact Decimal Token Amount.
 *
 * Encapsulates raw BigInt amounts and decimal precision, offering
 * overflow protection and deterministic arithmetic.
 */
export class ExactDecimal {
  readonly raw: bigint;
  readonly decimals: number;

  constructor(raw: bigint, decimals: number = DEFAULT_STELLAR_DECIMALS) {
    assertInI128Range(raw);
    if (decimals < 0 || !Number.isInteger(decimals) || decimals > 36) {
      throw new RangeError(`Invalid decimals: ${decimals}`);
    }
    this.raw = raw;
    this.decimals = decimals;
  }

  static fromString(value: string, decimals: number = DEFAULT_STELLAR_DECIMALS): ExactDecimal {
    const raw = parseExactAmount(value, decimals);
    return new ExactDecimal(raw, decimals);
  }

  static fromRaw(raw: bigint, decimals: number = DEFAULT_STELLAR_DECIMALS): ExactDecimal {
    return new ExactDecimal(raw, decimals);
  }

  static fromXdr(
    hi: bigint | number | string,
    lo: bigint | number | string,
    decimals: number = DEFAULT_STELLAR_DECIMALS
  ): ExactDecimal {
    const raw = fromExactXdr(hi, lo);
    return new ExactDecimal(raw, decimals);
  }

  static zero(decimals: number = DEFAULT_STELLAR_DECIMALS): ExactDecimal {
    return new ExactDecimal(0n, decimals);
  }

  toRaw(): bigint {
    return this.raw;
  }

  toString(trimTrailingZeros: boolean = false): string {
    return formatExactAmount(this.raw, this.decimals, { trimTrailingZeros });
  }

  toFormatted(options?: { trimTrailingZeros?: boolean; minDecimals?: number }): string {
    return formatExactAmount(this.raw, this.decimals, options);
  }

  toXdr(): { hi: bigint; lo: bigint } {
    return toExactXdr(this.raw);
  }

  add(other: ExactDecimal): ExactDecimal {
    this.assertSameDecimals(other);
    const result = this.raw + other.raw;
    assertInI128Range(result);
    return new ExactDecimal(result, this.decimals);
  }

  sub(other: ExactDecimal): ExactDecimal {
    this.assertSameDecimals(other);
    const result = this.raw - other.raw;
    assertInI128Range(result);
    return new ExactDecimal(result, this.decimals);
  }

  mul(
    multiplier: bigint | number,
    divisor: bigint = 1n,
    rounding: RoundingMode = 'trunc'
  ): ExactDecimal {
    const multBig = BigInt(multiplier);
    const divBig = BigInt(divisor);
    const numerator = this.raw * multBig;
    const result = divideWithRounding(numerator, divBig, rounding);
    assertInI128Range(result);
    return new ExactDecimal(result, this.decimals);
  }

  div(divisor: bigint | ExactDecimal, rounding: RoundingMode = 'trunc'): ExactDecimal {
    if (divisor instanceof ExactDecimal) {
      this.assertSameDecimals(divisor);
      // Result of dividing two token amounts of same decimals is a scalar multiplier
      const scale = 10n ** BigInt(this.decimals);
      const numerator = this.raw * scale;
      const result = divideWithRounding(numerator, divisor.raw, rounding);
      assertInI128Range(result);
      return new ExactDecimal(result, this.decimals);
    }
    const result = divideWithRounding(this.raw, BigInt(divisor), rounding);
    assertInI128Range(result);
    return new ExactDecimal(result, this.decimals);
  }

  bps(basisPoints: number | bigint, rounding: RoundingMode = 'trunc'): ExactDecimal {
    const bpsBig = BigInt(basisPoints);
    if (bpsBig < 0n || bpsBig > 10000n) {
      throw new RangeError(`Basis points must be between 0 and 10000, got: ${basisPoints}`);
    }
    const numerator = this.raw * bpsBig;
    const result = divideWithRounding(numerator, 10000n, rounding);
    assertInI128Range(result);
    return new ExactDecimal(result, this.decimals);
  }

  eq(other: ExactDecimal): boolean {
    this.assertSameDecimals(other);
    return this.raw === other.raw;
  }

  lt(other: ExactDecimal): boolean {
    this.assertSameDecimals(other);
    return this.raw < other.raw;
  }

  lte(other: ExactDecimal): boolean {
    this.assertSameDecimals(other);
    return this.raw <= other.raw;
  }

  gt(other: ExactDecimal): boolean {
    this.assertSameDecimals(other);
    return this.raw > other.raw;
  }

  gte(other: ExactDecimal): boolean {
    this.assertSameDecimals(other);
    return this.raw >= other.raw;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  isPositive(): boolean {
    return this.raw > 0n;
  }

  isNegative(): boolean {
    return this.raw < 0n;
  }

  private assertSameDecimals(other: ExactDecimal): void {
    if (this.decimals !== other.decimals) {
      throw new TypeError(
        `Mismatched decimal precision: ${this.decimals} vs ${other.decimals}. Convert to matching decimals first.`
      );
    }
  }
}
