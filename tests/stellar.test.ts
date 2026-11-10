// Pure helpers from stellar.ts and clocks.ts: the mainnet guard, the three
// error tables, the ScVal builders in SPEC order, and the leg descriptions.
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ASSETS, assetByKey, type Asset } from '../src/lib/feeds.ts';
import {
  assetInitScVal,
  bytes32ScVal,
  constructorArgs,
  dataIdsScVal,
  describePair,
  formatBps,
  pushState,
  spreadBps,
  u64ScVal,
  type Pair,
  type PushLeg,
} from '../scripts/lib/clocks.ts';
import {
  CLOCKS_ERRORS,
  ContractCallError,
  MAINNET_READER,
  NETWORKS,
  PROXY_ERRORS,
  TESTNET_READER,
  VERIFIER_ERRORS,
  contractErrorCode,
  errorName,
  explainError,
  formatSeconds,
  parseNetwork,
  requireSendableNetwork,
  stroopsToXlm,
  unixToIso,
} from '../scripts/lib/stellar.ts';

function asset(key: string): Asset {
  const found = assetByKey(key);
  if (!found) throw new Error(`no asset ${key}`);
  return found;
}

describe('network table', () => {
  it('refuses to send on mainnet and allows testnet', () => {
    expect(() => requireSendableNetwork(NETWORKS.mainnet)).toThrow(/read-only/);
    expect(() => requireSendableNetwork(parseNetwork('testnet'))).not.toThrow();
    expect(() => parseNetwork('futurenet')).toThrow(/--network/);
  });

  it('carries the Chainlink proxy, the verifier and a reader per network', () => {
    expect(NETWORKS.testnet.proxy).toBe('CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4');
    expect(NETWORKS.mainnet.proxy).toBe('CDQBHEUGLDHMSUHG4IH33RJBUTMNCZOT4JIAQR4WZFRDZW6DR6S32ZLZ');
    expect(NETWORKS.testnet.verifier).toBe('CA7GVHWH4GRHE6GI7MHEKQZAOYO4GE7KRGSU3EOS3HYJRVLX3XEA4ONQ');
    expect(NETWORKS.mainnet.verifier).toBe('CAKA3NBYPC6OBEUEGNIYGNYG3ES2GPQK736B5SR7ASGUXRDAKXI2JCQI');
    expect(NETWORKS.mainnet.reader).toBe(MAINNET_READER);
    expect(NETWORKS.testnet.reader).toBe(TESTNET_READER);
    expect(NETWORKS.testnet.friendbot).toBeDefined();
    expect(NETWORKS.mainnet.friendbot).toBeUndefined();
    expect(parseNetwork('mainnet').explorer).toBe('public');
  });
});

describe('error tables', () => {
  it('name the verifier codes 2 to 18', () => {
    for (let code = 2; code <= 18; code++) expect(VERIFIER_ERRORS[code]?.name).toBeDefined();
    expect(errorName(9, 'verifier')).toBe('DigestNotSet');
    expect(errorName(12, 'verifier')).toBe('BadVerification');
    expect(errorName(16, 'verifier')).toBe('InvalidReportFormat');
    expect(errorName(20, 'verifier')).toBeUndefined();
  });

  it('name the proxy codes and the frozen-feed panic', () => {
    expect(Object.keys(PROXY_ERRORS).map(Number)).toEqual([50, 51, 52, 109]);
    expect(errorName(50, 'proxy')).toBe('NoDataPresent');
    expect(errorName(51, 'proxy')).toBe('InvalidDecimals');
    expect(errorName(52, 'proxy')).toBe('RoundsToZero');
    expect(errorName(109, 'proxy')).toBe('FeedFrozen');
  });

  it('the clocks table holds its own codes plus both pass-throughs', () => {
    const own = ['Stale', 'NothingNew', 'NotFound', 'Expired', 'NotYetValid', 'UnsupportedSchema', 'MalformedReport', 'Overflow', 'UnknownAsset', 'UnknownStream', 'TooManyAssets', 'ProxyInvokeFailed', 'VerifierInvokeFailed'];
    own.forEach((name, i) => expect(errorName(20 + i)).toBe(name));
    expect(errorName(12)).toBe('BadVerification');
    expect(errorName(109)).toBe('FeedFrozen');
    const codes = Object.keys(CLOCKS_ERRORS)
      .map(Number)
      .sort((a, b) => a - b);
    const expected = [...Array.from({ length: 17 }, (_, i) => i + 2), ...Array.from({ length: 13 }, (_, i) => i + 20), 50, 51, 52, 109];
    expect(codes).toEqual(expected);
  });

  it('explains codes per scope and the host error branches', () => {
    expect(contractErrorCode('HostError: Error(Contract, #23)\nmore')).toBe(23);
    expect(contractErrorCode('no code here')).toBeUndefined();
    expect(explainError('Error(Contract, #23)')).toContain('Expired');
    expect(explainError('Error(Contract, #21)')).toContain('NothingNew');
    expect(explainError('Error(Contract, #9)', 'verifier')).toContain('DigestNotSet');
    expect(explainError('Error(Contract, #50)', 'proxy')).toContain('NoDataPresent');
    expect(explainError('Error(Contract, #23)', 'proxy')).toContain('not in the proxy error table');
    expect(explainError('Error(Contract, #1)')).toContain('not in the clocks error table');
    expect(explainError('x Error(Storage, MissingValue) y')).toContain('Storage/MissingValue');
    expect(explainError('x Error(Auth, InvalidAction) y')).toContain('host error Auth');
    expect(explainError('x Error(Budget, ExceededLimit) y')).toContain('Budget/ExceededLimit');
    expect(explainError('x Error(Crypto, InvalidInput) y')).toContain('Crypto/InvalidInput');
    expect(explainError('something else')).toBe('something else');
  });
});

