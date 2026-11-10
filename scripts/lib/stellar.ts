// Stellar side: network table, keys, simulate / sign / send / poll, and error
// decoding for the Chainlink proxy, the Chainlink verifier and Two Clocks.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { BASE_FEE, Contract, Keypair, Networks, SorobanDataBuilder, TransactionBuilder, rpc, scValToNative, xdr, type Account } from '@stellar/stellar-sdk';

/** Load .env once, without the dotenv banner. Only scripts that need secrets call it. */
export function loadEnv(): void {
  loadDotenv({ quiet: true });
}

export type NetworkName = 'mainnet' | 'testnet';

export interface Network {
  name: NetworkName;
  rpcUrl: string;
  horizonUrl: string;
  passphrase: string;
  friendbot?: string;
  explorer: 'public' | 'testnet';
  /** Inclusion fee bid in stroops. The resource fee comes on top from simulation. */
  inclusionFee: string;
  /** Chainlink Data Feeds proxy. One per network, every feed behind it. */
  proxy: string;
  /** Chainlink Data Streams verifier. */
  verifier: string;
  /** A public key that exists on the network, for simulation only. */
  reader?: string;
}

/** Mainnet account used as a read-only simulation source. It never signs. */
export const MAINNET_READER = 'GBTKQ2WYNYE5TJW3N5LH7PGGERX2EIBDIIN7X6LFHMVQQZCZT36KA3PC';

/** The field-note testnet identity (public key only). Simulations use it as source. */
export const TESTNET_READER = 'GARGB3SHPUXQEFUNLCD67QLP4ABG4WVYM2KB3UURWA53ADAP7U6TEICC';

export const NETWORKS: Record<NetworkName, Network> = {
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    horizonUrl: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
    explorer: 'public',
    // Mainnet ledgers run close to full. A BASE_FEE bid gets evicted and the
    // transaction expires without reaching a ledger.
    inclusionFee: '1000000',
    proxy: 'CDQBHEUGLDHMSUHG4IH33RJBUTMNCZOT4JIAQR4WZFRDZW6DR6S32ZLZ',
    verifier: 'CAKA3NBYPC6OBEUEGNIYGNYG3ES2GPQK736B5SR7ASGUXRDAKXI2JCQI',
    reader: MAINNET_READER,
  },
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
    friendbot: 'https://friendbot.stellar.org',
    explorer: 'testnet',
    inclusionFee: BASE_FEE,
    proxy: 'CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4',
    verifier: 'CA7GVHWH4GRHE6GI7MHEKQZAOYO4GE7KRGSU3EOS3HYJRVLX3XEA4ONQ',
    reader: TESTNET_READER,
  },
};

export function parseNetwork(name: string | undefined): Network {
  if (name === 'mainnet' || name === 'testnet') return NETWORKS[name];
  throw new Error(`--network must be mainnet or testnet, got "${name ?? ''}"`);
}

/** Refuse to sign on mainnet. This field note is testnet only (SPEC.md decisions). */
export function requireSendableNetwork(net: Network): void {
  if (net.name === 'mainnet') {
    throw new Error('mainnet is read-only in this field note (SPEC.md decisions). Use --network testnet.');
  }
}

export function explorerUrl(net: Network, kind: 'contract' | 'tx' | 'account', id: string): string {
  return `https://stellar.expert/explorer/${net.explorer}/${kind}/${id}`;
}

const servers = new Map<NetworkName, rpc.Server>();

export function rpcServer(net: Network): rpc.Server {
  let server = servers.get(net.name);
  if (!server) {
    server = new rpc.Server(net.rpcUrl);
    servers.set(net.name, server);
  }
  return server;
}

export interface NetworkInfo {
  latestLedger: number;
  protocolVersion: number;
  /** Close time of the latest ledger, unix seconds. */
  closeTime: number;
  passphraseMatches: boolean;
}

