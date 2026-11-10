// Network table and the deployment the page reads. Facts from SPEC.md, verified 9 and 10 November 2026.
// Nothing here touches the browser, so scripts and tests may import it too.
import { StrKey } from '@stellar/stellar-sdk';
import deploymentsJson from '../deployments.json';
import { ASSET_KEYS, type NetworkName } from './feeds';

export type { NetworkName };
export const NETWORK_NAMES: readonly NetworkName[] = ['testnet', 'mainnet'];

export interface NetworkInfo {
  readonly name: NetworkName;
  readonly label: string;
  readonly rpcUrl: string;
  readonly passphrase: string;
  /** stellar.expert network segment. */
  readonly explorer: 'testnet' | 'public';
  /** Chainlink Data Feeds proxy. One per network, every feed behind it. */
  readonly proxy: string;
  /** Chainlink Data Streams verifier. */
  readonly verifier: string;
}

export const NETWORKS: Readonly<Record<NetworkName, NetworkInfo>> = {
  testnet: {
    name: 'testnet',
    label: 'Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    explorer: 'testnet',
    proxy: 'CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4',
    verifier: 'CA7GVHWH4GRHE6GI7MHEKQZAOYO4GE7KRGSU3EOS3HYJRVLX3XEA4ONQ',
  },
  mainnet: {
    name: 'mainnet',
    label: 'Mainnet',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    passphrase: 'Public Global Stellar Network ; September 2015',
    explorer: 'public',
    proxy: 'CDQBHEUGLDHMSUHG4IH33RJBUTMNCZOT4JIAQR4WZFRDZW6DR6S32ZLZ',
    verifier: 'CAKA3NBYPC6OBEUEGNIYGNYG3ES2GPQK736B5SR7ASGUXRDAKXI2JCQI',
  },
};

const EXPLORER = 'https://stellar.expert/explorer';

export const contractUrl = (net: NetworkInfo, id: string): string => `${EXPLORER}/${net.explorer}/contract/${id}`;
export const txUrl = (net: NetworkInfo, hash: string): string => `${EXPLORER}/${net.explorer}/tx/${hash}`;
export const accountUrl = (net: NetworkInfo, id: string): string => `${EXPLORER}/${net.explorer}/account/${id}`;

/** One entry of src/deployments.json. scripts/deploy.ts writes it. */
export interface Deployment {
  readonly twoClocks: string;
  /** Proxy and verifier the contract was constructed with. Null when the file does not say. */
  readonly proxy: string | null;
  readonly verifier: string | null;
  readonly maxPushAgeS: number | null;
  readonly maxPullAgeS: number | null;
  /** Asset keys the constructor received. Unknown keys are dropped. */
  readonly assets: readonly string[];
  readonly deployedAt: string | null;
  readonly deployTx: string | null;
  /** An account that exists on the network. It is the envelope source for simulation. */
  readonly reader: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const contractId = (v: unknown): string | null => {
  const s = str(v);
  return s && StrKey.isValidContract(s) ? s : null;
};
const positiveInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

function assetKeys(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const items: unknown[] = v;
  return items.filter((k): k is string => typeof k === 'string' && ASSET_KEYS.includes(k));
}

/** Accept an entry only when it names a valid contract id. Anything else counts as "not deployed". */
export function parseDeployment(raw: unknown): Deployment | null {
  if (!isRecord(raw)) return null;
  const twoClocks = contractId(raw.twoClocks);
  if (!twoClocks) return null;
  const reader = str(raw.reader);
  return {
    twoClocks,
    proxy: contractId(raw.proxy),
    verifier: contractId(raw.verifier),
    maxPushAgeS: positiveInt(raw.maxPushAgeS),
    maxPullAgeS: positiveInt(raw.maxPullAgeS),
    assets: assetKeys(raw.assets),
    deployedAt: str(raw.deployedAt),
    deployTx: str(raw.deployTx),
    reader: reader && StrKey.isValidEd25519PublicKey(reader) ? reader : null,
  };
}

// The file is {} before the first deploy, so its static type says nothing about the keys.
const raw: Record<string, unknown> = isRecord(deploymentsJson) ? deploymentsJson : {};

/** Deployments known at build time. A network without one renders a "no deployment yet" state. */
export const DEPLOYMENTS: Readonly<Record<NetworkName, Deployment | null>> = {
  testnet: parseDeployment(raw.testnet),
  mainnet: parseDeployment(raw.mainnet),
};

/** The page opens on testnet: that is where the contract lives. */
export const DEFAULT_NETWORK: NetworkName = 'testnet';
