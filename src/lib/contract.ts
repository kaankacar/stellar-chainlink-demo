/*
 * Read-only access to the Two Clocks contract, the Chainlink proxy and the Chainlink verifier.
 *
 * Soroban has no separate view call. The page builds a transaction that invokes
 * the function, asks the RPC to simulate it and decodes the return value.
 * Nothing is signed and nothing is submitted.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { FEED_DECIMALS } from './feeds';
import type { Deployment, NetworkInfo } from './networks';
import { bytesToHex, hexToBytes } from './report';

// ---- Sources ----------------------------------------------------------------

/** Mainnet account used as the envelope source for simulation. It exists and holds XLM. */
export const MAINNET_READER = 'GBTKQ2WYNYE5TJW3N5LH7PGGERX2EIBDIIN7X6LFHMVQQZCZT36KA3PC';

/** 32 zero bytes. Simulation only needs a well-formed envelope, so this works when no reader is configured. */
export const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** The simulation source for a network: the deployment's reader, else the mainnet reader, else the null account. */
export function sourceFor(net: NetworkInfo, dep: Deployment | null): string {
  if (dep?.reader) return dep.reader;
  return net.name === 'mainnet' ? MAINNET_READER : NULL_ACCOUNT;
}

// ---- Errors -----------------------------------------------------------------

/** Every code the contract can return. 2 to 18 and 50 to 109 pass through from Chainlink's contracts unchanged. */
export const ERROR_NAMES: Readonly<Record<number, string>> = {
  // verifier pass-through
  2: 'NotInitialized',
  3: 'ZeroAddress',
  4: 'FaultToleranceMustBePositive',
  5: 'ExcessSigners',
  6: 'InsufficientSigners',
  7: 'NonUniqueSignatures',
  8: 'DigestEmpty',
  9: 'DigestNotSet',
  10: 'DigestInactive',
  11: 'ConfigDigestAlreadySet',
  12: 'BadVerification',
  13: 'MismatchedSignatures',
  14: 'IncorrectSignatureCount',
  15: 'NoProposedOwner',
  16: 'InvalidReportFormat',
  17: 'SignatureRecoveryFailed',
  18: 'InvalidProposedOwner',
  // two-clocks
  20: 'Stale',
  21: 'NothingNew',
  22: 'NotFound',
  23: 'Expired',
  24: 'NotYetValid',
  25: 'UnsupportedSchema',
  26: 'MalformedReport',
  27: 'Overflow',
  28: 'UnknownAsset',
  29: 'UnknownStream',
  30: 'TooManyAssets',
  31: 'ProxyInvokeFailed',
  32: 'VerifierInvokeFailed',
  // proxy pass-through
  50: 'NoDataPresent',
  51: 'InvalidDecimals',
  52: 'RoundsToZero',
  109: 'FeedFrozen',
};

/** One sentence per code the page is likely to show. */
const EXPLANATIONS: Readonly<Record<number, string>> = {
  9: 'The verifier has no DON config for this report. The sample was signed for the testnet verifier, so mainnet answers DigestNotSet.',
  12: 'A signature does not recover to a registered signer. One changed byte anywhere in the report gives this.',
  14: 'The report does not carry exactly f+1 signatures.',
  16: 'The bytes are not an ABI-encoded signed report.',
  20: 'The round is older than the configured max age, or dated in the future.',
  21: 'The stored leg is already this new or newer. Nothing was written.',
  22: 'One of the two legs is missing, so there is no spread.',
  23: 'The report has passed its expiresAt. The verifier does not check this; the contract does.',
  24: 'The report is dated more than 60 s ahead of ledger time.',
  25: 'The stream id does not start with 0x0003, so this is not a schema v3 report.',
  26: 'The verified report data is not 288 bytes, or a timestamp word is not a u32.',
  27: 'A price does not fit in i128.',
  28: 'This data id is not configured in the contract.',
  29: 'No configured asset maps to this stream id.',
  31: 'The proxy call trapped before it could return a typed error.',
  32: 'The verifier call trapped before it could return a typed error.',
  50: 'The proxy holds no round for this data id.',
  51: 'The proxy refuses this decimals value. Ask for 8 to 18.',
  52: 'The answer truncates to zero at this decimals value.',
  109: 'The feed is frozen. The proxy panics instead of returning a typed error.',
};

