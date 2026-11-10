// Run 0: recon. Read-only and keyless where possible. Every contract call is
// a simulation and nothing is signed. Evidence for the field note goes to --log.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ASSETS, HEARTBEAT_S, assetByKey, assetByStreamId, type Asset } from '../src/lib/feeds.ts';
import { bytesToHex, decodeReportV3, decodeSignedReport, flipBit, formatE18, hexToBytes } from '../src/lib/report.ts';
import {
  proxyDecimals,
  proxyDescription,
  proxyLatestRound,
  proxyMinDecimals,
  proxyTypeAndVersion,
  proxyVersion,
  verifierIsInitialized,
  verifyRaw,
  type Round,
} from './lib/clocks.ts';
import {
  COMMON_OPTIONS,
  createLogger,
  errorMessage,
  formatMs,
  helpIfAsked,
  installCrashLogger,
  scriptArgs,
  stamp,
} from './lib/log.ts';
import {
  CANDLESTICK_API,
  STREAMS_API,
  authorize,
  candlestickKeyFromEnv,
  credentialsFromEnv,
  describeReply,
  discovery,
  feedsList,
  historyRows,
  jsonOf,
  latestReport,
  literalToE18,
  lossyCandles,
  shortBody,
  symbolInfo,
  usernameHint,
  type StreamsEnv,
} from './lib/streams.ts';
import {
  ContractCallError,
  NETWORKS,
  formatSeconds,
  loadEnv,
  networkInfo,
  rawHead,
  readerAccount,
  rpcServer,
  unixToIso,
  type Network,
} from './lib/stellar.ts';

