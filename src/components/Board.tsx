import type { ReactNode } from 'react';
import { spreadBps, type PullLeg, type PushLeg, type Round } from '../lib/contract';
import { HEARTBEAT_S, shortDataId, type Asset } from '../lib/feeds';
import { bpsToPercent, formatAge, formatBps, formatE18Price, formatSeconds, groupThousands, isoFromSeconds } from '../lib/format';
import { REFRESH_MS, useNow, type ClocksRow, type ClocksState, type ProxyRow, type ProxyState } from '../lib/hooks';
import { NETWORKS, type Deployment, type NetworkName } from '../lib/networks';
import { BUTTON, Card, Mono, Notice, Pill, type Tone } from './ui';

/** The deploy default. The mainnet board has no contract, so it borrows this number for its pills. */
export const DEFAULT_MAX_PUSH_AGE_S = 90_000;

interface Props {
  network: NetworkName;
  deployment: Deployment | null;
  clocks: ClocksState;
  proxy: ProxyState;
}

export function Board({ network, deployment, clocks, proxy }: Props) {
  const now = useNow();
  if (deployment) return <ClocksBoard network={network} state={clocks} now={now} />;
  if (network === 'mainnet') return <ProxyBoard network={network} state={proxy} now={now} />;
  return <NoDeployment network={network} />;
}

// ---- Two Clocks board -------------------------------------------------------

function ClocksBoard({ network, state, now }: { network: NetworkName; state: ClocksState; now: number }) {
  const snap = state.snapshot;
  return (
    <Card title="Board" aside={<RefreshButton onClick={state.refresh} />}>
      {snap && (
        <p className="mb-3 text-sm text-muted">
          Ledger <Mono>{groupThousands(String(snap.latestLedger))}</Mono> · read {formatAge(now - snap.fetchedAt)} ago
          · refreshes every {REFRESH_MS / 1000} s · <Mono>latest_many</Mono> by simulation · max push age{' '}
          {formatSeconds(snap.config.maxPushAgeS)} · max pull age {formatSeconds(snap.config.maxPullAgeS)}
        </p>
      )}
      {state.error && (
        <Notice tone="bad">
          Read failed: {state.error}
          {snap ? ' Showing the last good read.' : ''}
        </Notice>
      )}
      {snap?.restoreNeeded && (
        <Notice tone="warn">
          A ledger entry this read touches has expired. A RestoreFootprint operation must bring it back before the
          next refresh can write.
        </Notice>
      )}
      {state.loading && <p className="text-sm text-muted">Reading the contract by simulation...</p>}
      {snap && (
        <Rows>
          {snap.rows.map((row) => (
            <ClocksRowView
              key={row.asset.key}
              row={row}
              network={network}
              now={now}
              maxPushAgeS={Number(snap.config.maxPushAgeS)}
              maxPullAgeS={Number(snap.config.maxPullAgeS)}
            />
          ))}
        </Rows>
      )}
    </Card>
  );
}

function ClocksRowView({
  row,
  network,
  now,
  maxPushAgeS,
  maxPullAgeS,
}: {
  row: ClocksRow;
  network: NetworkName;
  now: number;
  maxPushAgeS: number;
  maxPullAgeS: number;
}) {
  const { asset, view, pair } = row;
  const bps = spreadBps(pair.push?.answer ?? null, pair.pull?.price ?? null);
  return (
    <Row>
      <AssetCell asset={asset} note={view ? null : 'not configured in the contract'} />
      <Cell label="Push">
        {pair.push ? (
          <PushBlock leg={pair.push} network={network} now={now} maxPushAgeS={maxPushAgeS} />
        ) : (
          <Empty pill="none">{view ? 'no round stored yet: run refresh' : 'not in the contract'}</Empty>
        )}
      </Cell>
      <Cell label="Pull">
        {!asset.streamIds[network] ? (
          <Empty pill="no stream">no stream on this network</Empty>
        ) : pair.pull ? (
          <PullBlock leg={pair.pull} now={now} maxPullAgeS={maxPullAgeS} />
        ) : (
          <Empty pill="none">no accepted report yet: the only public sample expired 2026-05-03</Empty>
        )}
      </Cell>
      <Cell label="Spread">
        {bps === null ? (
          <span className="text-sm text-muted">needs both legs</span>
        ) : (
          <div className="font-mono text-sm tabular-nums">
            {formatBps(bps)}
            <div className="text-xs text-muted">{bpsToPercent(bps)} pull over push</div>
          </div>
        )}
      </Cell>
    </Row>
  );
}

