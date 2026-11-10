// The ten Chainlink Data Feeds on Stellar and the Data Streams ids that pair with them.
// Sources, read on 10 November 2026: docs.chain.link/files/json/feeds-stellar-{testnet,mainnet}.json
// (the data id sits in the `proxyAddress` field) and the keyless /api/v1/discovery catalog of each
// Data Streams environment (schema V3, name `<BASE>/USD-Streams-CexPrice`).

export type NetworkName = 'testnet' | 'mainnet';
export type AssetCategory = 'crypto' | 'stablecoin' | 'commodity' | 'rwa' | 'nav';

export interface Asset {
  /** Short key used on the command line and in deployments.json. */
  readonly key: string;
  /** Chainlink's feed name. */
  readonly label: string;
  /** Chainlink's asset name, verbatim. FLHY is labelled "Flare" by Chainlink; it is a tokenized bond ETF. */
  readonly assetName: string;
  /** 32-byte data id as 64 lower-case hex characters, no 0x. Same on both networks. */
  readonly dataId: string;
  readonly category: AssetCategory;
  /** Deviation trigger in basis points. */
  readonly deviationBps: number;
  /** Data Streams V3 stream ids, 0x-prefixed, where a stream exists. */
  readonly streamIds: { readonly testnet?: string; readonly mainnet?: string };
}

const ZEROS = '0'.repeat(48);
const dataId = (prefix: string): string => prefix + ZEROS;

/** Heartbeat in seconds. Chainlink's JSON says 86355 on testnet and 86400 on mainnet. */
export const HEARTBEAT_S: Readonly<Record<NetworkName, number>> = { testnet: 86355, mainnet: 86400 };

/** Every feed stores 18 decimals. */
export const FEED_DECIMALS = 18;

export const ASSETS: readonly Asset[] = [
  {
    key: 'xlm',
    label: 'XLM / USD',
    assetName: 'Stellar',
    dataId: dataId('017be2f55a000332'),
    category: 'crypto',
    deviationBps: 50,
    streamIds: {
      testnet: '0x00037dfe3b67b7552cf15e10ee5fb0c0ab6d658b20eb558effe2ae4579d24c58',
      mainnet: '0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a',
    },
  },
  {
    key: 'btc',
    label: 'BTC / USD',
    assetName: 'Bitcoin',
    dataId: dataId('01a0b4d920000332'),
    category: 'crypto',
    deviationBps: 50,
    streamIds: {
      testnet: '0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439',
      mainnet: '0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8',
    },
  },
  {
    key: 'eth',
    label: 'ETH / USD',
    assetName: 'Ethereum',
    dataId: dataId('01d585327c000332'),
    category: 'crypto',
    deviationBps: 50,
    streamIds: {
      testnet: '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782',
      mainnet: '0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9',
    },
  },
  {
    key: 'link',
    label: 'LINK / USD',
    assetName: 'Chainlink',
    dataId: dataId('0101199b3b000332'),
    category: 'crypto',
    deviationBps: 50,
    streamIds: {
      testnet: '0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265',
      mainnet: '0x00036d7a1251e3f67d6658466b5e9e7fe8418af7feac9567ff322bff95cc2401',
    },
  },
  {
    key: 'usdt',
    label: 'USDT / USD',
    assetName: 'Tether',
    dataId: dataId('016d06ebb6000332'),
    category: 'stablecoin',
    deviationBps: 50,
    streamIds: {
      testnet: '0x00032874077216155926e26c159c1c20a572921371d9de605fe9633e48d136f9',
      mainnet: '0x0003a910a43485e0685ff5d6d366541f5c21150f0634c5b14254392d1a1c06db',
    },
  },
  {
    key: 'usdc',
    label: 'USDC / USD',
    assetName: 'USD Coin',
    dataId: dataId('01a80ff216000332'),
    category: 'stablecoin',
    deviationBps: 50,
    streamIds: {
      testnet: '0x0003dc85e8b01946bf9dfd8b0db860129181eb6105a8c8981d9f28e00b6f60d9',
      mainnet: '0x00038f83323b6b08116d1614cf33a9bd71ab5e0abf0c9f1b783a74a43e7bd992',
    },
  },
  {
    key: 'eurc',
    label: 'EURC / USD',
    assetName: 'EURC',
    dataId: dataId('01962615c3000332'),
    category: 'stablecoin',
    deviationBps: 50,
    streamIds: {},
  },
  {
    key: 'xaum',
    label: 'XAUM Reference Rate',
    assetName: 'Gold',
    dataId: dataId('0197aabf9c000332'),
    category: 'commodity',
    deviationBps: 10,
    streamIds: {},
  },
  {
    key: 'flhy',
    label: 'FLHY / USD',
    assetName: 'Flare',
    dataId: dataId('0142ac24bc000332'),
    category: 'rwa',
    deviationBps: 50,
    streamIds: {},
  },
  {
    key: 'uspc',
    label: 'USPC NAV',
    assetName: 'Coinshift USPC NAV',
    dataId: dataId('016e06407e000332'),
    category: 'nav',
    deviationBps: 50,
    streamIds: {},
  },
];

export const ASSET_KEYS: readonly string[] = ASSETS.map((a) => a.key);

export function assetByKey(key: string): Asset | undefined {
  return ASSETS.find((a) => a.key === key.toLowerCase());
}

/** Accepts 64 hex characters with or without a 0x prefix, any case. */
export function assetByDataId(id: string): Asset | undefined {
  const norm = id.toLowerCase().replace(/^0x/, '');
  return ASSETS.find((a) => a.dataId === norm);
}

export function assetByStreamId(net: NetworkName, streamId: string): Asset | undefined {
  const norm = streamId.toLowerCase();
  return ASSETS.find((a) => a.streamIds[net]?.toLowerCase() === norm);
}

/** "all" or a comma list of keys. Unknown keys throw. */
export function parseAssetKeys(csv: string): Asset[] {
  const trimmed = csv.trim().toLowerCase();
  if (trimmed === '' || trimmed === 'all') return [...ASSETS];
  return trimmed.split(',').map((part) => {
    const asset = assetByKey(part.trim());
    if (!asset) throw new Error(`unknown asset "${part.trim()}"; known keys: ${ASSET_KEYS.join(', ')}`);
    return asset;
  });
}

export function shortDataId(dataId: string): string {
  return `${dataId.slice(0, 10)}…${dataId.slice(-4)}`;
}