const USAGE = `
Usage: pnpm recon -- [--network both|testnet|mainnet] [--skip-api] [--report <hex|path>] [--log <path>]

Run 0 of the field note. Read-only, keyless where possible, signs nothing:
  Stellar RPC and the simulation source on each network,
  the Data Feeds proxy: version, every feed's description, decimals, latest round, error probes #50 and #51, truncation at 8 decimals,
  the verifier: is_initialized, the sample report through verify by simulation, one tampered byte (#12), the mainnet verifier (#9),
  the Data Streams API with the credentials in .env (exact status and body of every answer),
  the Candlestick API: authorize, symbol_info, history/rows with exact and float parsing.
--skip-api leaves out the two API sections. --report replaces the sample report.
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string', default: 'both' },
    'skip-api': { type: 'boolean', default: false },
    report: { type: 'string' },
  },
  strict: true,
});
helpIfAsked(values.help, USAGE);

const logger = createLogger(values.log);
installCrashLogger(logger);
loadEnv();

const nets: Network[] =
  values.network === 'both'
    ? [NETWORKS.testnet, NETWORKS.mainnet]
    : values.network === 'testnet' || values.network === 'mainnet'
      ? [NETWORKS[values.network]]
      : [];
if (nets.length === 0) {
  logger.log(`FAIL  --network must be both, testnet or mainnet, got "${values.network}"`);
  process.exit(1);
}
const hasTestnet = nets.some((net) => net.name === 'testnet');
const hasMainnet = nets.some((net) => net.name === 'mainnet');

const FIXTURE_PATH = fileURLToPath(new URL('../contracts/two-clocks/fixtures/streams-eth-usd-testnet-sample.hex', import.meta.url));
const failures: string[] = [];
let sectionCount = 0;
const runStart = performance.now();

async function section(title: string, body: () => Promise<void>): Promise<void> {
  sectionCount += 1;
  logger.section(title);
  const started = performance.now();
  try {
    await body();
    logger.log(`-- ok (${formatMs(performance.now() - started)})`);
  } catch (error) {
    failures.push(title);
    logger.log(`-- FAILED: ${errorMessage(error)}`);
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function describeError(error: unknown): string {
  return error instanceof ContractCallError ? `${error.message} [${rawHead(error.raw)}]` : errorMessage(error);
}

/** The contract error code of a failed simulation, or undefined when the call succeeded or failed otherwise. */
function codeOf(settled: Settled<unknown>): number | undefined {
  return !settled.ok && settled.error instanceof ContractCallError ? settled.error.code : undefined;
}

const xlm = assetByKey('xlm');
if (!xlm) throw new Error('feeds.ts has no xlm asset');

logger.log(`Run 0: recon, started ${stamp()}, node ${process.version}, networks ${nets.map((net) => net.name).join(' and ')}`);
logger.log('Read-only. No signing, no fees: every contract call below is a simulation.');

await section('Stellar RPC', async () => {
  for (const net of nets) {
    const info = await networkInfo(net);
    logger.log(
      `${net.name}: ${net.rpcUrl} latest ledger ${info.latestLedger} closed ${unixToIso(info.closeTime)}, protocol ${info.protocolVersion}, passphrase matches: ${info.passphraseMatches ? 'yes' : 'NO'}`,
    );
  }
});

await section('Simulation sources', async () => {
  for (const net of nets) {
    const source = await readerAccount(net);
    const account = await rpcServer(net).getAccount(source);
    const origin = source === net.reader ? 'the known reader' : 'a friendbot throwaway, kept in memory only';
    logger.log(`${net.name}: ${source} (${origin}), sequence ${account.sequenceNumber()}, read-only, never signs`);
  }
});

interface FeedRead {
  description: Settled<string>;
  decimals: Settled<number>;
  minDecimals: Settled<number>;
  latest: Settled<Round>;
}

function describeRound(round: Round, net: Network, nowSec: number): string {
  const age = nowSec - Number(round.timestamp);
  const heartbeat = HEARTBEAT_S[net.name];
  const verdict = age <= heartbeat ? 'within heartbeat' : `OVER heartbeat by ${formatSeconds(age - heartbeat)}`;
  return `${formatE18(round.answer)} USD (raw ${round.answer}), round ${round.round_id}, feed ${unixToIso(Number(round.timestamp))}, age ${formatSeconds(age)}, heartbeat ${heartbeat} s: ${verdict}`;
}

for (const net of nets) {
  await section(`Data Feeds proxy ${net.name} (${net.proxy})`, async () => {
    const source = await readerAccount(net);
    const [version, typeAndVersion] = await Promise.all([proxyVersion(net, source), proxyTypeAndVersion(net, source)]);
    logger.log(`version ${version}, type_and_version "${typeAndVersion}"`);
    const notes: string[] = [];
    // Testnet answers slowly, so its four reads per asset run at once. Mainnet
    // rate-limits bursts (HTTP 429), so its reads run one after the other.
    const parallel = net.name === 'testnet';
    for (const asset of ASSETS) {
      const reads: FeedRead = parallel
        ? await (async (): Promise<FeedRead> => {
            const [description, decimals, minDecimals, latest] = await Promise.all([
              settle(proxyDescription(net, asset.dataId, source)),
              settle(proxyDecimals(net, asset.dataId, source)),
              settle(proxyMinDecimals(net, asset.dataId, source)),
              settle(proxyLatestRound(net, asset.dataId, 18, source)),
            ]);
            return { description, decimals, minDecimals, latest };
          })()
        : {
            description: await settle(proxyDescription(net, asset.dataId, source)),
            decimals: await settle(proxyDecimals(net, asset.dataId, source)),
            minDecimals: await settle(proxyMinDecimals(net, asset.dataId, source)),
            latest: await settle(proxyLatestRound(net, asset.dataId, 18, source)),
          };
      const nowSec = Math.floor(Date.now() / 1000);
      const meta = [
        reads.description.ok ? `"${reads.description.value}"` : `description: ${describeError(reads.description.error)}`,
        reads.decimals.ok ? `decimals ${reads.decimals.value}` : `decimals: ${describeError(reads.decimals.error)}`,
        reads.minDecimals.ok ? `min ${reads.minDecimals.value}` : `min: ${describeError(reads.minDecimals.error)}`,
      ].join(', ');
      logger.log(`${asset.key.padEnd(4)}  ${meta}`);
      if (reads.latest.ok) {
        logger.log(`      latest_round(18): ${describeRound(reads.latest.value, net, nowSec)}`);
      } else {
        logger.log(`      latest_round(18): ${describeError(reads.latest.error)}`);
        notes.push(asset.key);
      }
      if (reads.description.ok && reads.description.value.replace(/\s/g, '') !== asset.label.replace(/\s/g, '')) {
        logger.log(`      NOTE: feeds.ts says "${asset.label}"`);
      }
      if (reads.decimals.ok && reads.decimals.value !== 18) logger.log(`      NOTE: decimals ${reads.decimals.value}, feeds.ts assumes 18`);
    }
    if (notes.length > 0) logger.log(`feeds without a readable latest round: ${notes.join(', ')}`);

    const unknownId = 'ff'.repeat(32);
    const probe50 = await settle(proxyLatestRound(net, unknownId, 18, source));
    logger.log(`probe unknown id ${unknownId.slice(0, 10)}...: ${probe50.ok ? `UNEXPECTED round ${probe50.value.round_id}` : describeError(probe50.error)}`);
    if (codeOf(probe50) !== 50) throw new Error(`unknown id gave ${codeOf(probe50) ?? 'no code'}, expected #50 NoDataPresent`);

    const probe51 = await settle(proxyLatestRound(net, xlm.dataId, 0, source));
    logger.log(`probe xlm decimals 0: ${probe51.ok ? `UNEXPECTED round ${probe51.value.round_id}` : describeError(probe51.error)}`);
    if (codeOf(probe51) !== 51) throw new Error(`decimals 0 gave ${codeOf(probe51) ?? 'no code'}, expected #51 InvalidDecimals`);

    const at18 = await settle(proxyLatestRound(net, xlm.dataId, 18, source));
    const at8 = await settle(proxyLatestRound(net, xlm.dataId, 8, source));
    if (at18.ok && at8.ok) {
      const truncated = at18.value.answer / 10n ** 10n;
      const sameRound = at18.value.round_id === at8.value.round_id;
      logger.log(
        `truncation xlm: answer ${at18.value.answer} at 18 decimals, ${at8.value.answer} at 8 decimals (round ${at8.value.round_id}), equals answer / 10^10: ${at8.value.answer === truncated ? 'yes' : sameRound ? 'NO' : 'rounds differ, compare again'}`,
      );
      if (at8.value.answer !== truncated && sameRound) throw new Error('decimals 8 is not a truncation of the 18-decimal answer');
    } else {
      logger.log(`truncation xlm: ${at18.ok ? '' : describeError(at18.error)} ${at8.ok ? '' : describeError(at8.error)}`.trim());
      throw new Error('could not read xlm at 18 and 8 decimals');
    }
  });
}