// ---- Proxy board (mainnet) --------------------------------------------------

function ProxyBoard({ network, state, now }: { network: NetworkName; state: ProxyState; now: number }) {
  const snap = state.snapshot;
  const net = NETWORKS[network];
  return (
    <Card title="Board" aside={<RefreshButton onClick={state.refresh} />}>
      <p className="mb-3 text-sm text-muted">
        No contract on {net.label}. The page calls <Mono>latest_round(data_id, 18)</Mono> on the proxy for all ten
        feeds by simulation
        {snap && (
          <>
            {' '}
            · ledger <Mono>{groupThousands(String(snap.latestLedger))}</Mono> · read {formatAge(now - snap.fetchedAt)}{' '}
            ago
          </>
        )}{' '}
        · refreshes every {REFRESH_MS / 1000} s · pills use the deploy default max push age of{' '}
        {formatSeconds(DEFAULT_MAX_PUSH_AGE_S)}.
      </p>
      {state.error && (
        <Notice tone="bad">
          Read failed: {state.error}
          {snap ? ' Showing the last good read.' : ''}
        </Notice>
      )}
      {state.loading && <p className="text-sm text-muted">Reading the proxy by simulation...</p>}
      {snap && (
        <Rows>
          {snap.rows.map((row) => (
            <ProxyRowView key={row.asset.key} row={row} network={network} now={now} />
          ))}
        </Rows>
      )}
    </Card>
  );
}

function ProxyRowView({ row, network, now }: { row: ProxyRow; network: NetworkName; now: number }) {
  const { asset, round, error } = row;
  return (
    <Row>
      <AssetCell asset={asset} note={null} />
      <Cell label="Push">
        {round ? (
          <PushBlock leg={round} network={network} now={now} maxPushAgeS={DEFAULT_MAX_PUSH_AGE_S} />
        ) : (
          <Empty pill="error" tone="bad">
            {error ?? 'no answer'}
          </Empty>
        )}
      </Cell>
      <Cell label="Pull">
        <Empty pill="testnet only">the contract and its pull leg live on testnet</Empty>
      </Cell>
      <Cell label="Spread">
        <span className="text-sm text-muted">needs both legs</span>
      </Cell>
    </Row>
  );
}

// ---- Cells ------------------------------------------------------------------

/** A push leg from the contract or a round from the proxy: the same three numbers. */
type PushLike = Pick<PushLeg, 'answer' | 'roundId' | 'timestamp'> & Partial<Pick<PushLeg, 'storedAt'>>;

/** fresh until the heartbeat passes, due until max_push_age_s passes, stale after that. */
function pushTone(ageS: number, maxPushAgeS: number, heartbeatS: number): { tone: Tone; label: string } {
  if (ageS > maxPushAgeS) return { tone: 'bad', label: 'stale' };
  if (ageS > heartbeatS) return { tone: 'warn', label: 'due' };
  return { tone: 'ok', label: 'fresh' };
}

function PushBlock({
  leg,
  network,
  now,
  maxPushAgeS,
}: {
  leg: PushLike | Round;
  network: NetworkName;
  now: number;
  maxPushAgeS: number;
}) {
  const heartbeatS = HEARTBEAT_S[network];
  const ageS = Math.floor(now / 1000) - Number(leg.timestamp);
  const { tone, label } = pushTone(ageS, maxPushAgeS, heartbeatS);
  const untilHeartbeat = heartbeatS - ageS;
  const storedAt = 'storedAt' in leg ? leg.storedAt : undefined;
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-base tabular-nums">{formatE18Price(leg.answer)}</span>
        <Pill tone={tone}>{label}</Pill>
      </div>
      <div className="mt-1 text-xs text-muted">
        round {leg.roundId.toString()} · feed time {isoFromSeconds(leg.timestamp)} · age {formatAge(ageS * 1000)}
      </div>
      <div className="text-xs text-muted">
        {untilHeartbeat >= 0
          ? `next heartbeat in ${formatAge(untilHeartbeat * 1000)}`
          : `heartbeat overdue by ${formatAge(-untilHeartbeat * 1000)}`}
        {storedAt !== undefined ? ` · stored ${isoFromSeconds(storedAt)}` : ''}
      </div>
    </div>
  );
}

