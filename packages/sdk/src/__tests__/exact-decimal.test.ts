import { describe, it, expect } from 'vitest';
import {
  parseExactAmount,
  formatExactAmount,
  toExactXdr,
  fromExactXdr,
  divideWithRounding,
  ExactDecimal,
  MAX_I128,
  MIN_I128,
} from '../utils/exact-decimal.js';

describe('Exact Decimal Utilities', () => {
  describe('parseExactAmount', () => {
    it('parses standard 7-decimal Stellar token amounts', () => {
      expect(parseExactAmount('1.0000000')).toBe(10_000_000n);
      expect(parseExactAmount('100.5')).toBe(1_005_000_000n);
      expect(parseExactAmount('0.0000001')).toBe(1n);
      expect(parseExactAmount('0')).toBe(0n);
      expect(parseExactAmount('0.0')).toBe(0n);
    });

    it('parses integer strings without decimal dot', () => {
      expect(parseExactAmount('50')).toBe(500_000_000n);
      expect(parseExactAmount('1000')).toBe(10_000_000_000n);
    });

    it('handles negative and positive signs', () => {
      expect(parseExactAmount('-10.5')).toBe(-105_000_000n);
      expect(parseExactAmount('+10.5')).toBe(105_000_000n);
    });

    it('rejects strings with excessive decimals', () => {
      expect(() => parseExactAmount('1.12345678', 7)).toThrow(/exceeds allowed precision/);
    });

    it('supports custom decimal precision', () => {
      expect(parseExactAmount('1.5', 2)).toBe(150n);
      expect(parseExactAmount('1.123456', 6)).toBe(1_123_456n);
      expect(parseExactAmount('1.123456789012345678', 18)).toBe(1_123_456_789_012_345_678n);
    });

    it('rejects scientific notation to prevent precision loss', () => {
      expect(() => parseExactAmount('1e7')).toThrow(/Scientific notation is not supported/);
      expect(() => parseExactAmount('1.5E-3')).toThrow(/Scientific notation is not supported/);
    });

    it('rejects invalid inputs', () => {
      expect(() => parseExactAmount('')).toThrow();
      expect(() => parseExactAmount('abc')).toThrow();
      expect(() => parseExactAmount('1.2.3')).toThrow();
    });

    it('handles MAX_I128 and MIN_I128 bounds without float errors', () => {
      const maxStr = formatExactAmount(MAX_I128, 7);
      expect(parseExactAmount(maxStr, 7)).toBe(MAX_I128);

      const minStr = formatExactAmount(MIN_I128, 7);
      expect(parseExactAmount(minStr, 7)).toBe(MIN_I128);

      // Overflow
      expect(() => parseExactAmount('170141183460469231731687303715884105728', 0)).toThrow(
        /exceeds signed 128-bit/
      );
    });
  });

  describe('formatExactAmount', () => {
    it('formats raw amounts with default 7 decimals', () => {
      expect(formatExactAmount(10_000_000n)).toBe('1.0000000');
      expect(formatExactAmount(1_005_000_000n)).toBe('100.5000000');
      expect(formatExactAmount(1n)).toBe('0.0000001');
      expect(formatExactAmount(0n)).toBe('0.0000000');
      expect(formatExactAmount(-105_000_000n)).toBe('-10.5000000');
    });

    it('respects trimTrailingZeros option', () => {
      expect(formatExactAmount(10_000_000n, 7, { trimTrailingZeros: true })).toBe('1');
      expect(formatExactAmount(1_005_000_000n, 7, { trimTrailingZeros: true })).toBe('100.5');
      expect(formatExactAmount(1n, 7, { trimTrailingZeros: true })).toBe('0.0000001');
      expect(formatExactAmount(0n, 7, { trimTrailingZeros: true })).toBe('0');
      expect(
        formatExactAmount(10_000_000n, 7, { trimTrailingZeros: true, minDecimals: 2 })
      ).toBe('1.00');
    });

    it('formats 0 decimals correctly', () => {
      expect(formatExactAmount(12345n, 0)).toBe('12345');
      expect(formatExactAmount(-12345n, 0)).toBe('-12345');
    });
  });

  describe('XDR i128 hi / lo round-trip', () => {
    it('round-trips zero, positive, and negative amounts', () => {
      const values = [
        0n,
        1n,
        100_000_000n,
        (1n << 63n) - 1n,
        1n << 63n,
        (1n << 64n) - 1n,
        1n << 64n,
        MAX_I128,
        -1n,
        -(1n << 63n),
        -(1n << 64n),
        MIN_I128,
      ];

      for (const val of values) {
        const xdr = toExactXdr(val);
        const reconstructed = fromExactXdr(xdr.hi, xdr.lo);
        expect(reconstructed).toBe(val);
      }
    });
  });

  describe('divideWithRounding', () => {
    it('handles exact division', () => {
      expect(divideWithRounding(10n, 2n)).toBe(5n);
      expect(divideWithRounding(-10n, 2n)).toBe(-5n);
    });

    it('handles trunc rounding', () => {
      expect(divideWithRounding(7n, 3n, 'trunc')).toBe(2n);
      expect(divideWithRounding(-7n, 3n, 'trunc')).toBe(-2n);
    });

    it('handles floor rounding', () => {
      expect(divideWithRounding(7n, 3n, 'floor')).toBe(2n);
      expect(divideWithRounding(-7n, 3n, 'floor')).toBe(-3n);
    });

    it('handles ceil rounding', () => {
      expect(divideWithRounding(7n, 3n, 'ceil')).toBe(3n);
      expect(divideWithRounding(-7n, 3n, 'ceil')).toBe(-2n);
    });

    it('handles round_half_up', () => {
      expect(divideWithRounding(3n, 2n, 'round_half_up')).toBe(2n); // 1.5 -> 2
      expect(divideWithRounding(5n, 4n, 'round_half_up')).toBe(1n); // 1.25 -> 1
      expect(divideWithRounding(7n, 4n, 'round_half_up')).toBe(2n); // 1.75 -> 2
      expect(divideWithRounding(-3n, 2n, 'round_half_up')).toBe(-2n); // -1.5 -> -2
    });

    it('handles round_half_even (banker rounding)', () => {
      expect(divideWithRounding(3n, 2n, 'round_half_even')).toBe(2n); // 1.5 -> 2 (even)
      expect(divideWithRounding(5n, 2n, 'round_half_even')).toBe(2n); // 2.5 -> 2 (even)
      expect(divideWithRounding(7n, 2n, 'round_half_even')).toBe(4n); // 3.5 -> 4 (even)
    });
  });

  describe('ExactDecimal Class', () => {
    it('performs arithmetic without floating point errors', () => {
      const a = ExactDecimal.fromString('0.1');
      const b = ExactDecimal.fromString('0.2');
      const sum = a.add(b);

      expect(sum.toString(true)).toBe('0.3');
      expect(sum.toRaw()).toBe(3_000_000n);

      const diff = b.sub(a);
      expect(diff.toString(true)).toBe('0.1');
    });

    it('computes basis points accurately', () => {
      const principal = ExactDecimal.fromString('100.00');
      // 250 bps = 2.5%
      const fee = principal.bps(250);
      expect(fee.toString(true)).toBe('2.5');
    });

    it('handles comparisons', () => {
      const x = ExactDecimal.fromString('10.0');
      const y = ExactDecimal.fromString('10.0');
      const z = ExactDecimal.fromString('15.0');

      expect(x.eq(y)).toBe(true);
      expect(x.lt(z)).toBe(true);
      expect(z.gt(x)).toBe(true);
      expect(x.lte(y)).toBe(true);
      expect(x.gte(y)).toBe(true);
    });

    it('fails when combining different decimals', () => {
      const dec7 = ExactDecimal.fromString('1.0', 7);
      const dec6 = ExactDecimal.fromString('1.0', 6);
      expect(() => dec7.add(dec6)).toThrow(/Mismatched decimal precision/);
    });
  });
});
