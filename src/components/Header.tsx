import type { ClocksConfig } from '../lib/contract';
import { formatSeconds, shortId } from '../lib/format';
import { contractUrl, NETWORK_NAMES, NETWORKS, txUrl, type Deployment, type NetworkName } from '../lib/networks';
import { Ext, Mono } from './ui';

export function NetworkToggle({ network, onChange }: { network: NetworkName; onChange: (n: NetworkName) => void }) {
  return (
    <div role="radiogroup" aria-label="Network" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {NETWORK_NAMES.map((n) => {
        const active = n === network;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(n)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${active ? 'bg-ink text-bg' : 'text-muted hover:text-ink'}`}
          >
            {NETWORKS[n].label}
          </button>
        );
      })}
    </div>
  );
}

interface Props {
  network: NetworkName;
  onNetworkChange: (n: NetworkName) => void;
  deployment: Deployment | null;
  config: ClocksConfig | null;
}

export function Header({ network, onNetworkChange, deployment, config }: Props) {
  const net = NETWORKS[network];
  const pushAge = config ? Number(config.maxPushAgeS) : deployment?.maxPushAgeS;
  const pullAge = config ? Number(config.maxPullAgeS) : deployment?.maxPullAgeS;
  return (
    <header className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Two Clocks: Chainlink push and pull prices on Stellar
          </h1>
          <p className="mt-2 text-muted">
            One Soroban contract keeps two prices per asset. The push price is read from the Chainlink Data Feeds
            proxy. The pull price comes from a Chainlink Data Streams report that the Chainlink verifier checked. This
            page reads everything by simulation. Nothing here signs or submits.
          </p>
        </div>
        <NetworkToggle network={network} onChange={onNetworkChange} />
      </div>
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Two Clocks</dt>
        <dd>
          {deployment ? (
            <Ext href={contractUrl(net, deployment.twoClocks)}>
              <Mono>{deployment.twoClocks}</Mono>
            </Ext>
          ) : (
            <span className="text-muted">
              {network === 'mainnet'
                ? 'no deployment, mainnet is read-only: the board reads the proxy directly'
                : `no deployment on ${net.label} yet`}
            </span>
          )}
        </dd>
        <dt className="text-muted">Data Feeds proxy</dt>
        <dd>
          <Ext href={contractUrl(net, net.proxy)}>
            <Mono>{net.proxy}</Mono>
          </Ext>
        </dd>
        <dt className="text-muted">Data Streams verifier</dt>
        <dd>
          <Ext href={contractUrl(net, net.verifier)}>
            <Mono>{net.verifier}</Mono>
          </Ext>
        </dd>
        {deployment?.deployTx && (
          <>
            <dt className="text-muted">Deployed</dt>
            <dd>
              {deployment.deployedAt ? <Mono>{deployment.deployedAt}</Mono> : null}{' '}
              <Ext href={txUrl(net, deployment.deployTx)}>tx {shortId(deployment.deployTx, 6)}</Ext>
            </dd>
          </>
        )}
        {pushAge !== undefined && pushAge !== null && (
          <>
            <dt className="text-muted">Max push age</dt>
            <dd>
              {formatSeconds(pushAge)} (<Mono>max_push_age_s = {pushAge}</Mono>)
            </dd>
          </>
        )}
        {pullAge !== undefined && pullAge !== null && (
          <>
            <dt className="text-muted">Max pull age</dt>
            <dd>
              {formatSeconds(pullAge)} (<Mono>max_pull_age_s = {pullAge}</Mono>)
            </dd>
          </>
        )}
      </dl>
    </header>
  );
}