describe('ContractCallError', () => {
  it('decodes a clocks code and carries no fee from a simulation', () => {
    const error = new ContractCallError('simulate', 'HostError: Error(Contract, #21)\nmore lines');
    expect(error.code).toBe(21);
    expect(error.feeCharged).toBeUndefined();
    expect(error.message).toContain('NothingNew');
    expect(error.raw).toContain('more lines');
  });

  it('uses the scope and carries the fee of a transaction that failed on chain', () => {
    const verifier = new ContractCallError('simulate', 'Error(Contract, #12)', 'verifier');
    expect(verifier.message).toContain('BadVerification');
    const polled = new ContractCallError('poll', 'transaction abc failed in ledger 1', 'clocks', 1_234_567n);
    expect(polled.feeCharged).toBe(1_234_567n);
    expect(polled.code).toBeUndefined();
    expect(polled.stage).toBe('poll');
  });
});

describe('helpers', () => {
  it('formats stroops, unix seconds and durations', () => {
    expect(stroopsToXlm(1_234_567n)).toBe('0.1234567 XLM');
    expect(stroopsToXlm(10_000_000n)).toBe('1.0000000 XLM');
    expect(stroopsToXlm(-5n)).toBe('-0.0000005 XLM');
    expect(unixToIso(1775220938)).toBe('2026-04-03T12:55:38Z');
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(280)).toBe('4 min 40 s');
    expect(formatSeconds(86100)).toBe('23 h 55 min');
    expect(formatSeconds(3 * 86400 + 4 * 3600)).toBe('3 d 4 h');
    expect(formatSeconds(-90)).toBe('-1 min 30 s');
  });
});

describe('ScVal builders', () => {
  it('bytes32ScVal takes 64 hex with or without 0x and rejects other lengths', () => {
    const value = bytes32ScVal(`0x${'ab'.repeat(32)}`);
    expect(value.type).toBe('scvBytes');
    expect((scValToNative(value) as Uint8Array).length).toBe(32);
    expect(bytes32ScVal('AB'.repeat(32)).toXDR('base64')).toBe(value.toXDR('base64'));
    expect(() => bytes32ScVal('abcd')).toThrow(/32 bytes/);
    expect(() => bytes32ScVal('zz'.repeat(32))).toThrow(/32 bytes/);
  });

  it('assetInitScVal is a map keyed data_id, label, stream_id in that order; None is void', () => {
    const xlm = asset('xlm');
    const value = assetInitScVal(xlm, 'testnet');
    expect(value.type).toBe('scvMap');
    const entries = value.type === 'scvMap' ? (value.map ?? []) : [];
    expect(entries.map((entry) => scValToNative(entry.key))).toEqual(['data_id', 'label', 'stream_id']);
    expect(entries.map((entry) => entry.val.type)).toEqual(['scvBytes', 'scvString', 'scvBytes']);
    const native = scValToNative(value) as { data_id: Uint8Array; label: string; stream_id: Uint8Array | null };
    expect(Buffer.from(native.data_id).toString('hex')).toBe(xlm.dataId);
    expect(native.label).toBe('XLM / USD');
    expect(native.stream_id && Buffer.from(native.stream_id).toString('hex')).toBe(xlm.streamIds.testnet?.slice(2));

    const eurc = assetInitScVal(asset('eurc'), 'testnet');
    const eurcEntries = eurc.type === 'scvMap' ? (eurc.map ?? []) : [];
    expect(eurcEntries[2]?.val.type).toBe('scvVoid');
    expect((scValToNative(eurc) as { stream_id: unknown }).stream_id).toBeNull();

    const mainnetXlm = scValToNative(assetInitScVal(xlm, 'mainnet')) as { stream_id: Uint8Array };
    expect(Buffer.from(mainnetXlm.stream_id).toString('hex')).toBe(xlm.streamIds.mainnet?.slice(2));
  });

  it('constructorArgs follow the SPEC order and types and survive an XDR round trip', () => {
    const args = constructorArgs({
      admin: TESTNET_READER,
      proxy: NETWORKS.testnet.proxy,
      verifier: NETWORKS.testnet.verifier,
      maxPushAgeS: 90000,
      maxPullAgeS: 120,
      assets: ASSETS,
      net: 'testnet',
    });
    expect(args.map((arg) => arg.type)).toEqual(['scvAddress', 'scvAddress', 'scvAddress', 'scvU64', 'scvU64', 'scvVec']);
    expect(args.map((arg) => scValToNative(arg)).slice(0, 5)).toEqual([
      TESTNET_READER,
      NETWORKS.testnet.proxy,
      NETWORKS.testnet.verifier,
      90000n,
      120n,
    ]);
    const last = args[5];
    const vec = last?.type === 'scvVec' ? (last.vec ?? []) : [];
    expect(vec).toHaveLength(10);
    expect(vec.every((item) => item.type === 'scvMap')).toBe(true);
    for (const arg of args) expect(xdr.ScVal.fromXDR(arg.toXDR()).toXDR('base64')).toBe(arg.toXDR('base64'));
  });

  it('dataIdsScVal is a vec of 32-byte values in the order given', () => {
    const value = dataIdsScVal([asset('eth'), asset('xlm')]);
    expect(value.type).toBe('scvVec');
    const native = scValToNative(value) as Uint8Array[];
    expect(native.map((id) => Buffer.from(id).toString('hex'))).toEqual([asset('eth').dataId, asset('xlm').dataId]);
  });

  it('u64ScVal takes numbers and bigints', () => {
    expect(u64ScVal(5).type).toBe('scvU64');
    expect(scValToNative(u64ScVal(5n))).toBe(5n);
    expect(scValToNative(u64ScVal(90000))).toBe(90000n);
  });
});

