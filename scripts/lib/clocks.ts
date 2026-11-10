// Calls into the Two Clocks contract, the Chainlink proxy and the Chainlink
// verifier, plus the ScVal builders the calls need. Shared by every script.
import { Address, nativeToScVal, xdr, type Keypair } from '@stellar/stellar-sdk';
import { HEARTBEAT_S, type Asset, type NetworkName } from '../../src/lib/feeds.ts';
import { bytesToHex, formatE18 } from '../../src/lib/report.ts';
import { formatSeconds, invoke, read, readDeployments, unixToIso, type CallResult, type Network } from './stellar.ts';

// ---- Native shapes, as scValToNative returns them ---------------------------

/** `PushLeg`. The answer is at 18 decimals. */
export interface PushLeg {
  answer: bigint;
  round_id: bigint;
  timestamp: bigint;
  stored_at: bigint;
}

/** `PullLeg`. Prices at 18 decimals, times in unix seconds. */
export interface PullLeg {
  price: bigint;
  bid: bigint;
  ask: bigint;
  valid_from: bigint;
  observations_ts: bigint;
  expires_at: bigint;
  stream_id: Uint8Array;
  stored_at: bigint;
}

export interface Pair {
  push: PushLeg | null;
  pull: PullLeg | null;
}

/** `ReportV3` as `verify_report` returns it. */
export interface ReportV3Native {
  stream_id: Uint8Array;
  valid_from: bigint;
  observations_ts: bigint;
  expires_at: bigint;
  price: bigint;
  bid: bigint;
  ask: bigint;
}

export interface ClocksConfig {
  admin: string;
  proxy: string;
  verifier: string;
  max_push_age_s: bigint;
  max_pull_age_s: bigint;
}

export interface AssetView {
  data_id: Uint8Array;
  label: string;
  stream_id: Uint8Array | null;
}

/** The proxy's `Round`. */
export interface Round {
  answer: bigint;
  round_id: bigint;
  timestamp: bigint;
}

/** `FreshPrice`. A unit enum variant comes back as a one-element array. */
export interface FreshPrice {
  price: bigint;
  source: ['Push'] | ['Pull'];
  timestamp: bigint;
}

// ---- ScVal builders ---------------------------------------------------------

/** 64 hex characters (0x optional) as BytesN<32>. */
export function bytes32ScVal(hex: string): xdr.ScVal {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error(`not 32 bytes of hex: "${hex}"`);
  return xdr.ScVal.scvBytes(Buffer.from(clean, 'hex'));
}

export function dataIdScVal(asset: Pick<Asset, 'dataId'>): xdr.ScVal {
  return bytes32ScVal(asset.dataId);
}

/** Vec<BytesN<32>> of data ids, in the order given. */
export function dataIdsScVal(assets: readonly Pick<Asset, 'dataId'>[]): xdr.ScVal {
  return xdr.ScVal.scvVec(assets.map(dataIdScVal));
}

export function bytesScVal(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

export function u64ScVal(value: number | bigint): xdr.ScVal {
  return nativeToScVal(value, { type: 'u64' });
}

export function u32ScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: 'u32' });
}

export function addressScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/**
 * `AssetInit { data_id, label, stream_id: Option<BytesN<32>> }` as a map with
 * its keys in ascending symbol order. None is void, Some is the bytes.
 */
export function assetInitScVal(asset: Asset, net: NetworkName): xdr.ScVal {
  const streamId = asset.streamIds[net];
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('data_id'), val: dataIdScVal(asset) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('label'), val: xdr.ScVal.scvString(asset.label) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('stream_id'),
      val: streamId ? bytes32ScVal(streamId) : xdr.ScVal.scvVoid(),
    }),
  ]);
}

export interface ConstructorInput {
  admin: string;
  proxy: string;
  verifier: string;
  maxPushAgeS: number;
  maxPullAgeS: number;
  assets: readonly Asset[];
  net: NetworkName;
}

/** `__constructor(admin, proxy, verifier, max_push_age_s, max_pull_age_s, assets)` in that order. */
export function constructorArgs(input: ConstructorInput): xdr.ScVal[] {
  return [
    addressScVal(input.admin),
    addressScVal(input.proxy),
    addressScVal(input.verifier),
    u64ScVal(input.maxPushAgeS),
    u64ScVal(input.maxPullAgeS),
    xdr.ScVal.scvVec(input.assets.map((asset) => assetInitScVal(asset, input.net))),
  ];
}

// ---- Two Clocks -------------------------------------------------------------

