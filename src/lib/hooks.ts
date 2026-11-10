import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  errorMessage,
  readAssets,
  readConfig,
  readLatestMany,
  simulateProxyLatestRound,
  type AssetView,
  type ClocksConfig,
  type Pair,
  type Round,
} from './contract';
import { ASSETS, type Asset } from './feeds';
import { NETWORKS, type Deployment, type NetworkName } from './networks';

/** Board refresh period. */
export const REFRESH_MS = 10_000;

interface Polled<T> {
  /** Last good read for the selected network. */
  snapshot: T | null;
  /** Last failed read for the selected network. */
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Run `load` now and every REFRESH_MS while the tab is visible. Results are keyed by network. */
function usePolled<T>(network: NetworkName, enabled: boolean, load: (network: NetworkName) => Promise<T>): Polled<T> {
  const [snapshot, setSnapshot] = useState<{ network: NetworkName; value: T } | null>(null);
  const [failure, setFailure] = useState<{ network: NetworkName; message: string } | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const run = async () => {
      try {
        const value = await load(network);
        if (!alive) return;
        setSnapshot({ network, value });
        setFailure(null);
      } catch (err) {
        if (!alive) return;
        setFailure({ network, message: errorMessage(err) });
      }
    };
    void run();
    const timer = window.setInterval(() => {
      if (!document.hidden) void run();
    }, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [network, enabled, load, round]);

  const refresh = useCallback(() => setRound((r) => r + 1), []);
  const current = snapshot?.network === network ? snapshot.value : null;
  const error = failure?.network === network ? failure.message : null;
  return { snapshot: current, error, loading: enabled && current === null && error === null, refresh };
}

// ---- Two Clocks board -------------------------------------------------------

export interface ClocksRow {
  asset: Asset;
  /** The contract's view of the asset. Null when the constructor did not get it. */
  view: AssetView | null;
  pair: Pair;
}

export interface ClocksSnapshot {
  network: NetworkName;
  config: ClocksConfig;
  rows: ClocksRow[];
  latestLedger: number;
  /** Browser clock, milliseconds. */
  fetchedAt: number;
  restoreNeeded: boolean;
}

export type ClocksState = Polled<ClocksSnapshot>;

async function loadClocks(network: NetworkName, dep: Deployment): Promise<ClocksSnapshot> {
  const net = NETWORKS[network];
  const ids = ASSETS.map((a) => a.dataId);
  const [cfg, views, pairs] = await Promise.all([readConfig(net, dep), readAssets(net, dep), readLatestMany(net, dep, ids)]);
  const byId = new Map(views.value.map((v) => [v.dataId, v]));
  return {
    network,
    config: cfg.value,
    rows: ASSETS.map((asset, i) => ({
      asset,
      view: byId.get(asset.dataId) ?? null,
      pair: pairs.value[i] ?? { push: null, pull: null },
    })),
    latestLedger: Math.max(cfg.latestLedger, views.latestLedger, pairs.latestLedger),
    fetchedAt: Date.now(),
    restoreNeeded: cfg.restoreNeeded || views.restoreNeeded || pairs.restoreNeeded,
  };
}

/** config, assets and latest_many by simulation, every REFRESH_MS. Idle without a deployment. */
export function useClocksBoard(network: NetworkName, deployment: Deployment | null): ClocksState {
  const load = useCallback(
    (n: NetworkName) => {
      if (!deployment) return Promise.reject(new Error('no deployment'));
      return loadClocks(n, deployment);
    },
    [deployment],
  );
  return usePolled(network, deployment !== null, load);
}

// ---- Proxy board (mainnet toggle) -------------------------------------------

export interface ProxyRow {
  asset: Asset;
  round: Round | null;
  /** Why this feed has no round, when the proxy answered with an error. */
  error: string | null;
}

export interface ProxySnapshot {
  network: NetworkName;
  rows: ProxyRow[];
  latestLedger: number;
  fetchedAt: number;
}

export type ProxyState = Polled<ProxySnapshot>;

async function loadProxy(network: NetworkName): Promise<ProxySnapshot> {
  const net = NETWORKS[network];
  const results = await Promise.allSettled(ASSETS.map((a) => simulateProxyLatestRound(net, a.dataId)));
  let latestLedger = 0;
  const rows: ProxyRow[] = ASSETS.map((asset, i) => {
    const r = results[i];
    if (r?.status === 'fulfilled') {
      latestLedger = Math.max(latestLedger, r.value.latestLedger);
      return { asset, round: r.value.value, error: null };
    }
    return { asset, round: null, error: r ? errorMessage(r.reason) : 'no result' };
  });
  if (rows.every((r) => r.round === null)) throw new Error(rows[0]?.error ?? 'every proxy read failed');
  return { network, rows, latestLedger, fetchedAt: Date.now() };
}

/** latest_round(id, 18) on the proxy for all ten assets, by simulation, every REFRESH_MS. */
export function useProxyBoard(network: NetworkName, enabled: boolean): ProxyState {
  return usePolled(network, enabled, loadProxy);
}

// ---- Clock ------------------------------------------------------------------

/* One shared one-second ticker for every live age on the page. */
let nowMs = Date.now();
let ticker: number | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (ticker === null) {
    nowMs = Date.now();
    ticker = window.setInterval(() => {
      nowMs = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  };
}

const getNow = (): number => nowMs;

/** The browser clock, ticking once a second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}
