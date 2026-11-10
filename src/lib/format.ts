/* Formatting helpers. Prices stay bigint end to end: no floats, no rounding. */

const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

export const groupThousands = (digits: string): string => digits.replace(THOUSANDS, ',');

export interface FractionOpts {
  /** Pad the fraction to at least this many digits. Default 2. */
  minFraction?: number;
  /** Cut the fraction after this many digits (no rounding). Default 8. */
  maxFraction?: number;
}

/**
 * Render `value * 10^exponent` as a decimal string.
 * formatScaled(147519375000000000n, -18) -> "0.147519375"
 */
export function formatScaled(value: bigint, exponent: number, opts: FractionOpts = {}): string {
  const minFraction = opts.minFraction ?? 2;
  const maxFraction = opts.maxFraction ?? 8;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  let whole: bigint;
  let fraction = '';
  if (exponent >= 0) {
    whole = abs * 10n ** BigInt(exponent);
  } else {
    const scale = 10n ** BigInt(-exponent);
    whole = abs / scale;
    fraction = (abs % scale).toString().padStart(-exponent, '0');
  }
  fraction = fraction.slice(0, maxFraction).replace(/0+$/, '');
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, '0');
  const body = groupThousands(whole.toString());
  const sign = negative ? '-' : '';
  return fraction.length > 0 ? `${sign}${body}.${fraction}` : `${sign}${body}`;
}

/** An 18-decimal feed answer or stream price as USD text: "74,169.652301", "0.145081". */
export const formatE18Price = (value: bigint): string => formatScaled(value, -18, { minFraction: 2, maxFraction: 6 });

/** Basis points with a sign: "+12 bps", "-1,234 bps", "0 bps". */
export function formatBps(bps: bigint): string {
  const sign = bps > 0n ? '+' : '';
  return `${sign}${groupThousands(bps.toString())} bps`;
}

/** Basis points as a percentage with two decimals: 1234n -> "12.34%". */
export const bpsToPercent = (bps: bigint): string => `${formatScaled(bps, -2, { minFraction: 2, maxFraction: 2 })}%`;

const MAX_DATE_MS = 8_640_000_000_000_000;

/** Unix seconds (ledger or feed time) to ISO 8601 UTC with a Z, no milliseconds. */
export function isoFromSeconds(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000;
  return Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : `${seconds.toString()} s`;
}

/** A duration in milliseconds as "12 s", "3 m 05 s", "2 h 07 m" or "3 d 4 h". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 0) return '0 s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} m`;
  const d = Math.floor(h / 24);
  return `${d} d ${h % 24} h`;
}

/** A duration in seconds, same shape as formatAge. */
export const formatSeconds = (seconds: bigint | number): string => formatAge(Number(seconds) * 1000);

/** Whole days from one unix-second instant to another, rounded down. */
export const daysBetween = (fromS: number, toS: number): number => Math.floor((toS - fromS) / 86_400);

/** "CABC...WXYZ" for long ids. */
export function shortId(id: string, keep = 4): string {
  return id.length <= keep * 2 + 3 ? id : `${id.slice(0, keep)}...${id.slice(-keep)}`;
}