const CODE_RE = /Error\(Contract, #(\d+)\)/;

/** N from "Error(Contract, #N)", or null when the text carries no contract error. */
export function contractErrorCode(message: string): number | null {
  const m = CODE_RE.exec(message);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

export const errorName = (code: number): string => ERROR_NAMES[code] ?? `code ${code}`;

const firstLine = (s: string): string => s.split('\n')[0]?.trim() ?? s;

function describe(method: string, raw: string): string {
  const code = contractErrorCode(raw);
  if (code === null) return `${method} failed: ${firstLine(raw)}`;
  return `${method} failed with error #${code} (${errorName(code)})`;
}

/** A simulation that ended in a host error. `code` is set when a contract returned a typed error. */
export class ContractError extends Error {
  readonly method: string;
  readonly code: number | null;
  readonly codeName: string | null;
  readonly raw: string;

  constructor(method: string, raw: string) {
    super(describe(method, raw));
    this.name = 'ContractError';
    this.method = method;
    this.raw = raw;
    this.code = contractErrorCode(raw);
    this.codeName = this.code !== null ? (ERROR_NAMES[this.code] ?? null) : null;
  }

  /** One sentence the reader can act on, when we have one for this code. */
  get explanation(): string | null {
    return this.code !== null ? (EXPLANATIONS[this.code] ?? null) : null;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ContractError) return err.explanation ? `${err.message}. ${err.explanation}` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---- Simulation -------------------------------------------------------------

const servers = new Map<string, rpc.Server>();

function server(net: NetworkInfo): rpc.Server {
  let s = servers.get(net.rpcUrl);
  if (!s) {
    s = new rpc.Server(net.rpcUrl);
    servers.set(net.rpcUrl, s);
  }
  return s;
}

const accounts = new Map<string, Promise<Account>>();

/** The envelope source. A real account is loaded once; anything that fails to load becomes the null account. */
function sourceAccount(net: NetworkInfo, source: string): Promise<Account> {
  const key = `${net.name}:${source}`;
  let p = accounts.get(key);
  if (!p) {
    const fallback = new Account(NULL_ACCOUNT, '0');
    p = source === NULL_ACCOUNT ? Promise.resolve(fallback) : server(net).getAccount(source).catch(() => fallback);
    accounts.set(key, p);
  }
  return p;
}

export interface SimOutcome<T> {
  value: T;
  latestLedger: number;
  /** True when a ledger entry the call touched has expired and needs a restore. */
  restoreNeeded: boolean;
}

/** Simulate `method(args)` on `contractId` from `source` and decode the return value with `pick`. */
export async function simulate<T>(
  net: NetworkInfo,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  source: string,
  pick: (native: unknown) => T,
): Promise<SimOutcome<T>> {
  const account = await sourceAccount(net, source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server(net).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new ContractError(method, sim.error);
  if (!sim.result) throw new Error(`${method}: the simulation returned no value`);
  const native: unknown = scValToNative(sim.result.retval);
  return { value: pick(native), latestLedger: sim.latestLedger, restoreNeeded: rpc.Api.isSimulationRestore(sim) };
}

// ---- Argument encoding ------------------------------------------------------

/** A 32-byte id given as 64 hex characters, with or without 0x. */
export function bytes32(hex: string): xdr.ScVal {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new TypeError(`expected 32 bytes, got ${bytes.length}`);
  return xdr.ScVal.scvBytes(bytes);
}

export const bytesArg = (bytes: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(bytes);
export const u32Arg = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);
export const addressArg = (id: string): xdr.ScVal => new Address(id).toScVal();
export const idsArg = (hexIds: readonly string[]): xdr.ScVal => xdr.ScVal.scvVec(hexIds.map(bytes32));

// ---- Result decoding --------------------------------------------------------

/** Mirrors the contract's PushLeg. The answer has 18 decimals. */
export interface PushLeg {
  answer: bigint;
  roundId: bigint;
  /** Feed time, unix seconds. */
  timestamp: bigint;
  /** Ledger close time when the leg was stored, unix seconds. */
  storedAt: bigint;
}

/** Mirrors the contract's PullLeg. Prices have 18 decimals. */
export interface PullLeg {
  price: bigint;
  bid: bigint;
  ask: bigint;
  validFrom: bigint;
  observationsTs: bigint;
  expiresAt: bigint;
  /** 0x-prefixed stream id. */
  streamId: string;
  storedAt: bigint;
}

export interface Pair {
  push: PushLeg | null;
  pull: PullLeg | null;
}

export interface AssetView {
  /** 64 hex characters, no 0x. */
  dataId: string;
  label: string;
  /** 0x-prefixed, or null when the asset has no stream on this network. */
  streamId: string | null;
}

export interface ClocksConfig {
  admin: string;
  proxy: string;
  verifier: string;
  maxPushAgeS: bigint;
  maxPullAgeS: bigint;
}

/** Mirrors the contract's ReportV3, as verify_report returns it. */
export interface ReportV3Native {
  streamId: string;
  validFrom: bigint;
  observationsTs: bigint;
  expiresAt: bigint;
  price: bigint;
  bid: bigint;
  ask: bigint;
}

/** Mirrors the proxy's Round. The answer is an I256 at the requested decimals. */
export interface Round {
  answer: bigint;
  roundId: bigint;
  timestamp: bigint;
}

export type Source = 'Push' | 'Pull';

export interface FreshPrice {
  price: bigint;
  source: Source;
  timestamp: bigint;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function shape(method: string, what: string): TypeError {
  return new TypeError(`${method} returned an unexpected ${what}`);
}

function big(v: unknown, method: string, field: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  throw shape(method, `${field} (not an integer)`);
}

function text(v: unknown, method: string, field: string): string {
  if (typeof v === 'string') return v;
  throw shape(method, `${field} (not a string)`);
}

function hex32(v: unknown, method: string, field: string): string {
  if (v instanceof Uint8Array && v.length === 32) return bytesToHex(v);
  throw shape(method, `${field} (not 32 bytes)`);
}

/** A unit enum variant arrives as "Push" or as ["Push"], depending on the SDK path. */
function source(v: unknown, method: string): Source {
  const name = Array.isArray(v) ? v[0] : v;
  if (name === 'Push' || name === 'Pull') return name;
  throw shape(method, 'Source');
}

function asPushLeg(v: unknown, method: string): PushLeg {
  if (!isRecord(v)) throw shape(method, 'PushLeg');
  return {
    answer: big(v.answer, method, 'answer'),
    roundId: big(v.round_id, method, 'round_id'),
    timestamp: big(v.timestamp, method, 'timestamp'),
    storedAt: big(v.stored_at, method, 'stored_at'),
  };
}

function asPullLeg(v: unknown, method: string): PullLeg {
  if (!isRecord(v)) throw shape(method, 'PullLeg');
  return {
    price: big(v.price, method, 'price'),
    bid: big(v.bid, method, 'bid'),
    ask: big(v.ask, method, 'ask'),
    validFrom: big(v.valid_from, method, 'valid_from'),
    observationsTs: big(v.observations_ts, method, 'observations_ts'),
    expiresAt: big(v.expires_at, method, 'expires_at'),
    streamId: `0x${hex32(v.stream_id, method, 'stream_id')}`,
    storedAt: big(v.stored_at, method, 'stored_at'),
  };
}

function asPair(v: unknown, method: string): Pair {
  if (!isRecord(v)) throw shape(method, 'Pair');
  return {
    push: v.push === null || v.push === undefined ? null : asPushLeg(v.push, method),
    pull: v.pull === null || v.pull === undefined ? null : asPullLeg(v.pull, method),
  };
}

function asAssetView(v: unknown, method: string): AssetView {
  if (!isRecord(v)) throw shape(method, 'AssetView');
  const stream = v.stream_id;
  return {
    dataId: hex32(v.data_id, method, 'data_id'),
    label: text(v.label, method, 'label'),
    streamId: stream === null || stream === undefined ? null : `0x${hex32(stream, method, 'stream_id')}`,
  };
}

function asConfig(v: unknown, method: string): ClocksConfig {
  if (!isRecord(v)) throw shape(method, 'Config');
  return {
    admin: text(v.admin, method, 'admin'),
    proxy: text(v.proxy, method, 'proxy'),
    verifier: text(v.verifier, method, 'verifier'),
    maxPushAgeS: big(v.max_push_age_s, method, 'max_push_age_s'),
    maxPullAgeS: big(v.max_pull_age_s, method, 'max_pull_age_s'),
  };
}

function asReportV3(v: unknown, method: string): ReportV3Native {
  if (!isRecord(v)) throw shape(method, 'ReportV3');
  return {
    streamId: `0x${hex32(v.stream_id, method, 'stream_id')}`,
    validFrom: big(v.valid_from, method, 'valid_from'),
    observationsTs: big(v.observations_ts, method, 'observations_ts'),
    expiresAt: big(v.expires_at, method, 'expires_at'),
    price: big(v.price, method, 'price'),
    bid: big(v.bid, method, 'bid'),
    ask: big(v.ask, method, 'ask'),
  };
}

function asRound(v: unknown, method: string): Round {
  if (!isRecord(v)) throw shape(method, 'Round');
  return {
    answer: big(v.answer, method, 'answer'),
    roundId: big(v.round_id, method, 'round_id'),
    timestamp: big(v.timestamp, method, 'timestamp'),
  };
}

function asFreshPrice(v: unknown, method: string): FreshPrice {
  if (!isRecord(v)) throw shape(method, 'FreshPrice');
  return {
    price: big(v.price, method, 'price'),
    source: source(v.source, method),
    timestamp: big(v.timestamp, method, 'timestamp'),
  };
}

function asBytes(v: unknown, method: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  throw shape(method, 'Bytes');
}

// ---- Two Clocks readers -----------------------------------------------------

/** latest_many(data_ids) -> one Pair per id, in the same order. Unknown ids give { push: null, pull: null }. */
export function readLatestMany(
  net: NetworkInfo,
  dep: Deployment,
  dataIds: readonly string[],
): Promise<SimOutcome<Pair[]>> {
  const method = 'latest_many';
  return simulate(net, dep.twoClocks, method, [idsArg(dataIds)], sourceFor(net, dep), (v) => {
    if (!Array.isArray(v) || v.length !== dataIds.length) throw shape(method, 'Vec<Pair>');
    const items: unknown[] = v;
    return items.map((item) => asPair(item, method));
  });
}

export function readAssets(net: NetworkInfo, dep: Deployment): Promise<SimOutcome<AssetView[]>> {
  const method = 'assets';
  return simulate(net, dep.twoClocks, method, [], sourceFor(net, dep), (v) => {
    if (!Array.isArray(v)) throw shape(method, 'Vec<AssetView>');
    const items: unknown[] = v;
    return items.map((item) => asAssetView(item, method));
  });
}

export function readConfig(net: NetworkInfo, dep: Deployment): Promise<SimOutcome<ClocksConfig>> {
  const method = 'config';
  return simulate(net, dep.twoClocks, method, [], sourceFor(net, dep), (v) => asConfig(v, method));
}

/** fresh_price(data_id, max_age_s). Throws ContractError Stale (#20) or UnknownAsset (#28). */
export function simulateFreshPrice(
  net: NetworkInfo,
  dep: Deployment,
  dataId: string,
  maxAgeS: bigint,
): Promise<SimOutcome<FreshPrice>> {
  const method = 'fresh_price';
  const args = [bytes32(dataId), nativeToScVal(maxAgeS, { type: 'u64' })];
  return simulate(net, dep.twoClocks, method, args, sourceFor(net, dep), (v) => asFreshPrice(v, method));
}

/** verify_report(signed_report) on our contract: the verifier checks the signatures, the contract decodes the data. */
export function simulateVerifyReport(
  net: NetworkInfo,
  dep: Deployment,
  signedReport: Uint8Array,
): Promise<SimOutcome<ReportV3Native>> {
  const method = 'verify_report';
  return simulate(net, dep.twoClocks, method, [bytesArg(signedReport)], sourceFor(net, dep), (v) =>
    asReportV3(v, method),
  );
}

// ---- Chainlink contracts, called directly -----------------------------------

/**
 * verify(signed_report, sender) on the verifier itself. The sender is the simulation source,
 * so its require_auth passes in recording mode. Returns the 288 report bytes, or throws #9 on mainnet.
 */
export function simulateVerifierRaw(
  net: NetworkInfo,
  signedReport: Uint8Array,
  source: string = sourceFor(net, null),
): Promise<SimOutcome<Uint8Array>> {
  const method = 'verify';
  const args = [bytesArg(signedReport), addressArg(source)];
  return simulate(net, net.verifier, method, args, source, (v) => asBytes(v, method));
}

/** latest_round(data_id, decimals) on the proxy. Throws #50, #51, #52 or #109. */
export function simulateProxyLatestRound(
  net: NetworkInfo,
  dataId: string,
  decimals: number = FEED_DECIMALS,
  source: string = sourceFor(net, null),
): Promise<SimOutcome<Round>> {
  const method = 'latest_round';
  const args = [bytes32(dataId), u32Arg(decimals)];
  return simulate(net, net.proxy, method, args, source, (v) => asRound(v, method));
}

// ---- Arithmetic the contract does, repeated in the browser ------------------

/** (pull.price - push.answer) * 10_000 / push.answer, as spread_bps computes it. Null when a leg is missing or the answer is zero. */
export function spreadBps(pushAnswer: bigint | null, pullPrice: bigint | null): bigint | null {
  if (pushAnswer === null || pullPrice === null || pushAnswer === 0n) return null;
  return ((pullPrice - pushAnswer) * 10_000n) / pushAnswer;
}
