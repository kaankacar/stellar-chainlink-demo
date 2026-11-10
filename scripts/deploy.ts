// Upload two_clocks.wasm, create the contract with the constructor args and
// record the result in src/deployments.json. Build the wasm first: pnpm build:wasm.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Address, Operation } from '@stellar/stellar-sdk';
import { parseAssetKeys, type Asset } from '../src/lib/feeds.ts';
import { bytesToHex } from '../src/lib/report.ts';
import { constructorArgs, readAssets, readConfig } from './lib/clocks.ts';
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
  explorerUrl,
  loadEnv,
  loadKeypair,
  nativeBalance,
  parseNetwork,
  requireSendableNetwork,
  sha256Hex,
  stroopsToXlm,
  submit,
  writeDeployment,
} from './lib/stellar.ts';

const DEFAULT_WASM = 'contracts/two-clocks/target/wasm32v1-none/release/two_clocks.wasm';

const USAGE = `
Usage: pnpm run deploy -- --network testnet [--max-push-age-s 90000] [--max-pull-age-s 120] [--assets all] [--wasm <path>] [--log <path>]

Uploads the wasm, creates the contract with
  (admin = signer, proxy, verifier, max_push_age_s, max_pull_age_s, assets)
where proxy and verifier come from the network table and every asset carries
its testnet stream id when one exists. Checks config() and assets() by
simulation and writes src/deployments.json. Signs with STELLAR_SECRET from
.env; a throwaway friendbot key is used when it is empty. Mainnet is refused.
Default wasm: ${DEFAULT_WASM}
`;

const { values } = parseArgs({
  args: scriptArgs(),
  options: {
    ...COMMON_OPTIONS,
    network: { type: 'string' },
    'max-push-age-s': { type: 'string', default: '90000' },
    'max-pull-age-s': { type: 'string', default: '120' },
    assets: { type: 'string', default: 'all' },
    wasm: { type: 'string', default: DEFAULT_WASM },
  },
  strict: true,
});
helpIfAsked(values.help, USAGE);

const logger = createLogger(values.log);
installCrashLogger(logger);
loadEnv();

let net;
let assets: Asset[];
try {
  net = parseNetwork(values.network);
  requireSendableNetwork(net);
  assets = parseAssetKeys(values.assets);
} catch (error) {
  fail(logger, `${errorMessage(error)}\n${USAGE.trim()}`);
}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(logger, `${flag} must be a positive integer, got "${raw}"`);
  return n;
}
const maxPushAgeS = positiveInt('--max-push-age-s', values['max-push-age-s']);
const maxPullAgeS = positiveInt('--max-pull-age-s', values['max-pull-age-s']);

let wasm: Uint8Array;
try {
  wasm = new Uint8Array(readFileSync(values.wasm));
} catch (error) {
  fail(logger, `cannot read ${values.wasm}: ${errorMessage(error)}. Build it first with "pnpm build:wasm".`);
}
const wasmHash = sha256Hex(wasm);

logger.section(`Deploy two-clocks to ${net.name}`);
logger.log(`wasm ${values.wasm}: ${wasm.length} bytes, sha256 ${wasmHash}`);
logger.log(`constructor: proxy ${net.proxy}, verifier ${net.verifier}, max_push_age_s ${maxPushAgeS}, max_pull_age_s ${maxPullAgeS}`);
for (const asset of assets) {
  const streamId = asset.streamIds[net.name];
  logger.log(`  ${asset.key.padEnd(4)} ${asset.dataId}  "${asset.label}"  stream ${streamId ?? 'none'}`);
}

let signer;
try {
  signer = await loadKeypair(net);
} catch (error) {
  fail(logger, errorMessage(error));
}
const { keypair, origin } = signer;
const balance = await nativeBalance(net, keypair.publicKey());
logger.log(`signer and admin ${keypair.publicKey()} (${origin}), balance ${balance ?? 'account not found'} XLM`);
if (balance === undefined) fail(logger, `fund ${keypair.publicKey()} on ${net.name} first`);

const runStart = performance.now();
let totalFee = 0n;

