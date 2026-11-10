// Chainlink Data Streams report bytes, decoded in plain TypeScript.
// A signed report is abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs, bytes32[] ss, bytes32 rawVs).
// Schema v3 reportData is nine 32-byte words: feedId, validFromTimestamp, observationsTimestamp,
// nativeFee, linkFee, expiresAt, price, bid, ask. Prices are 18 decimals.
// No Node imports here: the browser, the scripts and the tests all use this file.

export const WORD = 32;
export const REPORT_V3_WORDS = 9;
export const REPORT_V3_BYTES = WORD * REPORT_V3_WORDS;

export interface FullReport {
  readonly context: readonly [Uint8Array, Uint8Array, Uint8Array];
  readonly reportData: Uint8Array;
  readonly rs: readonly Uint8Array[];
  readonly ss: readonly Uint8Array[];
  readonly rawVs: Uint8Array;
  /** Byte offset of reportData inside the full report. The sample has it at 256. */
  readonly reportDataOffset: number;
}

export interface ReportV3 {
  /** 0x-prefixed 32-byte stream id. The first two bytes carry the schema version (0x0003). */
  readonly streamId: string;
  readonly schemaVersion: number;
  readonly validFrom: number;
  readonly observationsTs: number;
  readonly expiresAt: number;
  readonly nativeFee: bigint;
  readonly linkFee: bigint;
  readonly price: bigint;
  readonly bid: bigint;
  readonly ask: bigint;
}

export class ReportDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportDecodeError';
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new ReportDecodeError('not a hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, prefix = false): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return prefix ? `0x${s}` : s;
}

/** Returns a copy with one bit flipped. Byte 479 of the sample report is the low byte of the price. */
export function flipBit(bytes: Uint8Array, byteIndex: number, bit = 0): Uint8Array {
  if (byteIndex < 0 || byteIndex >= bytes.length) throw new ReportDecodeError(`byte ${byteIndex} is outside the report`);
  const copy = new Uint8Array(bytes);
  copy[byteIndex] = (copy[byteIndex] ?? 0) ^ (1 << bit);
  return copy;
}

function word(bytes: Uint8Array, index: number): Uint8Array {
  const start = index * WORD;
  if (start + WORD > bytes.length) throw new ReportDecodeError(`word ${index} is outside the data (${bytes.length} bytes)`);
  return bytes.subarray(start, start + WORD);
}

function wordToUnsigned(w: Uint8Array): bigint {
  let v = 0n;
  for (const b of w) v = (v << 8n) | BigInt(b);
  return v;
}

/** A uint32 stored right-aligned in a word. The 28 leading bytes must be zero. */
function wordToU32(w: Uint8Array, name: string): number {
  for (let i = 0; i < WORD - 4; i++) if (w[i] !== 0) throw new ReportDecodeError(`${name} does not fit in 32 bits`);
  return Number(wordToUnsigned(w.subarray(WORD - 4)));
}

/** A two's complement integer in a word. int192 values are sign-extended to 256 bits. */
function wordToSigned(w: Uint8Array): bigint {
  const unsigned = wordToUnsigned(w);
  return (w[0] ?? 0) & 0x80 ? unsigned - (1n << 256n) : unsigned;
}

function offsetAt(bytes: Uint8Array, index: number, name: string): number {
  const v = wordToUnsigned(word(bytes, index));
  if (v > BigInt(bytes.length)) throw new ReportDecodeError(`${name} offset ${v} is outside the report`);
  return Number(v);
}

function dynamicBytes(bytes: Uint8Array, offset: number, name: string): Uint8Array {
  if (offset + WORD > bytes.length) throw new ReportDecodeError(`${name} length word is outside the report`);
  const len = Number(wordToUnsigned(bytes.subarray(offset, offset + WORD)));
  const start = offset + WORD;
  if (start + len > bytes.length) throw new ReportDecodeError(`${name} runs past the end of the report`);
  return bytes.subarray(start, start + len);
}

function dynamicWords(bytes: Uint8Array, offset: number, name: string): Uint8Array[] {
  if (offset + WORD > bytes.length) throw new ReportDecodeError(`${name} count word is outside the report`);
  const count = Number(wordToUnsigned(bytes.subarray(offset, offset + WORD)));
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = offset + WORD * (i + 1);
    if (start + WORD > bytes.length) throw new ReportDecodeError(`${name}[${i}] is outside the report`);
    out.push(bytes.subarray(start, start + WORD));
  }
  return out;
}

/** Splits the ABI envelope. Throws ReportDecodeError on a bad layout. */
export function decodeFullReport(input: Uint8Array | string): FullReport {
  const bytes = typeof input === 'string' ? hexToBytes(input) : input;
  if (bytes.length < WORD * 7) throw new ReportDecodeError(`a signed report has at least 224 bytes, got ${bytes.length}`);
  const context: [Uint8Array, Uint8Array, Uint8Array] = [word(bytes, 0), word(bytes, 1), word(bytes, 2)];
  const dataOffset = offsetAt(bytes, 3, 'reportData');
  const rsOffset = offsetAt(bytes, 4, 'rs');
  const ssOffset = offsetAt(bytes, 5, 'ss');
  const rawVs = word(bytes, 6);
  return {
    context,
    reportData: dynamicBytes(bytes, dataOffset, 'reportData'),
    rs: dynamicWords(bytes, rsOffset, 'rs'),
    ss: dynamicWords(bytes, ssOffset, 'ss'),
    rawVs,
    reportDataOffset: dataOffset + WORD,
  };
}

/** Decodes the nine words of a v3 report. */
export function decodeReportV3(reportData: Uint8Array): ReportV3 {
  if (reportData.length !== REPORT_V3_BYTES) {
    throw new ReportDecodeError(`a v3 report is ${REPORT_V3_BYTES} bytes, got ${reportData.length}`);
  }
  const streamIdWord = word(reportData, 0);
  const schemaVersion = ((streamIdWord[0] ?? 0) << 8) | (streamIdWord[1] ?? 0);
  if (schemaVersion !== 3) throw new ReportDecodeError(`schema ${schemaVersion} is not v3`);
  return {
    streamId: bytesToHex(streamIdWord, true),
    schemaVersion,
    validFrom: wordToU32(word(reportData, 1), 'validFromTimestamp'),
    observationsTs: wordToU32(word(reportData, 2), 'observationsTimestamp'),
    nativeFee: wordToUnsigned(word(reportData, 3)),
    linkFee: wordToUnsigned(word(reportData, 4)),
    expiresAt: wordToU32(word(reportData, 5), 'expiresAt'),
    price: wordToSigned(word(reportData, 6)),
    bid: wordToSigned(word(reportData, 7)),
    ask: wordToSigned(word(reportData, 8)),
  };
}

/** Envelope plus v3 payload in one call. */
export function decodeSignedReport(input: Uint8Array | string): { full: FullReport; report: ReportV3 } {
  const full = decodeFullReport(input);
  return { full, report: decodeReportV3(full.reportData) };
}

export function isExpired(report: Pick<ReportV3, 'expiresAt'>, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  return report.expiresAt <= nowSec;
}

/** Formats an 18-decimal integer as a decimal string with `fractionDigits` digits (truncated, not rounded). */
export function formatE18(value: bigint, fractionDigits = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, '0').slice(0, fractionDigits);
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${wholeStr}${fractionDigits > 0 ? `.${frac}` : ''}`;
}
