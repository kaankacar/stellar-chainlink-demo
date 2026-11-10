// Watch loop: refresh every N seconds for M minutes, one line per round, then
// a summary with the intervals the feeds showed. Run under caffeinate -i.
import { parseArgs } from 'node:util';
import { HEARTBEAT_S, parseAssetKeys, type Asset } from '../src/lib/feeds.ts';
import { clocksId, formatBps, readLatestMany, refreshAssets, type Pair } from './lib/clocks.ts';
import {
  COMMON_OPTIONS,
  createLogger,
  errorMessage,
  fail,
  formatMs,
  helpIfAsked,
  installCrashLogger,
  scriptArgs,
} from './lib/log.ts';
import {
  ContractCallError,
  explorerUrl,
  formatSeconds,
  loadEnv,
  loadKeypair,
  parseNetwork,
  rawHead,
  requireSendableNetwork,
  stroopsToXlm,
} from './lib/stellar.ts';

const USAGE = `
Usage: pnpm watch -- --network testnet [--every 600] [--minutes 120] [--assets all] [--contract <C...>] [--log <path>]

Calls refresh(data_ids) every --every seconds for --minutes minutes and logs
one line per round: legs stored, which assets moved and by how many bps, age
against the heartbeat, fee, latency. NothingNew is a skip, not an error.
Ctrl-C finishes the current round and prints the summary. Mainnet is refused.
Run it under "caffeinate -i" so the machine stays awake.
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string' },
    every: { type: 'string', default: '600' },
    minutes: { type: 'string', default: '120' },
    assets: { type: 'string', default: 'all' },
    contract: { type: 'string' },
  },
  strict: true,
});
helpIfAsked(values.help, USAGE);

const logger = createLogger(values.log);
installCrashLogger(logger);
loadEnv();

const every = Number(values.every);
const minutes = Number(values.minutes);
if (!(every > 0) || !(minutes > 0)) {
  fail(logger, `--every and --minutes must be positive, got ${values.every} and ${values.minutes}`);
}

let net;
let assets: Asset[];
let contract: string;
try {
  net = parseNetwork(values.network);
  requireSendableNetwork(net);
  assets = parseAssetKeys(values.assets);
  contract = clocksId(net, values.contract);
} catch (error) {
  fail(logger, `${errorMessage(error)}\n${USAGE.trim()}`);
}

let signer;
try {
  signer = await loadKeypair(net);
} catch (error) {
  fail(logger, errorMessage(error));
}
const { keypair, origin } = signer;
const heartbeat = HEARTBEAT_S[net.name];
logger.log(`${net.name}: two-clocks ${contract}, signer ${keypair.publicKey()} (${origin})`);
logger.log(`assets ${assets.map((a) => a.key).join(',')}, every ${every} s for ${minutes} min, heartbeat ${heartbeat} s`);
logger.log(`  ${explorerUrl(net, 'contract', contract)}`);

let stopping = false;
let wake: (() => void) | undefined;
process.on('SIGINT', () => {
  stopping = true;
  logger.log('SIGINT: finishing this round, then the summary');
  wake?.();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    wake = resolve;
    setTimeout(resolve, ms);
  });
}

/** The push legs by asset key, from one latest_many read. */
function pushLegs(pairs: Pair[]): Map<string, Pair['push']> {
  const map = new Map<string, Pair['push']>();
  assets.forEach((asset, index) => map.set(asset.key, pairs[index]?.push ?? null));
  return map;
}

function oldestPush(legs: Map<string, Pair['push']>, nowSec: number): string {
  let oldest: { key: string; age: number } | undefined;
  for (const [key, leg] of legs) {
    if (!leg) continue;
    const age = nowSec - Number(leg.timestamp);
    if (!oldest || age > oldest.age) oldest = { key, age };
  }
  if (!oldest) return 'no push leg stored yet';
  const left = heartbeat - oldest.age;
  return `oldest push ${oldest.key} age ${formatSeconds(oldest.age)} (${left >= 0 ? `heartbeat in ${formatSeconds(left)}` : `heartbeat overdue by ${formatSeconds(-left)}`})`;
}

const stats = { rounds: 0, stored: 0, skips: 0, errors: 0, feeStroops: 0n, latencies: [] as number[] };
/** Feed timestamps of every distinct round seen per asset, for the observed intervals. */
const feedTimes = new Map<string, number[]>();

let previous: Map<string, Pair['push']>;
try {
  previous = pushLegs(await readLatestMany(net, contract, assets, keypair.publicKey()));
  for (const [key, leg] of previous) if (leg) feedTimes.set(key, [Number(leg.timestamp)]);
  logger.log(`baseline: ${oldestPush(previous, Math.floor(Date.now() / 1000))}`);
} catch (error) {
  fail(logger, `latest_many failed: ${errorMessage(error)}`);
}

const deadline = Date.now() + minutes * 60_000;
const runStart = performance.now();

while (!stopping && Date.now() < deadline) {
  stats.rounds += 1;
  const round = stats.rounds;
  const started = Date.now();
  try {
    const result = await refreshAssets(net, contract, keypair, assets);
    const fee = result.feeCharged ?? 0n;
    const closeSec = result.createdAt ?? Math.floor(Date.now() / 1000);
    const latency = result.createdAt !== undefined ? Math.max(0, result.createdAt * 1000 - started) : undefined;
    stats.stored += result.result;
    stats.feeStroops += fee;
    if (latency !== undefined) stats.latencies.push(latency);
    const current = pushLegs(await readLatestMany(net, contract, assets, keypair.publicKey()));
    const moved: string[] = [];
    for (const [key, leg] of current) {
      const before = previous.get(key) ?? null;
      if (!leg || (before && before.round_id === leg.round_id)) continue;
      const change = before ? formatBps(before.answer, leg.answer) : 'first round';
      const age = closeSec - Number(leg.timestamp);
      moved.push(`${key} ${change} (round ${leg.round_id}, age ${formatSeconds(age)} of ${formatSeconds(heartbeat)})`);
      const times = feedTimes.get(key) ?? [];
      times.push(Number(leg.timestamp));
      feedTimes.set(key, times);
    }
    previous = current;
    logger.log(
      `round ${round}  stored ${result.result}  ${moved.join(', ') || 'no asset moved'}  tx ${result.hash?.slice(0, 8)}...  ledger ${result.ledger}  fee ${stroopsToXlm(fee)}  latency ${latency !== undefined ? formatMs(latency) : 'n/a'}`,
    );
  } catch (error) {
    if (error instanceof ContractCallError) stats.feeStroops += error.feeCharged ?? 0n;
    if (error instanceof ContractCallError && (error.code === 21 || error.code === 20)) {
      stats.skips += 1;
      logger.log(`round ${round}  skip  ${error.message} [${rawHead(error.raw)}]  ${oldestPush(previous, Math.floor(Date.now() / 1000))}`);
    } else {
      stats.errors += 1;
      logger.log(`round ${round}  error  ${errorMessage(error)}`);
    }
  }
  if (stopping || Date.now() >= deadline) break;
  const elapsed = Date.now() - started;
  await sleep(Math.max(0, every * 1000 - elapsed));
}

logger.section('Summary');
const average =
  stats.latencies.length > 0
    ? formatMs(stats.latencies.reduce((sum, value) => sum + value, 0) / stats.latencies.length)
    : 'n/a';
logger.log(
  `rounds ${stats.rounds}, stored ${stats.stored} push leg(s), skips ${stats.skips}, errors ${stats.errors}, total ${stroopsToXlm(stats.feeStroops)} (failed transactions included), average latency ${average}, ran ${formatMs(performance.now() - runStart)}`,
);
for (const asset of assets) {
  const times = feedTimes.get(asset.key) ?? [];
  if (times.length < 2) {
    logger.log(`${asset.key}: ${times.length} round(s) seen, no interval observed`);
    continue;
  }
  const intervals = times.slice(1).map((t, i) => t - (times[i] ?? t)).sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
  logger.log(
    `${asset.key}: ${times.length - 1} new round(s), intervals min ${formatSeconds(intervals[0] ?? 0)}, median ${formatSeconds(median)}, max ${formatSeconds(intervals[intervals.length - 1] ?? 0)} (heartbeat ${formatSeconds(heartbeat)})`,
  );
}
process.exit(stats.errors === 0 ? 0 : 1);