await section('Verifier', async () => {
  for (const net of nets) {
    const source = await readerAccount(net);
    const initialized = await verifierIsInitialized(net, source);
    logger.log(`${net.name} verifier ${net.verifier}: is_initialized ${initialized}`);
  }
});

function loadReport(value: string | undefined): { bytes: Uint8Array; origin: string } {
  if (value === undefined) return { bytes: hexToBytes(readFileSync(FIXTURE_PATH, 'utf8')), origin: FIXTURE_PATH };
  if (existsSync(value)) return { bytes: hexToBytes(readFileSync(value, 'utf8')), origin: value };
  return { bytes: hexToBytes(value), origin: '--report hex' };
}

const sample = loadReport(values.report);
const decoded = decodeSignedReport(sample.bytes);
const sampleAsset: Asset | undefined = assetByStreamId('testnet', decoded.report.streamId);

await section('Sample report', async () => {
  const { full, report } = decoded;
  logger.log(`source ${sample.origin}`);
  logger.log(
    `${sample.bytes.length} bytes: reportData ${full.reportData.length} bytes at offset ${full.reportDataOffset} (length word at ${full.reportDataOffset - 32}), ${full.rs.length} signatures (rs ${full.rs.length}, ss ${full.ss.length}, f = ${full.rs.length - 1}), rawVs ${bytesToHex(full.rawVs).slice(0, 8)}...`,
  );
  logger.log(`config digest ${bytesToHex(full.context[0], true)}`);
  logger.log(`stream ${report.streamId} (${sampleAsset ? `${sampleAsset.label} on testnet` : 'not in feeds.ts'}), schema v${report.schemaVersion}`);
  logger.log(
    `validFrom ${report.validFrom} (${unixToIso(report.validFrom)}), observations ${report.observationsTs} (${unixToIso(report.observationsTs)}), expiresAt ${report.expiresAt} (${unixToIso(report.expiresAt)})`,
  );
  logger.log(`price ${formatE18(report.price)} bid ${formatE18(report.bid)} ask ${formatE18(report.ask)} (18 decimals), nativeFee ${report.nativeFee}, linkFee ${report.linkFee} (legacy fields)`);
  const nowSec = Math.floor(Date.now() / 1000);
  if (report.expiresAt <= nowSec) {
    logger.log(`expired ${Math.floor((nowSec - report.expiresAt) / 86400)} days ago (as of ${stamp()}): submit_report would answer #23 Expired`);
  } else {
    logger.log(`valid for ${formatSeconds(report.expiresAt - nowSec)} more`);
  }
});