/** One raw JSON-RPC call. The result is the untouched `result` object. */
export async function rawRpc<T>(net: Network, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(net.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${net.rpcUrl} ${method}: HTTP ${response.status}`);
  const json = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`${net.rpcUrl} ${method}: ${json.error.message} (${json.error.code})`);
  if (json.result === undefined) throw new Error(`${net.rpcUrl} ${method}: no result`);
  return json.result;
}

/**
 * Ledger and protocol from raw JSON-RPC. stellar-sdk 17.2.1 parses the ledger
 * header XDR in getLatestLedger and fails on the current networks with
 * "LedgerHeader.scpValue.ext.v: unknown enum value 3", so the fields are read
 * from the JSON directly.
 */
export async function networkInfo(net: Network): Promise<NetworkInfo> {
  const [ledger, network] = await Promise.all([
    rawRpc<{ sequence: number; protocolVersion: number; closeTime?: string }>(net, 'getLatestLedger'),
    rawRpc<{ passphrase: string }>(net, 'getNetwork'),
  ]);
  return {
    latestLedger: ledger.sequence,
    protocolVersion: Number(ledger.protocolVersion),
    closeTime: Number(ledger.closeTime ?? 0),
    passphraseMatches: network.passphrase === net.passphrase,
  };
}

/** Retry a call that the RPC refused with HTTP 429, waiting 1, 2 and 4 seconds. */
export async function withBackoff<T>(call: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const text = errorText(error);
      if (attempt >= attempts || !/status code 429|Too Many Requests/i.test(text)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

// ---- Keys -------------------------------------------------------------------

export async function fundWithFriendbot(net: Network, publicKey: string): Promise<void> {
  if (!net.friendbot) throw new Error(`${net.name} has no friendbot`);
  const response = await fetch(`${net.friendbot}?addr=${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`friendbot ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

let throwaway: Keypair | undefined;

/** A random, friendbot-funded key. Lives in memory for this process only. */
export async function throwawayKeypair(net: Network): Promise<Keypair> {
  if (!net.friendbot) {
    throw new Error(`${net.name} has no friendbot. Set STELLAR_SECRET to a funded account.`);
  }
  if (!throwaway) {
    const keypair = Keypair.random();
    await fundWithFriendbot(net, keypair.publicKey());
    throwaway = keypair;
  }
  return throwaway;
}

const readers = new Map<NetworkName, Promise<string>>();

/**
 * Source account for simulations: the network's known reader when it exists,
 * else a friendbot throwaway on testnet. Checked once per process.
 */
export function readerAccount(net: Network): Promise<string> {
  let pending = readers.get(net.name);
  if (!pending) {
    pending = (async (): Promise<string> => {
      if (net.reader) {
        try {
          await rpcServer(net).getAccount(net.reader);
          return net.reader;
        } catch (error) {
          if (!net.friendbot) throw new Error(`reader ${net.reader} is not usable on ${net.name}: ${errorText(error)}`);
        }
      }
      return (await throwawayKeypair(net)).publicKey();
    })();
    readers.set(net.name, pending);
  }
  return pending;
}

export interface LoadedKeypair {
  keypair: Keypair;
  origin: 'STELLAR_SECRET' | 'throwaway';
}

/** The signing key: STELLAR_SECRET, or a throwaway on testnet. Never logged. */
export async function loadKeypair(net: Network): Promise<LoadedKeypair> {
  const secret = process.env['STELLAR_SECRET']?.trim();
  if (secret) {
    try {
      return { keypair: Keypair.fromSecret(secret), origin: 'STELLAR_SECRET' };
    } catch {
      throw new Error('STELLAR_SECRET is not a valid S... secret key.');
    }
  }
  if (!net.friendbot) {
    throw new Error(
      `${net.name} has no friendbot. Set STELLAR_SECRET to a funded account (see .env.example).`,
    );
  }
  return { keypair: await throwawayKeypair(net), origin: 'throwaway' };
}

/** Native balance from Horizon, or undefined when the account does not exist. */
export async function nativeBalance(net: Network, publicKey: string): Promise<string | undefined> {
  const response = await fetch(`${net.horizonUrl}/accounts/${publicKey}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Horizon ${response.status} for ${publicKey}`);
  const account = (await response.json()) as {
    balances: { asset_type: string; balance: string }[];
  };
  return account.balances.find((b) => b.asset_type === 'native')?.balance ?? '0';
}

// ---- Errors -----------------------------------------------------------------

export type ErrorScope = 'clocks' | 'verifier' | 'proxy';

interface ErrorEntry {
  name: string;
  meaning: string;
}

/** Chainlink Data Streams verifier `ContractError`, as the raw verifier reports it. */
export const VERIFIER_ERRORS: Readonly<Record<number, ErrorEntry>> = {
  2: { name: 'NotInitialized', meaning: 'the verifier has no owner yet.' },
  3: { name: 'ZeroAddress', meaning: 'a signer address is the zero address.' },
  4: { name: 'FaultToleranceMustBePositive', meaning: 'f must be greater than 0.' },
  5: { name: 'ExcessSigners', meaning: 'more than 31 signers in a config.' },
  6: { name: 'InsufficientSigners', meaning: 'a config needs more than 3f signers.' },
  7: { name: 'NonUniqueSignatures', meaning: 'two signatures in the report come from the same signer.' },
  8: { name: 'DigestEmpty', meaning: 'the config digest in reportContext[0] is all zeros.' },
  9: {
    name: 'DigestNotSet',
    meaning:
      'no DON config with this digest on this verifier. A report signed for another network or chain gives this.',
  },
  10: { name: 'DigestInactive', meaning: 'the DON config for this digest was deactivated.' },
  11: { name: 'ConfigDigestAlreadySet', meaning: 'a config with this digest already exists.' },
  12: {
    name: 'BadVerification',
    meaning: 'a recovered signer is not in the config. Any change to the report bytes gives this.',
  },
  13: { name: 'MismatchedSignatures', meaning: 'the rs and ss arrays differ in length.' },
  14: { name: 'IncorrectSignatureCount', meaning: 'the report does not carry exactly f+1 signatures.' },
  15: { name: 'NoProposedOwner', meaning: 'no ownership transfer is pending.' },
  16: { name: 'InvalidReportFormat', meaning: 'the ABI envelope does not parse.' },
  17: { name: 'SignatureRecoveryFailed', meaning: 'secp256k1 recovery failed for one signature.' },
  18: { name: 'InvalidProposedOwner', meaning: 'the proposed owner is the current owner.' },
};

/** Chainlink Data Feeds proxy `ProxyReadError`, plus the frozen-feed panic from its cache. */
export const PROXY_ERRORS: Readonly<Record<number, ErrorEntry>> = {
  50: { name: 'NoDataPresent', meaning: 'no round for this data id: unknown id, feed not written yet, or round expired.' },
  51: { name: 'InvalidDecimals', meaning: 'decimals outside the range the feed serves (18 stored, min 8 today, 0 is refused).' },
  52: { name: 'RoundsToZero', meaning: 'a non-zero answer truncates to zero at these decimals. Ask for more decimals.' },
  109: { name: 'FeedFrozen', meaning: 'the feed is frozen. The proxy cache panics with CacheError::FeedFrozen.' },
};

/** Two Clocks `Error`. Codes 2 to 18 and 50 to 109 pass through from the verifier and the proxy. */
export const CLOCKS_ERRORS: Readonly<Record<number, ErrorEntry>> = {
  ...VERIFIER_ERRORS,
  20: {
    name: 'Stale',
    meaning:
      'the round or report is older than the max age, or dated more than 60 s ahead of ledger time. Nothing was stored.',
  },
  21: { name: 'NothingNew', meaning: 'no round or report is newer than what the contract holds. Nothing was stored and no fee was charged.' },
  22: { name: 'NotFound', meaning: 'a leg this call needs is missing. Refresh or submit first.' },
  23: { name: 'Expired', meaning: 'the report expiresAt is at or before ledger time.' },
  24: { name: 'NotYetValid', meaning: 'the report observations time is more than 60 s ahead of ledger time.' },
  25: { name: 'UnsupportedSchema', meaning: 'the stream id does not start with 0x0003. Only schema v3 reports are decoded.' },
  26: { name: 'MalformedReport', meaning: 'the report data is not 288 bytes or a u32 word has non-zero high bytes.' },
  27: { name: 'Overflow', meaning: 'an int192 value does not fit in i128, or the spread arithmetic overflowed.' },
  28: { name: 'UnknownAsset', meaning: 'this data id is not configured in the contract.' },
  29: { name: 'UnknownStream', meaning: 'no asset maps this stream id. Call set_stream first.' },
  30: { name: 'TooManyAssets', meaning: 'the contract tracks at most 32 assets.' },
  31: { name: 'ProxyInvokeFailed', meaning: 'the proxy call trapped with something other than a typed error.' },
  32: { name: 'VerifierInvokeFailed', meaning: 'the verifier call trapped with something other than a typed error.' },
  ...PROXY_ERRORS,
};

const TABLES: Readonly<Record<ErrorScope, Readonly<Record<number, ErrorEntry>>>> = {
  clocks: CLOCKS_ERRORS,
  verifier: VERIFIER_ERRORS,
  proxy: PROXY_ERRORS,
};

/** The error name for a code in a scope, or undefined. */
export function errorName(code: number, scope: ErrorScope = 'clocks'): string | undefined {
  return TABLES[scope][code]?.name;
}

function errorText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message;
  return String(input);
}

/** The first line of a host error text, for example "HostError: Error(Contract, #12)". */
export function rawHead(input: unknown): string {
  return errorText(input).split('\n')[0]?.trim() ?? '';
}

/** N from "Error(Contract, #N)", or undefined. */
export function contractErrorCode(input: unknown): number | undefined {
  const match = /Error\(Contract, #(\d+)\)/.exec(errorText(input));
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Turn a simulation or host error into one line a reader can act on. */
export function explainError(input: unknown, scope: ErrorScope = 'clocks'): string {
  const text = errorText(input);
  const code = contractErrorCode(text);
  if (code !== undefined) {
    const entry = TABLES[scope][code];
    return entry
      ? `contract error #${code} ${entry.name}: ${entry.meaning}`
      : `contract error #${code}: not in the ${scope} error table.`;
  }
  if (text.includes('Error(Crypto, InvalidInput)')) {
    return `host error Crypto/InvalidInput: secp256k1 recovery trapped on malformed signature bytes, so no typed verifier error was produced. ${rawHead(text)}`;
  }
  if (text.includes('Error(Budget, ExceededLimit)')) {
    return `host error Budget/ExceededLimit: the call ran out of CPU or memory budget. ${rawHead(text)}`;
  }
  if (text.includes('Error(Storage, MissingValue)')) {
    return `host error Storage/MissingValue: a ledger entry the call needs is missing, for example a contract id that is not deployed on this network. ${rawHead(text)}`;
  }
  if (text.includes('Error(Auth,')) {
    return `host error Auth: the call needs an authorization it did not get. ${rawHead(text)}`;
  }
  return rawHead(text);
}

export class ContractCallError extends Error {
  readonly code: number | undefined;
  readonly raw: string;

  constructor(
    public readonly stage: 'simulate' | 'send' | 'poll',
    raw: string,
    scope: ErrorScope = 'clocks',
    /** Stroops the network kept. Set when a sent transaction failed on chain. */
    public readonly feeCharged?: bigint,
  ) {
    super(explainError(raw, scope));
    this.name = 'ContractCallError';
    this.raw = raw;
    this.code = contractErrorCode(raw);
  }
}

// ---- Calls ------------------------------------------------------------------

const simulationAccounts = new Map<string, Account>();

/**
 * The source account for a transaction. A send fetches it fresh, so the
 * sequence number is current. A simulation ignores the sequence number, so
 * one fetch per process and source is enough.
 */
async function sourceAccount(net: Network, sourceKey: string, fresh: boolean): Promise<Account> {
  const key = `${net.name}:${sourceKey}`;
  const cached = simulationAccounts.get(key);
  if (!fresh && cached) return cached;
  const account = await withBackoff(() => rpcServer(net).getAccount(sourceKey));
  simulationAccounts.set(key, account);
  return account;
}

export interface CallOptions {
  /** Sign and send after simulation. Default: simulate only. */
  send?: boolean;
  /** Required with send. Also the simulation source when set. */
  keypair?: Keypair;
  /** Simulation source account when no keypair is given. Default: readerAccount(net). */
  source?: string;
  scope?: ErrorScope;
  timeoutSec?: number;
  pollAttempts?: number;
}

/** Percent added to the simulated resource fee before sending. */
export const RESOURCE_FEE_MARGIN_PERCENT = 25;

export interface CallResult<T> {
  result: T;
  minResourceFee: string;
  latestLedger: number;
  /** Set only after a send. */
  hash?: string;
  ledger?: number;
  /** Ledger close time, unix seconds. */
  createdAt?: number;
  feeCharged?: bigint;
}

function describeSendFailure(sent: rpc.Api.SendTransactionResponse): string {
  const name = sent.errorResult?.result.type ?? 'no error result';
  const events = sent.diagnosticEvents?.length ?? 0;
  return `sendTransaction returned ${sent.status}: ${name} (${events} diagnostic event(s))`;
}

function describeFailed(polled: rpc.Api.GetFailedTransactionResponse): string {
  const name = polled.resultXdr.result.type;
  const events = polled.diagnosticEventsXdr?.length ?? 0;
  const fee = polled.resultXdr.feeCharged;
  return `transaction ${polled.txHash} failed in ledger ${polled.ledger}: ${name} (${events} diagnostic event(s)). Fee charged ${fee} stroops (${stroopsToXlm(fee)}).`;
}

/** Simulate one operation and, with `send`, sign, send and poll it. */
export async function submit<T = unknown>(
  net: Network,
  operation: xdr.Operation,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  const server = rpcServer(net);
  const sourceKey = opts.keypair?.publicKey() ?? opts.source ?? (await readerAccount(net));
  const account = await sourceAccount(net, sourceKey, opts.send === true);
  const tx = new TransactionBuilder(account, {
    fee: net.inclusionFee,
    networkPassphrase: net.passphrase,
  })
    .addOperation(operation)
    .setTimeout(opts.timeoutSec ?? 60)
    .build();

  const sim = await withBackoff(() => server.simulateTransaction(tx));
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractCallError('simulate', sim.error, opts.scope);
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new ContractCallError(
      'simulate',
      'the simulation asks for a restore first: a ledger entry this call touches has an expired TTL',
      opts.scope,
    );
  }
  const simResult = (sim.result ? scValToNative(sim.result.retval) : undefined) as T;
  const base = { minResourceFee: sim.minResourceFee, latestLedger: sim.latestLedger };
  if (!opts.send) return { result: simResult, ...base };
  if (!opts.keypair) throw new Error('send needs a keypair');

  // Rent depends on the ledger that includes the transaction, and the
  // simulation gives no slack. Unused refundable fee is returned, so a
  // margin costs nothing when it is not needed.
  const resourceFee = (BigInt(sim.minResourceFee) * BigInt(100 + RESOURCE_FEE_MARGIN_PERCENT)) / 100n;
  const sorobanData = new SorobanDataBuilder(sim.transactionData.build()).setResourceFee(resourceFee).build();
  const assembled = rpc.assembleTransaction(tx, sim).build();
  const prepared = TransactionBuilder.cloneFrom(assembled, {
    fee: (BigInt(net.inclusionFee) + resourceFee).toString(),
    sorobanData,
  }).build();
  prepared.sign(opts.keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new ContractCallError('send', describeSendFailure(sent), opts.scope);
  }
  const polled = await server.pollTransaction(sent.hash, { attempts: opts.pollAttempts ?? 60 });
  if (polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new ContractCallError(
      'poll',
      `transaction ${sent.hash} did not reach a ledger within the poll window. Nothing executed and no fee was charged. On mainnet this usually means the inclusion fee bid (${net.inclusionFee} stroops) was outbid. Retry.`,
      opts.scope,
    );
  }
  if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new ContractCallError('poll', describeFailed(polled), opts.scope, polled.resultXdr.feeCharged);
  }
  const result = (polled.returnValue ? scValToNative(polled.returnValue) : simResult) as T;
  return {
    result,
    ...base,
    hash: sent.hash,
    ledger: polled.ledger,
    createdAt: polled.createdAt,
    feeCharged: polled.resultXdr.feeCharged,
  };
}

