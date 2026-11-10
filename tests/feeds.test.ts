// The feed table from SPEC.md: ten assets, 64-hex ids, stream ids, and the lookup helpers.
import { describe, expect, it } from 'vitest';
import {
  ASSETS,
  ASSET_KEYS,
  FEED_DECIMALS,
  HEARTBEAT_S,
  assetByDataId,
  assetByKey,
  assetByStreamId,
  parseAssetKeys,
  shortDataId,
} from '../src/lib/feeds.ts';

const SAMPLE_STREAM = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';

describe('ASSETS', () => {
  it('lists the ten feeds in SPEC order', () => {
    expect(ASSET_KEYS).toEqual(['xlm', 'btc', 'eth', 'link', 'usdt', 'usdc', 'eurc', 'xaum', 'flhy', 'uspc']);
    expect(ASSETS.map((a) => a.label)).toEqual([
      'XLM / USD',
      'BTC / USD',
      'ETH / USD',
      'LINK / USD',
      'USDT / USD',
      'USDC / USD',
      'EURC / USD',
      'XAUM Reference Rate',
      'FLHY / USD',
      'USPC NAV',
    ]);
  });

  it('has a distinct 64-hex data id per feed: 16 significant characters then 48 zeros', () => {
    for (const asset of ASSETS) {
      expect(asset.dataId).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.dataId.slice(16)).toBe('0'.repeat(48));
      expect(asset.dataId.slice(10, 16)).toBe('000332');
    }
    expect(new Set(ASSETS.map((a) => a.dataId)).size).toBe(10);
    expect(assetByKey('xlm')?.dataId).toBe(`017be2f55a000332${'0'.repeat(48)}`);
    expect(assetByKey('btc')?.dataId).toBe(`01a0b4d920000332${'0'.repeat(48)}`);
  });

  it('knows the heartbeats, the decimals and the deviations', () => {
    expect(HEARTBEAT_S).toEqual({ testnet: 86355, mainnet: 86400 });
    expect(FEED_DECIMALS).toBe(18);
    expect(assetByKey('xaum')?.deviationBps).toBe(10);
    for (const asset of ASSETS) if (asset.key !== 'xaum') expect(asset.deviationBps).toBe(50);
  });

  it('has a v3 stream on both networks for six assets and none for four', () => {
    const both = ASSETS.filter((a) => a.streamIds.testnet && a.streamIds.mainnet).map((a) => a.key);
    expect(both).toEqual(['xlm', 'btc', 'eth', 'link', 'usdt', 'usdc']);
    const none = ASSETS.filter((a) => !a.streamIds.testnet && !a.streamIds.mainnet).map((a) => a.key);
    expect(none).toEqual(['eurc', 'xaum', 'flhy', 'uspc']);
    for (const asset of ASSETS) {
      for (const id of Object.values(asset.streamIds)) expect(id).toMatch(/^0x0003[0-9a-f]{60}$/);
      if (asset.streamIds.testnet) expect(asset.streamIds.testnet).not.toBe(asset.streamIds.mainnet);
    }
    expect(assetByKey('eth')?.streamIds.testnet).toBe(SAMPLE_STREAM);
  });
});

describe('lookups', () => {
  it('assetByKey ignores case and returns undefined for an unknown key', () => {
    expect(assetByKey('XLM')?.key).toBe('xlm');
    expect(assetByKey('doge')).toBeUndefined();
  });

  it('assetByDataId accepts 0x and upper case', () => {
    const xlm = assetByKey('xlm');
    expect(xlm).toBeDefined();
    if (!xlm) return;
    expect(assetByDataId(xlm.dataId)?.key).toBe('xlm');
    expect(assetByDataId(`0x${xlm.dataId.toUpperCase()}`)?.key).toBe('xlm');
    expect(assetByDataId('ff'.repeat(32))).toBeUndefined();
  });

  it('assetByStreamId finds the sample stream on testnet only', () => {
    expect(assetByStreamId('testnet', SAMPLE_STREAM)?.key).toBe('eth');
    expect(assetByStreamId('mainnet', SAMPLE_STREAM)).toBeUndefined();
    expect(assetByStreamId('testnet', SAMPLE_STREAM.toUpperCase().replace('0X', '0x'))?.key).toBe('eth');
    expect(assetByStreamId('mainnet', '0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a')?.key).toBe('xlm');
    expect(assetByStreamId('testnet', '0x00037dfe3b67b7552cf15e10ee5fb0c0ab6d658b20eb558effe2ae4579d24c58')?.key).toBe('xlm');
  });

  it('shortDataId keeps the head and the tail', () => {
    const xlm = assetByKey('xlm');
    expect(xlm && shortDataId(xlm.dataId)).toBe('017be2f55a…0000');
  });
});

describe('parseAssetKeys', () => {
  it('"all" and an empty string give every asset in order', () => {
    expect(parseAssetKeys('all').map((a) => a.key)).toEqual(ASSET_KEYS);
    expect(parseAssetKeys('').map((a) => a.key)).toEqual(ASSET_KEYS);
    expect(parseAssetKeys(' ALL ').map((a) => a.key)).toEqual(ASSET_KEYS);
  });

  it('parses a csv with spaces and mixed case, keeping the order given', () => {
    expect(parseAssetKeys(' ETH, xlm ').map((a) => a.key)).toEqual(['eth', 'xlm']);
  });

  it('throws on an unknown key and names the known ones', () => {
    expect(() => parseAssetKeys('xlm,doge')).toThrow(/unknown asset "doge"/);
    expect(() => parseAssetKeys('doge')).toThrow(/xlm, btc, eth/);
  });
});