if (hasTestnet) {
  await section('verify by simulation (testnet verifier)', async () => {
    const net = NETWORKS.testnet;
    const source = await readerAccount(net);
    const started = performance.now();
    const returned = await verifyRaw(net, sample.bytes, source);
    const identical = bytesToHex(returned) === bytesToHex(decoded.full.reportData);
    const report = decodeReportV3(returned);
    logger.log(
      `verify(sample, ${source}) returned ${returned.length} bytes in ${formatMs(performance.now() - started)}, identical to the local reportData: ${identical ? 'yes' : 'NO'}`,
    );
    logger.log(`decoded: price ${formatE18(report.price)} bid ${formatE18(report.bid)} ask ${formatE18(report.ask)}, observations ${unixToIso(report.observationsTs)}, expiresAt ${unixToIso(report.expiresAt)}`);
    logger.log(
      `a report signed on ${unixToIso(report.observationsTs)} verifies today: the verifier checks f+1 signatures against the DON config and nothing else. Freshness and expiry are the consumer's job.`,
    );
    if (!identical) throw new Error('the verifier returned different bytes than the local decode');
  });

  await section('Tampered byte (479, expect #12 BadVerification)', async () => {
    const tampered = flipBit(sample.bytes, 479);
    const local = decodeSignedReport(tampered).report;
    logger.log(`flipped bit 0 of byte 479: price now reads ${formatE18(local.price)} (raw ${local.price}), bid and ask unchanged: ${local.bid === decoded.report.bid && local.ask === decoded.report.ask ? 'yes' : 'NO'}`);
    const net = NETWORKS.testnet;
    const source = await readerAccount(net);
    const result = await settle(verifyRaw(net, tampered, source));
    if (result.ok) throw new Error('the verifier accepted the tampered report');
    logger.log(`testnet: ${describeError(result.error)}`);
    if (codeOf(result) !== 12) throw new Error(`expected #12, got ${codeOf(result) ?? 'no code'}`);
  });
}

if (hasMainnet) {
  await section('Mainnet verifier (expect #9 DigestNotSet)', async () => {
    const net = NETWORKS.mainnet;
    const source = await readerAccount(net);
    const result = await settle(verifyRaw(net, sample.bytes, source));
    if (result.ok) throw new Error('the mainnet verifier accepted a testnet report');
    logger.log(`mainnet verifier ${net.verifier}: ${describeError(result.error)}`);
    logger.log('the config digest in reportContext[0] is registered on the testnet verifier only. The same bytes are not portable across networks.');
    if (codeOf(result) !== 9) throw new Error(`expected #9, got ${codeOf(result) ?? 'no code'}`);
  });
}

const envs: StreamsEnv[] = ['testnet', 'mainnet'];