/** The deployed contract id for a network, from --contract or src/deployments.json. */
export function clocksId(net: Network, override?: string): string {
  const id = override ?? readDeployments()[net.name]?.twoClocks;
  if (!id) {
    throw new Error(
      `no two-clocks deployment for ${net.name} in src/deployments.json. Run "pnpm deploy -- --network ${net.name}" first, or pass --contract <C...>.`,
    );
  }
  return id;
}

/** `refresh(data_ids)`: one transaction, returns the number of legs stored. */
export function refreshAssets(
  net: Network,
  contract: string,
  keypair: Keypair,
  assets: readonly Asset[],
): Promise<CallResult<number>> {
  return invoke<number>(net, contract, 'refresh', [dataIdsScVal(assets)], { send: true, keypair, scope: 'clocks' });
}

/** `refresh_one(data_id)`: returns the stored push leg. */
export function refreshOne(net: Network, contract: string, keypair: Keypair, asset: Asset): Promise<CallResult<PushLeg>> {
  return invoke<PushLeg>(net, contract, 'refresh_one', [dataIdScVal(asset)], { send: true, keypair, scope: 'clocks' });
}

/** `submit_report(signed_report)`: verify, decode, store, return the pull leg. */
export function submitReport(
  net: Network,
  contract: string,
  keypair: Keypair,
  signedReport: Uint8Array,
): Promise<CallResult<PullLeg>> {
  return invoke<PullLeg>(net, contract, 'submit_report', [bytesScVal(signedReport)], {
    send: true,
    keypair,
    scope: 'clocks',
  });
}

/** `verify_report(signed_report)` by simulation: the verifier runs, nothing is stored. */
export function verifyReport(net: Network, contract: string, signedReport: Uint8Array, source?: string): Promise<ReportV3Native> {
  return read<ReportV3Native>(net, contract, 'verify_report', [bytesScVal(signedReport)], { source, scope: 'clocks' });
}

/** `verify(signed_report, sender)` on the Chainlink verifier itself, by simulation. The source account is the sender. */
export function verifyRaw(net: Network, signedReport: Uint8Array, source: string): Promise<Uint8Array> {
  return read<Uint8Array>(net, net.verifier, 'verify', [bytesScVal(signedReport), addressScVal(source)], {
    source,
    scope: 'verifier',
  });
}

export function readLatestMany(net: Network, contract: string, assets: readonly Asset[], source?: string): Promise<Pair[]> {
  return read<Pair[]>(net, contract, 'latest_many', [dataIdsScVal(assets)], { source, scope: 'clocks' });
}

export function readAssets(net: Network, contract: string, source?: string): Promise<AssetView[]> {
  return read<AssetView[]>(net, contract, 'assets', [], { source, scope: 'clocks' });
}

export function readConfig(net: Network, contract: string, source?: string): Promise<ClocksConfig> {
  return read<ClocksConfig>(net, contract, 'config', [], { source, scope: 'clocks' });
}

export function readSpreadBps(net: Network, contract: string, asset: Asset, source?: string): Promise<bigint> {
  return read<bigint>(net, contract, 'spread_bps', [dataIdScVal(asset)], { source, scope: 'clocks' });
}

export function readFreshPrice(net: Network, contract: string, asset: Asset, maxAgeS: number, source?: string): Promise<FreshPrice> {
  return read<FreshPrice>(net, contract, 'fresh_price', [dataIdScVal(asset), u64ScVal(maxAgeS)], { source, scope: 'clocks' });
}

// ---- Chainlink proxy --------------------------------------------------------

export function proxyLatestRound(net: Network, dataId: string, decimals = 18, source?: string): Promise<Round> {
  return read<Round>(net, net.proxy, 'latest_round', [bytes32ScVal(dataId), u32ScVal(decimals)], { source, scope: 'proxy' });
}

export function proxyGetRound(net: Network, dataId: string, roundId: number | bigint, decimals = 18, source?: string): Promise<Round> {
  return read<Round>(net, net.proxy, 'get_round', [bytes32ScVal(dataId), u64ScVal(roundId), u32ScVal(decimals)], {
    source,
    scope: 'proxy',
  });
}

export function proxyDescription(net: Network, dataId: string, source?: string): Promise<string> {
  return read<string>(net, net.proxy, 'description', [bytes32ScVal(dataId)], { source, scope: 'proxy' });
}

export function proxyDecimals(net: Network, dataId: string, source?: string): Promise<number> {
  return read<number>(net, net.proxy, 'decimals', [bytes32ScVal(dataId)], { source, scope: 'proxy' });
}

export function proxyMinDecimals(net: Network, dataId: string, source?: string): Promise<number> {
  return read<number>(net, net.proxy, 'get_min_decimals', [bytes32ScVal(dataId)], { source, scope: 'proxy' });
}

