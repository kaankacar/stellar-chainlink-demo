// Send one signed Data Streams report to Two Clocks: decode it locally, run
// verify_report by simulation, then submit_report for real. The only public
// sample expired on 2026-05-03, so --expect-expired makes a #23 a success.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assetByStreamId } from '../src/lib/feeds.ts';
import { bytesToHex, decodeSignedReport, formatE18, hexToBytes } from '../src/lib/report.ts';
import { clocksId, describePair, describePull, readConfig, readLatestMany, submitReport, verifyReport } from './lib/clocks.ts';
import {
  COMMON_OPTIONS,
  createLogger,
  errorMessage,
  fail,
  formatMs,
  helpIfAsked,
  installCrashLogger,
  scriptArgs,
  stamp,
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
  unixToIso,
} from './lib/stellar.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../contracts/two-clocks/fixtures/streams-eth-usd-testnet-sample.hex', import.meta.url));

const USAGE = `
Usage: pnpm submit -- --network testnet [--file <path> | --hex <hex>] [--peek] [--expect-expired] [--contract <C...>] [--log <path>]

Decodes the signed report locally, runs verify_report by simulation on Two
Clocks (the verifier checks the signatures, nothing is stored), then sends
submit_report. --peek stops after the simulation. --expect-expired treats
#23 Expired as the expected outcome and exits 0 with both dates.
Default file: the published testnet sample, ${FIXTURE_PATH}
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string' },
    file: { type: 'string' },
    hex: { type: 'string' },
    peek: { type: 'boolean', default: false },
    'expect-expired': { type: 'boolean', default: false },
    contract: { type: 'string' },
  },
  strict: true,
});
helpIfAsked(values.help, USAGE);

const logger = createLogger(values.log);
installCrashLogger(logger);
loadEnv();

let net;
let contract: string;
try {
  net = parseNetwork(values.network);
  requireSendableNetwork(net);
  contract = clocksId(net, values.contract);
} catch (error) {
  fail(logger, `${errorMessage(error)}\n${USAGE.trim()}`);
}
if (values.hex !== undefined && values.file !== undefined) fail(logger, `give --hex or --file, not both\n${USAGE.trim()}`);

let report: Uint8Array;
let decoded;
const origin = values.hex !== undefined ? '--hex' : (values.file ?? FIXTURE_PATH);
try {
  report = hexToBytes(values.hex ?? readFileSync(values.file ?? FIXTURE_PATH, 'utf8'));
  decoded = decodeSignedReport(report);
} catch (error) {
  fail(logger, `cannot decode the report: ${errorMessage(error)}`);
}
const { full, report: local } = decoded;
const asset = assetByStreamId(net.name, local.streamId);

logger.section('Local decode');
logger.log(`source ${origin}: ${report.length} bytes, reportData ${full.reportData.length} bytes at offset ${full.reportDataOffset}, ${full.rs.length} signatures`);
logger.log(`stream ${local.streamId} (${asset ? asset.label : 'not mapped in feeds.ts for this network'}), schema v${local.schemaVersion}`);
logger.log(`validFrom ${unixToIso(local.validFrom)}, observations ${unixToIso(local.observationsTs)}, expiresAt ${unixToIso(local.expiresAt)}`);
logger.log(`price ${formatE18(local.price)} bid ${formatE18(local.bid)} ask ${formatE18(local.ask)}`);
const nowSec = Math.floor(Date.now() / 1000);
if (local.expiresAt <= nowSec) {
  logger.log(`expired ${formatSeconds(nowSec - local.expiresAt)} ago (${Math.floor((nowSec - local.expiresAt) / 86400)} days): the contract will answer #23 Expired`);
} else {
  logger.log(`valid for ${formatSeconds(local.expiresAt - nowSec)} more`);
}