/** expired past expiresAt, stale past max_pull_age_s, fresh otherwise. */
function pullTone(leg: Pick<PullLeg, 'observationsTs' | 'expiresAt'>, nowS: number, maxPullAgeS: number): { tone: Tone; label: string } {
  if (Number(leg.expiresAt) <= nowS) return { tone: 'bad', label: 'expired' };
  if (nowS - Number(leg.observationsTs) > maxPullAgeS) return { tone: 'warn', label: 'stale' };
  return { tone: 'ok', label: 'fresh' };
}

function PullBlock({ leg, now, maxPullAgeS }: { leg: PullLeg; now: number; maxPullAgeS: number }) {
  const nowS = Math.floor(now / 1000);
  const { tone, label } = pullTone(leg, nowS, maxPullAgeS);
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-base tabular-nums">{formatE18Price(leg.price)}</span>
        <Pill tone={tone}>{label}</Pill>
      </div>
      <div className="mt-1 font-mono text-xs tabular-nums text-muted">
        bid {formatE18Price(leg.bid)} · ask {formatE18Price(leg.ask)}
      </div>
      <div className="text-xs text-muted">
        observed {isoFromSeconds(leg.observationsTs)} · age {formatAge((nowS - Number(leg.observationsTs)) * 1000)}
      </div>
      <div className="text-xs text-muted">
        expires {isoFromSeconds(leg.expiresAt)} · stored {isoFromSeconds(leg.storedAt)}
      </div>
    </div>
  );
}

function AssetCell({ asset, note }: { asset: Asset; note: string | null }) {
  return (
    <div>
      <div className="font-medium">{asset.label}</div>
      <div className="text-xs text-muted">
        {asset.assetName} · {asset.category} · deviation {asset.deviationBps / 100}%
      </div>
      <div className="text-xs text-muted">
        id <Mono>{shortDataId(asset.dataId)}</Mono>
      </div>
      {note && (
        <div className="mt-1">
          <Pill tone="muted">{note}</Pill>
        </div>
      )}
    </div>
  );
}

function Empty({ pill, tone = 'muted', children }: { pill: string; tone?: Tone; children: ReactNode }) {
  return (
    <div className="text-sm">
      <Pill tone={tone}>{pill}</Pill>
      <div className="mt-1 text-xs text-muted">{children}</div>
    </div>
  );
}

const COLS = 'md:grid-cols-[minmax(9rem,1fr)_minmax(0,1.7fr)_minmax(0,1.7fr)_minmax(6rem,0.7fr)]';

function Rows({ children }: { children: ReactNode }) {
  return (
    <div>
      <div className={`hidden gap-x-4 pb-2 text-xs uppercase tracking-wide text-muted md:grid ${COLS}`}>
        <div>Asset</div>
        <div>Push: Data Feeds proxy</div>
        <div>Pull: Data Streams report</div>
        <div>Spread</div>
      </div>
      {children}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className={`grid gap-x-4 gap-y-2 border-t border-line py-3 ${COLS}`}>{children}</div>;
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wide text-muted md:hidden">{label}</div>
      {children}
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={BUTTON}>
      Refresh
    </button>
  );
}

/* Testnet before the first deploy: the steps that fill src/deployments.json. */
function NoDeployment({ network }: { network: NetworkName }) {
  const net = NETWORKS[network];
  return (
    <Card title="Board">
      <p>No Two Clocks deployment on {net.label} yet.</p>
      <p className="mt-2 text-sm text-muted">
        Build and deploy the contract, then refresh the push legs once. <Mono>scripts/deploy.ts</Mono> writes the
        contract id to <Mono>src/deployments.json</Mono>, and this page picks it up at the next build. The verify box
        below already works: without a contract it calls the Chainlink verifier directly.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-code p-3 font-mono text-xs leading-relaxed">
        {`pnpm build:wasm\npnpm run deploy -- --network ${network}\npnpm refresh -- --network ${network}\npnpm build`}
      </pre>
    </Card>
  );
}
