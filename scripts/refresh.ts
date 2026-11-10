// Pull the latest proxy rounds into Two Clocks: refresh(all ids) in one
// transaction, or refresh_one per asset with --one. Then read everything back.
import { parseArgs } from 'node:util';
import { parseAssetKeys, type Asset } from '../src/lib/feeds.ts';
import { clocksId, describePair, describePush, readConfig, readLatestMany, refreshAssets, refreshOne } from './lib/clocks.ts';
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
  loadEnv,
  loadKeypair,
  parseNetwork,
  rawHead,
  requireSendableNetwork,
  stroopsToXlm,
} from './lib/stellar.ts';

const USAGE = `
Usage: pnpm refresh -- --network testnet [--assets all] [--one] [--contract <C...>] [--log <path>]

Calls refresh(data_ids) once for every asset given (or refresh_one per asset
with --one). Stale and NothingNew are explained, not retried. Signs with
STELLAR_SECRET from .env. Mainnet is refused: this field note is testnet only.
Latency is call start to ledger close (ledger time has 1 s resolution).
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string' },
    assets: { type: 'string', default: 'all' },
    one: { type: 'boolean', default: false },
    contract: { type: 'string' },
  },
  strict: true,
});
helpIfAsked(values.help, USAGE);

const logger = createLogger(values.log);
installCrashLogger(logger);
loadEnv();

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
logger.log(`${net.name}: two-clocks ${contract}, signer ${keypair.publicKey()} (${origin}), assets ${assets.map((a) => a.key).join(',')}`);

let maxPushAgeS: number | undefined;
try {
  const config = await readConfig(net, contract, keypair.publicKey());
  maxPushAgeS = Number(config.max_push_age_s);
  logger.log(`config: proxy ${config.proxy}, max_push_age_s ${config.max_push_age_s}, max_pull_age_s ${config.max_pull_age_s}`);
} catch (error) {
  fail(logger, `config() failed: ${errorMessage(error)}`);
}

let totalFee = 0n;
let storedTotal = 0;
let ledgerCloseSec: number | undefined;
let failed = false;

function logSkipOrError(prefix: string, error: unknown): void {
  if (error instanceof ContractCallError && (error.code === 21 || error.code === 20)) {
    logger.log(`${prefix} skip: ${error.message} [${rawHead(error.raw)}]`);
    return;
  }
  failed = true;
  if (error instanceof ContractCallError && error.feeCharged !== undefined) {
    totalFee += error.feeCharged;
    logger.log(`${prefix} nothing stored, but the network kept the fee: ${error.feeCharged} stroops (${stroopsToXlm(error.feeCharged)})`);
  }
  logger.log(`${prefix} error: ${errorMessage(error)}`);
}

if (values.one) {
  logger.section('refresh_one per asset');
  for (const asset of assets) {
    const started = Date.now();
    try {
      const result = await refreshOne(net, contract, keypair, asset);
      const fee = result.feeCharged ?? 0n;
      totalFee += fee;
      storedTotal += 1;
      ledgerCloseSec = result.createdAt ?? ledgerCloseSec;
      const latency = result.createdAt !== undefined ? formatMs(Math.max(0, result.createdAt * 1000 - started)) : 'n/a';
      const nowSec = result.createdAt ?? Math.floor(Date.now() / 1000);
      logger.log(`${asset.key}: stored ${describePush(result.result, { net: net.name, nowSec, maxPushAgeS })}`);
      logger.log(`  tx ${result.hash}, ledger ${result.ledger}, fee ${fee} stroops (${stroopsToXlm(fee)}), latency call to ledger close ${latency}`);
    } catch (error) {
      logSkipOrError(`${asset.key}:`, error);
    }
  }
} else {
  logger.section(`refresh (${assets.length} ids in one transaction)`);
  const started = Date.now();
  try {
    const result = await refreshAssets(net, contract, keypair, assets);
    const fee = result.feeCharged ?? 0n;
    totalFee += fee;
    storedTotal = result.result;
    ledgerCloseSec = result.createdAt;
    const latency = result.createdAt !== undefined ? formatMs(Math.max(0, result.createdAt * 1000 - started)) : 'n/a';
    logger.log(`stored ${result.result} of ${assets.length}: tx ${result.hash}, ledger ${result.ledger}, fee ${fee} stroops (${stroopsToXlm(fee)}), latency call to ledger close ${latency}`);
    logger.log(`  ${explorerUrl(net, 'tx', result.hash ?? '')}`);
  } catch (error) {
    logSkipOrError('refresh', error);
  }
}

logger.section('latest_many by simulation');
try {
  const pairs = await readLatestMany(net, contract, assets, keypair.publicKey());
  const nowSec = Math.floor(Date.now() / 1000);
  assets.forEach((asset, index) => {
    const pair = pairs[index];
    if (!pair) {
      logger.log(`${asset.key}: no pair returned`);
      return;
    }
    const lines = describePair(asset, pair, { net: net.name, nowSec, maxPushAgeS });
    const storedNow = pair.push && ledgerCloseSec !== undefined && Number(pair.push.stored_at) === ledgerCloseSec;
    lines.forEach((line, i) => logger.log(i === 0 && storedNow ? `${line}  [stored this run]` : line));
  });
  logger.log(`  ${explorerUrl(net, 'contract', contract)}`);
} catch (error) {
  fail(logger, `latest_many failed: ${errorMessage(error)}`);
}

logger.section('Summary');
logger.log(`stored ${storedTotal} push leg(s), total fee ${stroopsToXlm(totalFee)}${failed ? ', with errors' : ''}`);
process.exit(failed ? 1 : 0);
