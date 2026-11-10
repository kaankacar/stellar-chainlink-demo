// The published testnet sample through the TypeScript decoder: offsets, dates,
// prices, the byte-479 flip, and the layouts that must throw.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REPORT_V3_BYTES,
  ReportDecodeError,
  bytesToHex,
  decodeFullReport,
  decodeReportV3,
  decodeSignedReport,
  flipBit,
  formatE18,
  hexToBytes,
  isExpired,
} from '../src/lib/report.ts';

const FIXTURE_URL = new URL('../contracts/two-clocks/fixtures/streams-eth-usd-testnet-sample.hex', import.meta.url);
const fixtureHex = readFileSync(FIXTURE_URL, 'utf8').trim();
const fixture = hexToBytes(fixtureHex);

const SAMPLE_STREAM = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';
const OBSERVATIONS = 1775220938;
const EXPIRES = 1777812938;

describe('fixture envelope', () => {
  it('is 736 bytes with 288 bytes of reportData at offset 256', () => {
    expect(fixture.length).toBe(736);
    expect(fixtureHex.startsWith('00090d9e8d96765a')).toBe(true);
    const full = decodeFullReport(fixture);
    expect(full.reportData.length).toBe(REPORT_V3_BYTES);
    expect(full.reportDataOffset).toBe(256);
    expect(BigInt(`0x${bytesToHex(fixture.subarray(224, 256))}`)).toBe(288n);
    expect(bytesToHex(full.reportData)).toBe(fixtureHex.slice(256 * 2, (256 + 288) * 2));
  });

  it('carries two signatures, so f = 1', () => {
    const full = decodeFullReport(fixture);
    expect(full.rs).toHaveLength(2);
    expect(full.ss).toHaveLength(2);
    expect(full.context).toHaveLength(3);
    expect(full.rawVs.length).toBe(32);
    for (const sig of [...full.rs, ...full.ss]) expect(sig.length).toBe(32);
  });

  it('accepts the hex string directly, with or without 0x', () => {
    expect(decodeFullReport(fixtureHex).reportDataOffset).toBe(256);
    expect(decodeFullReport(`0x${fixtureHex}`).reportDataOffset).toBe(256);
  });
});

describe('fixture report v3', () => {
  it('decodes the stream, the dates and the prices SPEC lists', () => {
    const { report } = decodeSignedReport(fixture);
    expect(report.streamId).toBe(SAMPLE_STREAM);
    expect(report.schemaVersion).toBe(3);
    expect(report.validFrom).toBe(OBSERVATIONS);
    expect(report.observationsTs).toBe(OBSERVATIONS);
    expect(new Date(report.observationsTs * 1000).toISOString()).toBe('2026-04-03T12:55:38.000Z');
    expect(report.expiresAt).toBe(EXPIRES);
    expect(new Date(report.expiresAt * 1000).toISOString()).toBe('2026-05-03T12:55:38.000Z');
    expect(formatE18(report.price)).toBe('2,050.205901');
    expect(formatE18(report.bid)).toBe('2,050.188807');
    expect(formatE18(report.ask)).toBe('2,050.293175');
    expect(report.bid < report.price && report.price < report.ask).toBe(true);
    expect(report.nativeFee).toBeGreaterThan(0n);
    expect(report.linkFee).toBeGreaterThan(0n);
  });

  it('is expired now and was valid one second before expiresAt', () => {
    const { report } = decodeSignedReport(fixture);
    expect(isExpired(report, EXPIRES)).toBe(true);
    expect(isExpired(report, EXPIRES - 1)).toBe(false);
    expect(isExpired(report)).toBe(true);
  });
});

describe('flipBit', () => {
  it('byte 479 changes only the low bit of the price', () => {
    const tampered = flipBit(fixture, 479);
    const before = decodeSignedReport(fixture).report;
    const after = decodeSignedReport(tampered).report;
    expect(after.price).toBe(before.price ^ 1n);
    expect(after.bid).toBe(before.bid);
    expect(after.ask).toBe(before.ask);
    expect(after.streamId).toBe(before.streamId);
    expect(after.observationsTs).toBe(before.observationsTs);
    expect(after.expiresAt).toBe(before.expiresAt);
    const changed = [...fixture].map((b, i) => (b === tampered[i] ? -1 : i)).filter((i) => i >= 0);
    expect(changed).toEqual([479]);
    expect(bytesToHex(fixture)).toBe(fixtureHex);
  });

  it('flips another bit on request and refuses an index outside the report', () => {
    expect(flipBit(fixture, 0, 7)[0]).toBe((fixture[0] ?? 0) ^ 0x80);
    expect(() => flipBit(fixture, 736)).toThrow(ReportDecodeError);
    expect(() => flipBit(fixture, -1)).toThrow(/outside/);
  });
});

describe('bad layouts', () => {
  const reportData = (): Uint8Array => new Uint8Array(decodeFullReport(fixture).reportData);

  it('287 bytes of report data throw', () => {
    expect(() => decodeReportV3(reportData().subarray(0, 287))).toThrow(ReportDecodeError);
    expect(() => decodeReportV3(reportData().subarray(0, 287))).toThrow(/288 bytes, got 287/);
  });

  it('schema 0x0006 throws', () => {
    const data = reportData();
    data[1] = 6;
    expect(() => decodeReportV3(data)).toThrow(/schema 6 is not v3/);
  });

  it('a u32 word with a non-zero high byte throws and names the field', () => {
    const data = reportData();
    data[32] = 1;
    expect(() => decodeReportV3(data)).toThrow(/validFromTimestamp/);
    const later = reportData();
    later[5 * 32 + 3] = 0xff;
    expect(() => decodeReportV3(later)).toThrow(/expiresAt/);
  });

  it('a truncated envelope throws', () => {
    expect(() => decodeFullReport(fixture.subarray(0, 200))).toThrow(/at least 224 bytes/);
    expect(() => decodeFullReport(fixture.subarray(0, 300))).toThrow(ReportDecodeError);
    expect(() => decodeFullReport(fixture.subarray(0, 735))).toThrow(ReportDecodeError);
  });

  it('an offset outside the report throws', () => {
    const bad = new Uint8Array(fixture);
    bad[3 * 32 + 30] = 0xff;
    bad[3 * 32 + 31] = 0xff;
    expect(() => decodeFullReport(bad)).toThrow(/reportData offset 65535 is outside/);
  });

  it('hexToBytes rejects odd lengths and non-hex', () => {
    expect(() => hexToBytes('abc')).toThrow(ReportDecodeError);
    expect(() => hexToBytes('zz')).toThrow(/not a hex string/);
    expect([...hexToBytes(' 0xAbCd\n')]).toEqual([0xab, 0xcd]);
  });
});

describe('formatE18', () => {
  it('truncates, groups thousands and keeps the sign', () => {
    expect(formatE18(147519375000000000n)).toBe('0.147519');
    expect(formatE18(2050205901000000000000n, 2)).toBe('2,050.20');
    expect(formatE18(-1500000000000000000n, 3)).toBe('-1.500');
    expect(formatE18(10n ** 18n, 0)).toBe('1');
    expect(formatE18(123456789n * 10n ** 18n)).toBe('123,456,789.000000');
  });
});
