// Read one Chainlink Data Feed from the proxy by simulation. Keyless, costs
// nothing. The README quickstart.
import { parseArgs } from 'node:util';
import { ASSET_KEYS, HEARTBEAT_S, assetByKey } from '../src/lib/feeds.ts';
import { proxyDecimals, proxyDescription, proxyGetRound, proxyLatestRound, proxyMinDecimals } from './lib/clocks.ts';
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
import { ContractCallError, explorerUrl, formatSeconds, parseNetwork, rawHead, readerAccount, unixToIso } from './lib/stellar.ts';

const USAGE = `
Usage: pnpm read-feed -- --network <testnet|mainnet> --asset xlm [--decimals 18] [--round <n>] [--log <path>]

Reads description, decimals, get_min_decimals and latest_round (or get_round
with --round) for one feed on the Chainlink Data Feeds proxy. Every call is a
simulation: no key, no fee. Assets: ${ASSET_KEYS.join(', ')}.
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string' },
    asset: { type: 'string', default: 'xlm' },
    decimals: { type: 'string', default: '18' },
    round: { type: 'string' },
  },
  strict: true,
});
helpIfAsked(values.help, USAGE);

const logger = createLogger(values.log);
installCrashLogger(logger);

let net;
try {
  net = parseNetwork(values.network);
} catch (error) {
  fail(logger, `${errorMessage(error)}\n${USAGE.trim()}`);
}

const asset = assetByKey(values.asset);
if (!asset) fail(logger, `unknown asset "${values.asset}"; known keys: ${ASSET_KEYS.join(', ')}`);

const decimals = Number(values.decimals);
if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
  fail(logger, `--decimals must be an integer from 0 to 18, got "${values.decimals}"`);
}
const roundId = values.round !== undefined ? Number(values.round) : undefined;
if (roundId !== undefined && (!Number.isInteger(roundId) || roundId < 0)) {
  fail(logger, `--round must be a non-negative integer, got "${values.round}"`);
}

/** An integer at `decimals` decimal places, as "0.14751937". */
function formatAt(value: bigint, places: number): string {
  if (places === 0) return value.toString();
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(places);
  return `${negative ? '-' : ''}${abs / scale}.${(abs % scale).toString().padStart(places, '0')}`;
}

const source = await readerAccount(net);
logger.log(`${net.name} proxy ${net.proxy}, source ${source} (simulation only)`);
logger.log(`${asset.key}: ${asset.label}, data_id ${asset.dataId}`);

const started = performance.now();
try {
  const [description, stored, min] = await Promise.all([
    proxyDescription(net, asset.dataId, source),
    proxyDecimals(net, asset.dataId, source),
    proxyMinDecimals(net, asset.dataId, source),
  ]);
  logger.log(`description "${description}", decimals ${stored}, get_min_decimals ${min}`);
  const call = roundId === undefined ? `latest_round(data_id, ${decimals})` : `get_round(data_id, ${roundId}, ${decimals})`;
  const round =
    roundId === undefined
      ? await proxyLatestRound(net, asset.dataId, decimals, source)
      : await proxyGetRound(net, asset.dataId, roundId, decimals, source);
  const nowSec = Math.floor(Date.now() / 1000);
  const age = nowSec - Number(round.timestamp);
  logger.log(
    `${call}: answer ${round.answer} = ${formatAt(round.answer, decimals)} USD, round ${round.round_id}, timestamp ${round.timestamp} (${unixToIso(Number(round.timestamp))}), age ${formatSeconds(age)}, heartbeat ${HEARTBEAT_S[net.name]} s (${formatMs(performance.now() - started)} for 4 simulations)`,
  );
  logger.log(`  ${explorerUrl(net, 'contract', net.proxy)}`);
  const method = roundId === undefined ? `latest_round --data_id ${asset.dataId} --decimals ${decimals}` : `get_round --data_id ${asset.dataId} --round_id ${roundId} --decimals ${decimals}`;
  logger.log(`same read with the CLI: stellar contract invoke --id ${net.proxy} --network ${net.name} --source <any funded key> --send=no -- ${method}`);
} catch (error) {
  if (error instanceof ContractCallError) fail(logger, `${error.message} [${rawHead(error.raw)}]`);
  throw error;
}
