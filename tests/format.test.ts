// Formatting helpers the page uses (src/lib/format.ts) and the 18-decimal
// price formatter the page, the scripts and the tests share (src/lib/report.ts).
import { describe, expect, it } from 'vitest';
import {
  bpsToPercent,
  daysBetween,
  formatAge,
  formatBps,
  formatE18Price,
  formatScaled,
  formatSeconds,
  groupThousands,
  isoFromSeconds,
  shortId,
} from '../src/lib/format.ts';
import { formatE18 } from '../src/lib/report.ts';

describe('formatScaled', () => {
  it('renders value * 10^exponent without floats', () => {
    expect(formatScaled(6828284601313n, -8)).toBe('68,282.84601313');
    expect(formatScaled(147519375000000000n, -18, { maxFraction: 6 })).toBe('0.147519');
    expect(formatScaled(2050205901000000000000n, -18, { maxFraction: 6 })).toBe('2,050.205901');
    expect(formatScaled(5n, 2)).toBe('500.00');
    expect(formatScaled(-150n, -2)).toBe('-1.50');
    expect(formatScaled(100n, -2, { minFraction: 0 })).toBe('1');
  });

  it('truncates instead of rounding', () => {
    expect(formatScaled(199999n, -5, { maxFraction: 2 })).toBe('1.99');
  });
});

describe('18-decimal prices', () => {
  it('formatE18Price shows six decimals of a feed answer or a stream price', () => {
    expect(formatE18Price(147519375000000000n)).toBe('0.147519');
    expect(formatE18Price(2050205901000000000000n)).toBe('2,050.205901');
    expect(formatE18Price(86400288421531180000000n)).toBe('86,400.288421');
    expect(formatE18Price(10n ** 18n)).toBe('1.00');
  });

  it('formatE18 from report.ts agrees on the same inputs', () => {
    expect(formatE18(147519375000000000n)).toBe('0.147519');
    expect(formatE18(2050205901000000000000n)).toBe('2,050.205901');
    expect(formatE18(86400288421531180000000n, 2)).toBe('86,400.28');
    expect(formatE18(-1n)).toBe('-0.000000');
  });
});

describe('basis points', () => {
  it('formatBps carries the sign and groups thousands', () => {
    expect(formatBps(12n)).toBe('+12 bps');
    expect(formatBps(-1234n)).toBe('-1,234 bps');
    expect(formatBps(0n)).toBe('0 bps');
  });

  it('bpsToPercent shows two decimals', () => {
    expect(bpsToPercent(1234n)).toBe('12.34%');
    expect(bpsToPercent(5n)).toBe('0.05%');
    expect(bpsToPercent(-50n)).toBe('-0.50%');
  });
});

describe('time', () => {
  it('isoFromSeconds gives ISO 8601 UTC without milliseconds, for bigint and number', () => {
    expect(isoFromSeconds(1775220938n)).toBe('2026-04-03T12:55:38Z');
    expect(isoFromSeconds(1777812938)).toBe('2026-05-03T12:55:38Z');
  });

  it('formatAge and formatSeconds pick the unit by size', () => {
    expect(formatAge(0)).toBe('0 s');
    expect(formatAge(59_000)).toBe('59 s');
    expect(formatAge(61_000)).toBe('1 m 01 s');
    expect(formatAge(2 * 3_600_000 + 7 * 60_000)).toBe('2 h 07 m');
    expect(formatAge(50 * 3_600_000)).toBe('2 d 2 h');
    expect(formatSeconds(280)).toBe('4 m 40 s');
    expect(formatSeconds(86355n)).toBe('23 h 59 m');
  });

  it('formatAge is safe on bad input', () => {
    expect(formatAge(Number.NaN)).toBe('?');
    expect(formatAge(-5)).toBe('0 s');
  });

  it('daysBetween rounds down', () => {
    expect(daysBetween(1777812938, 1777812938 + 191 * 86_400 + 3_600)).toBe(191);
    expect(daysBetween(10, 5)).toBe(-1);
  });
});

describe('shortId and groupThousands', () => {
  it('shortens long ids and leaves short ones alone', () => {
    expect(shortId('CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4')).toBe('CBUF...K6O4');
    expect(shortId('CBUF6IAD', 4)).toBe('CBUF6IAD');
  });

  it('groups thousands', () => {
    expect(groupThousands('1234567')).toBe('1,234,567');
    expect(groupThousands('999')).toBe('999');
  });
});