if (!values['skip-api']) {
  await section('Data Streams API', async () => {
    const creds = credentialsFromEnv();
    logger.log(creds ? `credentials: username present (${usernameHint(creds.username)}), secret present` : 'no DATA_STREAMS_USERNAME or DATA_STREAMS_SECRET in .env: keyless calls only');
    for (const env of envs) {
      const withUa = await discovery(env, { userAgent: true });
      const catalog = jsonOf(withUa) as { feeds?: unknown[] } | undefined;
      const count = Array.isArray(catalog?.feeds) ? `${catalog.feeds.length} streams` : 'no feeds array';
      logger.log(`${env} GET ${STREAMS_API[env]}/api/v1/discovery with User-Agent: HTTP ${withUa.status} in ${Math.round(withUa.ms)} ms (${count})`);
      const withoutUa = await discovery(env, { userAgent: false });
      logger.log(`${env} the same with an empty User-Agent: HTTP ${withoutUa.status}, body: ${shortBody(withoutUa.body, 60)}`);
    }
    if (!creds) return;
    for (const env of envs) {
      const feeds = await feedsList(env, creds);
      logger.log(`${env} GET /api/v1/feeds: ${describeReply(feeds)}`);
    }
    for (const env of envs) {
      for (const key of ['xlm', 'eth']) {
        const asset = assetByKey(key);
        const streamId = asset?.streamIds[env];
        if (!asset || !streamId) {
          logger.log(`${env} ${key}: no stream id in feeds.ts`);
          continue;
        }
        const reply = await latestReport(env, creds, streamId);
        logger.log(`${env} GET /api/v1/reports/latest?feedID=${streamId.slice(0, 12)}... (${asset.label}): ${describeReply(reply)}`);
      }
    }
  });

  await section('Candlestick', async () => {
    const creds = credentialsFromEnv();
    const key = candlestickKeyFromEnv();
    if (!creds || !key) {
      logger.log('skipped: CANDLESTICK_API_KEY or DATA_STREAMS_USERNAME missing in .env');
      return;
    }
    const auth = await authorize('mainnet', creds.username, key);
    const expiry = auth.expiration !== undefined ? `${unixToIso(auth.expiration)} (in ${formatSeconds(auth.expiration - Math.floor(Date.now() / 1000))})` : 'none';
    logger.log(`mainnet POST ${CANDLESTICK_API.mainnet}/api/v1/authorize: HTTP ${auth.status} in ${Math.round(auth.ms)} ms, token ${auth.token ? 'received (not logged)' : 'absent'}, expiration ${expiry}`);
    if (!auth.token) {
      logger.log(`  body: ${shortBody(auth.body)}`);
    } else {
      const info = await symbolInfo('mainnet', auth.token, 'crypto');
      const symbols = info.symbols ?? [];
      logger.log(`mainnet GET /api/v1/symbol_info?group=crypto: HTTP ${info.status}, ${symbols.length} symbols, XLMUSD ${symbols.includes('XLMUSD') ? 'present' : 'ABSENT'}, ETHUSD ${symbols.includes('ETHUSD') ? 'present' : 'ABSENT'}`);
      const to = Math.floor(Date.now() / 1000);
      const rows = await historyRows('mainnet', auth.token, { symbol: 'ETHUSD', resolution: '1h', from: to - 6 * 3600, to });
      logger.log(`mainnet GET /api/v1/history/rows?symbol=ETHUSD&resolution=1h (last 6 h): HTTP ${rows.status} in ${Math.round(rows.ms)} ms, ${rows.candles?.length ?? 'no'} candles, body ${rows.body.length} chars`);
      if (rows.candles && rows.status === 200) {
        const lossy = lossyCandles(rows.body);
        rows.candles.slice(0, 3).forEach((candle, index) => {
          const float = lossy[index]?.[4];
          logger.log(`  ${unixToIso(Number(candle.t))} close literal ${candle.c} = ${literalToE18(candle.c)} USD exact; JSON.parse gives ${float === undefined ? 'nothing' : String(float)}${float !== undefined && String(float) !== candle.c ? ' (digits lost)' : ''}`);
        });
      } else {
        logger.log(`  body: ${shortBody(rows.body)}`);
      }
    }
    const testnetAuth = await authorize('testnet', creds.username, key);
    logger.log(`testnet POST ${CANDLESTICK_API.testnet}/api/v1/authorize: HTTP ${testnetAuth.status}, token ${testnetAuth.token ? 'received (not logged)' : 'absent'}, body: ${shortBody(testnetAuth.body, 200)}`);
  });
}

logger.section('Summary');
logger.log(`${sectionCount - failures.length}/${sectionCount} sections ok in ${formatMs(performance.now() - runStart)}`);
for (const failure of failures) logger.log(`failed: ${failure}`);
logger.log('nothing was signed or sent');
process.exit(failures.length === 0 ? 0 : 1);