export function proxyVersion(net: Network, source?: string): Promise<number> {
  return read<number>(net, net.proxy, 'version', [], { source, scope: 'proxy' });
}

export function proxyTypeAndVersion(net: Network, source?: string): Promise<string> {
  return read<string>(net, net.proxy, 'type_and_version', [], { source, scope: 'proxy' });
}

export function verifierIsInitialized(net: Network, source?: string): Promise<boolean> {
  return read<boolean>(net, net.verifier, 'is_initialized', [], { source, scope: 'verifier' });
}

// ---- Describing legs --------------------------------------------------------

/** (pull - push) * 10_000 / push, the contract's spread_bps in TypeScript. */
export function spreadBps(pullPrice: bigint, pushAnswer: bigint): bigint {
  if (pushAnswer === 0n) throw new Error('push answer is zero');
  return ((pullPrice - pushAnswer) * 10_000n) / pushAnswer;
}

/** Change from `before` to `after` in basis points, as "+12.3 bps". */
export function formatBps(before: bigint, after: bigint): string {
  if (before === 0n) return 'n/a';
  const tenths = ((after - before) * 100_000n) / before;
  const sign = tenths < 0n ? '-' : '+';
  const abs = tenths < 0n ? -tenths : tenths;
  return `${sign}${abs / 10n}.${abs % 10n} bps`;
}

export type PushState = 'fresh' | 'due' | 'stale';

/** stale when the feed time is older than max_push_age_s, due when it is past the heartbeat. */
export function pushState(leg: PushLeg, nowSec: number, net: NetworkName, maxPushAgeS?: number): PushState {
  const age = nowSec - Number(leg.timestamp);
  if (maxPushAgeS !== undefined && age > maxPushAgeS) return 'stale';
  if (age > HEARTBEAT_S[net]) return 'due';
  return 'fresh';
}

export interface DescribeOptions {
  net: NetworkName;
  nowSec: number;
  maxPushAgeS?: number;
}

/** "price 0.147519 USD, round 2338, feed 2026-11-09T18:38:29Z, age 4 min 40 s, heartbeat in 23 h 55 min, fresh". */
export function describePush(leg: PushLeg, opts: DescribeOptions): string {
  const age = opts.nowSec - Number(leg.timestamp);
  const untilHeartbeat = HEARTBEAT_S[opts.net] - age;
  return [
    `price ${formatE18(leg.answer)} USD`,
    `round ${leg.round_id}`,
    `feed ${unixToIso(Number(leg.timestamp))}`,
    `age ${formatSeconds(age)}`,
    untilHeartbeat >= 0 ? `heartbeat in ${formatSeconds(untilHeartbeat)}` : `heartbeat overdue by ${formatSeconds(-untilHeartbeat)}`,
    pushState(leg, opts.nowSec, opts.net, opts.maxPushAgeS),
  ].join(', ');
}

export function describePull(leg: PullLeg, nowSec: number): string {
  const expires = Number(leg.expires_at);
  return [
    `price ${formatE18(leg.price)} USD`,
    `bid ${formatE18(leg.bid)}`,
    `ask ${formatE18(leg.ask)}`,
    `observed ${unixToIso(Number(leg.observations_ts))}`,
    `age ${formatSeconds(nowSec - Number(leg.observations_ts))}`,
    expires > nowSec ? `expires ${unixToIso(expires)}` : `expired ${unixToIso(expires)}`,
    `stream ${bytesToHex(leg.stream_id, true).slice(0, 12)}...`,
  ].join(', ');
}

/** Two or three log lines for one asset: the push leg, the pull leg (or why there is none) and the spread. */
export function describePair(asset: Asset, pair: Pair, opts: DescribeOptions): string[] {
  const lines: string[] = [];
  lines.push(`${asset.key}  push: ${pair.push ? describePush(pair.push, opts) : 'nothing stored yet'}`);
  if (pair.pull) {
    lines.push(`${' '.repeat(asset.key.length)}  pull: ${describePull(pair.pull, opts.nowSec)}`);
  } else if (asset.streamIds[opts.net]) {
    lines.push(`${' '.repeat(asset.key.length)}  pull: no accepted report yet (the only public sample expired 2026-05-03)`);
  } else {
    lines.push(`${' '.repeat(asset.key.length)}  pull: no stream on this network`);
  }
  if (pair.push && pair.pull && pair.push.answer !== 0n) {
    lines.push(`${' '.repeat(asset.key.length)}  spread ${spreadBps(pair.pull.price, pair.push.answer)} bps (pull against push)`);
  }
  return lines;
}