let signer;
try {
  signer = await loadKeypair(net);
} catch (error) {
  fail(logger, errorMessage(error));
}
const { keypair, origin: keyOrigin } = signer;
logger.log(`${net.name}: two-clocks ${contract}, signer ${keypair.publicKey()} (${keyOrigin})`);

let maxPushAgeS: number | undefined;
try {
  const config = await readConfig(net, contract, keypair.publicKey());
  maxPushAgeS = Number(config.max_push_age_s);
  logger.log(`config: verifier ${config.verifier}, max_pull_age_s ${config.max_pull_age_s}`);
} catch (error) {
  fail(logger, `config() failed: ${errorMessage(error)}`);
}

logger.section('verify_report by simulation');
const verifyStart = performance.now();
try {
  const verified = await verifyReport(net, contract, report, keypair.publicKey());
  const same =
    bytesToHex(verified.stream_id, true) === local.streamId &&
    verified.price === local.price &&
    verified.bid === local.bid &&
    verified.ask === local.ask &&
    Number(verified.observations_ts) === local.observationsTs &&
    Number(verified.expires_at) === local.expiresAt;
  logger.log(
    `verified in ${formatMs(performance.now() - verifyStart)}: price ${formatE18(verified.price)} bid ${formatE18(verified.bid)} ask ${formatE18(verified.ask)}, observations ${unixToIso(Number(verified.observations_ts))}, expiresAt ${unixToIso(Number(verified.expires_at))}, same as the local decode: ${same ? 'yes' : 'NO'}`,
  );
  logger.log('the verifier checked f+1 signatures and returned the report data. Nothing was stored.');
} catch (error) {
  if (error instanceof ContractCallError) fail(logger, `verify_report rejected the report in ${formatMs(performance.now() - verifyStart)}: ${error.message} [${rawHead(error.raw)}]`);
  throw error;
}

if (values.peek) {
  logger.log('--peek: stopping before submit_report. Nothing was sent.');
  process.exit(0);
}

logger.section('submit_report');
const submitStart = Date.now();
try {
  const result = await submitReport(net, contract, keypair, report);
  const fee = result.feeCharged ?? 0n;
  const closeSec = result.createdAt ?? Math.floor(Date.now() / 1000);
  const latency = result.createdAt !== undefined ? formatMs(Math.max(0, result.createdAt * 1000 - submitStart)) : 'n/a';
  logger.log(`stored: ${describePull(result.result, closeSec)}`);
  logger.log(`tx ${result.hash}, ledger ${result.ledger}, fee ${fee} stroops (${stroopsToXlm(fee)}), latency call to ledger close ${latency}`);
  logger.log(`  ${explorerUrl(net, 'tx', result.hash ?? '')}`);
  if (asset) {
    const pairs = await readLatestMany(net, contract, [asset], keypair.publicKey());
    const pair = pairs[0];
    if (pair) describePair(asset, pair, { net: net.name, nowSec: Math.floor(Date.now() / 1000), maxPushAgeS }).forEach((line) => logger.log(line));
  }
} catch (error) {
  if (error instanceof ContractCallError && error.code === 23) {
    logger.log(`${error.message} [${rawHead(error.raw)}]`);
    logger.log(`report expiresAt ${unixToIso(local.expiresAt)}, now ${stamp()}: expired ${formatSeconds(Math.floor(Date.now() / 1000) - local.expiresAt)} ago`);
    logger.log(`rejected at the ${error.stage} stage: nothing was sent and no fee was charged`);
    if (values['expect-expired']) {
      logger.log('as expected (--expect-expired)');
      process.exit(0);
    }
    fail(logger, 'the report is expired. A fresh report needs a paid Data Streams subscription.');
  }
  if (error instanceof ContractCallError && error.feeCharged !== undefined) {
    logger.log(`nothing stored, but the network kept the fee: ${error.feeCharged} stroops (${stroopsToXlm(error.feeCharged)})`);
  }
  fail(logger, errorMessage(error));
}
