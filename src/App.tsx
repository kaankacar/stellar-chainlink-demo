import { useMemo, useState } from 'react';
import { Board } from './components/Board';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { HowItWorks } from './components/HowItWorks';
import { VerifyBox } from './components/VerifyBox';
import { useClocksBoard, useProxyBoard } from './lib/hooks';
import { DEFAULT_NETWORK, DEPLOYMENTS, type NetworkName } from './lib/networks';

export default function App() {
  const [network, setNetwork] = useState<NetworkName>(DEFAULT_NETWORK);
  const deployment = DEPLOYMENTS[network];
  const clocks = useClocksBoard(network, deployment);
  // Mainnet has no contract: read the proxy directly.
  const proxy = useProxyBoard(network, deployment === null && network === 'mainnet');

  // The push price per asset, for the would-be spread in the verify box.
  const pushPrices = useMemo(() => {
    const out = new Map<string, bigint>();
    for (const row of clocks.snapshot?.rows ?? []) if (row.pair.push) out.set(row.asset.key, row.pair.push.answer);
    for (const row of proxy.snapshot?.rows ?? []) if (row.round) out.set(row.asset.key, row.round.answer);
    return out;
  }, [clocks.snapshot, proxy.snapshot]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <Header
        network={network}
        onNetworkChange={setNetwork}
        deployment={deployment}
        config={clocks.snapshot?.config ?? null}
      />
      <main className="mt-8 space-y-6">
        <Board network={network} deployment={deployment} clocks={clocks} proxy={proxy} />
        {/* Keyed by network so a result never shows under the other network. */}
        <VerifyBox key={network} network={network} deployment={deployment} pushPrices={pushPrices} />
        <HowItWorks network={network} />
      </main>
      <Footer />
    </div>
  );
}