logger.section('Upload wasm');
try {
  const upload = await submit<Uint8Array>(net, Operation.uploadContractWasm({ wasm }), { send: true, keypair });
  totalFee += upload.feeCharged ?? 0n;
  const returnedHash = upload.result ? bytesToHex(upload.result) : '(none)';
  logger.log(`tx ${upload.hash}, ledger ${upload.ledger}, fee ${upload.feeCharged} stroops (${stroopsToXlm(upload.feeCharged ?? 0n)})`);
  logger.log(`wasm hash on chain ${returnedHash}, matches local sha256: ${returnedHash === wasmHash ? 'yes' : 'NO'}`);
  logger.log(`  ${explorerUrl(net, 'tx', upload.hash ?? '')}`);
} catch (error) {
  fail(logger, `upload failed: ${errorMessage(error)}`);
}

logger.section('Create contract');
let contractId = '';
let deployTx = '';
try {
  const create = await submit(
    net,
    Operation.createCustomContract({
      address: new Address(keypair.publicKey()),
      wasmHash: Buffer.from(wasmHash, 'hex'),
      salt: randomBytes(32),
      constructorArgs: constructorArgs({
        admin: keypair.publicKey(),
        proxy: net.proxy,
        verifier: net.verifier,
        maxPushAgeS,
        maxPullAgeS,
        assets,
        net: net.name,
      }),
    }),
    { send: true, keypair },
  );
  totalFee += create.feeCharged ?? 0n;
  contractId = typeof create.result === 'string' ? create.result : String(create.result);
  deployTx = create.hash ?? '';
  logger.log(`tx ${deployTx}, ledger ${create.ledger}, fee ${create.feeCharged} stroops (${stroopsToXlm(create.feeCharged ?? 0n)})`);
  logger.log(`contract ${contractId}`);
  logger.log(`  ${explorerUrl(net, 'contract', contractId)}`);
  logger.log(`  ${explorerUrl(net, 'tx', deployTx)}`);
} catch (error) {
  fail(logger, `create failed: ${errorMessage(error)}`);
}

logger.section('Check config() and assets() by simulation');
try {
  const config = await readConfig(net, contractId, keypair.publicKey());
  logger.log(`admin ${config.admin}, proxy ${config.proxy}, verifier ${config.verifier}, max_push_age_s ${config.max_push_age_s}, max_pull_age_s ${config.max_pull_age_s}`);
  const configOk =
    config.admin === keypair.publicKey() &&
    config.proxy === net.proxy &&
    config.verifier === net.verifier &&
    config.max_push_age_s === BigInt(maxPushAgeS) &&
    config.max_pull_age_s === BigInt(maxPullAgeS);
  if (!configOk) fail(logger, 'config() does not match the constructor args');
  const onChain = await readAssets(net, contractId, keypair.publicKey());
  logger.log(`assets() returned ${onChain.length} entries (expected ${assets.length})`);
  if (onChain.length !== assets.length) fail(logger, 'assets() count does not match');
  assets.forEach((asset, index) => {
    const view = onChain[index];
    const dataIdOk = view !== undefined && bytesToHex(view.data_id) === asset.dataId;
    const expectedStream = asset.streamIds[net.name]?.toLowerCase().replace(/^0x/, '');
    const streamOnChain = view?.stream_id ? bytesToHex(view.stream_id) : undefined;
    const streamOk = streamOnChain === expectedStream;
    logger.log(`  ${asset.key.padEnd(4)} data_id ${dataIdOk ? 'ok' : 'MISMATCH'}, label "${view?.label ?? '?'}", stream ${streamOnChain ?? 'none'} ${streamOk ? 'ok' : 'MISMATCH'}`);
    if (!dataIdOk || !streamOk) fail(logger, `assets() entry ${index} does not match feeds.ts`);
  });
} catch (error) {
  fail(logger, `check failed: ${errorMessage(error)}`);
}

writeDeployment(net.name, {
  twoClocks: contractId,
  proxy: net.proxy,
  verifier: net.verifier,
  maxPushAgeS,
  maxPullAgeS,
  assets: assets.map((asset) => asset.key),
  deployedAt: stamp(),
  deployTx,
  reader: keypair.publicKey(),
});
logger.log(`src/deployments.json updated for ${net.name}`);
logger.log(`total fee ${stroopsToXlm(totalFee)} in ${formatMs(performance.now() - runStart)}`);