describe('leg helpers', () => {
  const push: PushLeg = { answer: 147519375000000000n, round_id: 2338n, timestamp: 1794249509n, stored_at: 1794249600n };

  it('spreadBps and formatBps', () => {
    expect(spreadBps(1010n, 1000n)).toBe(100n);
    expect(spreadBps(990n, 1000n)).toBe(-100n);
    expect(() => spreadBps(1n, 0n)).toThrow(/zero/);
    expect(formatBps(10000n, 10012n)).toBe('+12.0 bps');
    expect(formatBps(100000n, 100123n)).toBe('+12.3 bps');
    expect(formatBps(1000n, 999n)).toBe('-10.0 bps');
    expect(formatBps(0n, 1n)).toBe('n/a');
  });

  it('pushState is fresh, then due past the heartbeat, then stale past max_push_age_s', () => {
    const t = Number(push.timestamp);
    expect(pushState(push, t + 10, 'testnet', 90000)).toBe('fresh');
    expect(pushState(push, t + 86356, 'testnet', 90000)).toBe('due');
    expect(pushState(push, t + 86356, 'mainnet', 90000)).toBe('fresh');
    expect(pushState(push, t + 90001, 'testnet', 90000)).toBe('stale');
    expect(pushState(push, t + 90001, 'testnet')).toBe('due');
  });

  it('describePair tells why a pull leg is missing', () => {
    const nowSec = Number(push.timestamp) + 280;
    const pair: Pair = { push, pull: null };
    const xlmLines = describePair(asset('xlm'), pair, { net: 'testnet', nowSec, maxPushAgeS: 90000 });
    expect(xlmLines).toHaveLength(2);
    expect(xlmLines[0]).toContain('price 0.147519 USD, round 2338, feed 2026-11-09T18:38:29Z, age 4 min 40 s');
    expect(xlmLines[0]).toContain('fresh');
    expect(xlmLines[1]).toContain('no accepted report yet');
    const eurcLines = describePair(asset('eurc'), pair, { net: 'testnet', nowSec });
    expect(eurcLines[1]).toContain('no stream on this network');
    const empty = describePair(asset('xlm'), { push: null, pull: null }, { net: 'testnet', nowSec });
    expect(empty[0]).toContain('nothing stored yet');
  });

  it('describePair adds the spread when both legs exist', () => {
    const pull = {
      price: 148000000000000000n,
      bid: 147900000000000000n,
      ask: 148100000000000000n,
      valid_from: push.timestamp,
      observations_ts: push.timestamp + 5n,
      expires_at: push.timestamp + 2_592_000n,
      stream_id: Buffer.from('00037dfe3b67b7552cf15e10ee5fb0c0ab6d658b20eb558effe2ae4579d24c58', 'hex'),
      stored_at: push.stored_at,
    };
    const lines = describePair(asset('xlm'), { push, pull }, { net: 'testnet', nowSec: Number(push.timestamp) + 60 });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('price 0.148000 USD, bid 0.147900, ask 0.148100');
    expect(lines[1]).toContain('expires 2026-12-09T18:38:29Z');
    expect(lines[2]).toContain(`spread ${spreadBps(pull.price, push.answer)} bps`);
  });
});
