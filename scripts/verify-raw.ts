// Simulate verify on the Chainlink verifier itself and decode what it returns.
// --tamper flips one bit and expects #12; the mainnet verifier answers #9.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assetByStreamId } from '../src/lib/feeds.ts';
import { bytesToHex, decodeReportV3, decodeSignedReport, flipBit, formatE18, hexToBytes } from '../src/lib/report.ts';
import { verifyRaw } from './lib/clocks.ts';
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
import { ContractCallError, formatSeconds, parseNetwork, rawHead, readerAccount, unixToIso } from './lib/stellar.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../contracts/two-clocks/fixtures/streams-eth-usd-testnet-sample.hex', import.meta.url));

const USAGE = `
Usage: pnpm verify-raw -- --network <testnet|mainnet> [--file <path> | --hex <hex>] [--tamper] [--tamper-byte 479] [--log <path>]

Decodes the signed report locally, then simulates verify(signed_report, sender)
on the Chainlink verifier (no signing, no fee) and decodes the bytes it returns.
--tamper flips bit 0 of one byte (default 479, the low byte of the price) and
expects #12 BadVerification. The mainnet verifier answers #9 DigestNotSet for
a testnet report. Default file: the published testnet sample.
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string' },
    hex: { type: 'string' },
    file: { type: 'string' },
    tamper: { type: 'boolean', default: false },
    'tamper-byte': { type: 'string', default: '479' },
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
if (values.hex !== undefined && values.file !== undefined) fail(logger, `give --hex or --file, not both\n${USAGE.trim()}`);

let report: Uint8Array;
let decoded;
try {
  report = hexToBytes(values.hex ?? readFileSync(values.file ?? FIXTURE_PATH, 'utf8'));
  decoded = decodeSignedReport(report);
} catch (error) {
  fail(logger, `cannot decode the input: ${errorMessage(error)}`);
}
const { full, report: local } = decoded;
const nowSec = Math.floor(Date.now() / 1000);
const asset = assetByStreamId('testnet', local.streamId);
logger.log(`report: ${report.length} bytes, reportData ${full.reportData.length} bytes at offset ${full.reportDataOffset}, ${full.rs.length} signatures`);
logger.log(`stream ${local.streamId} (${asset ? `${asset.label} on testnet` : 'not in feeds.ts'}), observations ${unixToIso(local.observationsTs)}, expiresAt ${unixToIso(local.expiresAt)} (${local.expiresAt <= nowSec ? `expired ${formatSeconds(nowSec - local.expiresAt)} ago` : 'valid'})`);
logger.log(`price ${formatE18(local.price)} bid ${formatE18(local.bid)} ask ${formatE18(local.ask)}`);

const tamperByte = Number(values['tamper-byte']);
if (values.tamper) {
  if (!Number.isInteger(tamperByte) || tamperByte < 0 || tamperByte >= report.length) {
    fail(logger, `--tamper-byte must be 0 to ${report.length - 1}, got "${values['tamper-byte']}"`);
  }
  report = flipBit(report, tamperByte, 0);
  const tampered = decodeSignedReport(report).report;
  logger.log(`tamper: flipped bit 0 of byte ${tamperByte}; price now decodes as ${formatE18(tampered.price)} (raw ${tampered.price}); expecting #12 BadVerification`);
}

const source = await readerAccount(net);
logger.log(`${net.name}: simulating verify on ${net.verifier} with source and sender ${source}`);
const started = performance.now();
try {
  const returned = await verifyRaw(net, report, source);
  const identical = bytesToHex(returned) === bytesToHex(full.reportData);
  const fromVerifier = decodeReportV3(returned);
  logger.log(`verified in ${formatMs(performance.now() - started)}: ${returned.length} bytes returned, identical to the local reportData: ${identical ? 'yes' : 'NO'}`);
  logger.log(`decoded: price ${formatE18(fromVerifier.price)} bid ${formatE18(fromVerifier.bid)} ask ${formatE18(fromVerifier.ask)}, observations ${unixToIso(fromVerifier.observationsTs)}, expiresAt ${unixToIso(fromVerifier.expiresAt)}`);
  if (values.tamper) fail(logger, 'the verifier accepted a tampered report');
} catch (error) {
  if (!(error instanceof ContractCallError)) throw error;
  logger.log(`rejected in ${formatMs(performance.now() - started)}: ${error.message} [${rawHead(error.raw)}]`);
  const expected = values.tamper ? 12 : net.name === 'mainnet' ? 9 : undefined;
  if (expected !== undefined && error.code === expected) {
    logger.log(`as expected (#${expected})`);
  } else {
    process.exit(1);
  }
}