/** Call a contract function. Simulates, and with `send` signs, sends and polls. */
export function invoke<T = unknown>(
  net: Network,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  return submit<T>(net, new Contract(contractId).call(method, ...args), opts);
}

/** Simulate a read and return its value. Costs nothing. */
export async function read<T = unknown>(
  net: Network,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  opts: Omit<CallOptions, 'send'> = {},
): Promise<T> {
  return (await invoke<T>(net, contractId, method, args, { ...opts, send: false })).result;
}

// ---- Small helpers ----------------------------------------------------------

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stroops as "0.0101234 XLM". */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const fraction = (abs % 10_000_000n).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${fraction} XLM`;
}

export function unixToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Seconds as "45 s", "4 min 40 s", "23 h 55 min" or "29 d 3 h". Negative values get a minus sign. */
export function formatSeconds(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const s = Math.floor(Math.abs(seconds));
  if (s < 60) return `${sign}${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${sign}${min} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${sign}${h} h ${String(min % 60).padStart(2, '0')} min`;
  const d = Math.floor(h / 24);
  return `${sign}${d} d ${h % 24} h`;
}

/** stellar.expert's contract summary. The API wants a browser-like User-Agent. */
export interface ContractStats {
  contract: string;
  created: number;
  creator: string;
  wasm: string;
  invocations: number;
  subinvocation: number;
  events?: number;
  errors: number;
  storage_entries: number;
  validation?: { status: string };
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function fetchContractStats(net: Network, contractId: string): Promise<ContractStats> {
  const url = `https://api.stellar.expert/explorer/${net.explorer}/contract/${contractId}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`stellar.expert ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as ContractStats;
}

// ---- deployments.json -------------------------------------------------------

export interface Deployment {
  twoClocks: string;
  proxy: string;
  verifier: string;
  maxPushAgeS: number;
  maxPullAgeS: number;
  /** Asset keys given to the constructor, in order. */
  assets: string[];
  deployedAt: string;
  deployTx: string;
  /** A public key that exists on the network. The web page simulates reads with it. */
  reader: string;
}

const DEPLOYMENTS_PATH = new URL('../../src/deployments.json', import.meta.url);

export function readDeployments(): Partial<Record<NetworkName, Deployment>> {
  try {
    return JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8')) as Partial<
      Record<NetworkName, Deployment>
    >;
  } catch {
    return {};
  }
}

export function writeDeployment(name: NetworkName, deployment: Deployment): void {
  const all = readDeployments();
  all[name] = deployment;
  writeFileSync(DEPLOYMENTS_PATH, `${JSON.stringify(all, null, 2)}\n`);
}
