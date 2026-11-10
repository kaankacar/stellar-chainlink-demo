import { useMemo, useState } from 'react';
import { ContractError, simulateVerifierRaw, simulateVerifyReport, spreadBps, type ReportV3Native } from '../lib/contract';
import { assetByStreamId, type Asset } from '../lib/feeds';
import { bpsToPercent, daysBetween, formatBps, formatE18Price, formatSeconds, isoFromSeconds } from '../lib/format';
import { useNow } from '../lib/hooks';
import { NETWORKS, type Deployment, type NetworkName } from '../lib/networks';
import { bytesToHex, decodeReportV3, decodeSignedReport, flipBit, hexToBytes, type ReportV3 } from '../lib/report';
import { SAMPLE_REPORT_HEX, SAMPLE_TAMPER_BYTE } from '../sample';
import { BUTTON, Card, Mono, Notice, Pill } from './ui';

interface Props {
  network: NetworkName;
  deployment: Deployment | null;
  /** Current push price per asset key, from whichever board is showing. */
  pushPrices: ReadonlyMap<string, bigint>;
}

/** The fields both paths produce: the contract's ReportV3 and the local decode of the verifier's bytes. */
type Fields = Pick<ReportV3, 'streamId' | 'validFrom' | 'observationsTs' | 'expiresAt' | 'price' | 'bid' | 'ask'>;

type Via = 'contract' | 'verifier';

type Outcome =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; via: Via; fields: Fields; ledger: number; bytes: number }
  | { kind: 'error'; via: Via; message: string; code: number | null; detail: string | null; tampered: boolean };

const fromNative = (r: ReportV3Native): Fields => ({
  streamId: r.streamId,
  validFrom: Number(r.validFrom),
  observationsTs: Number(r.observationsTs),
  expiresAt: Number(r.expiresAt),
  price: r.price,
  bid: r.bid,
  ask: r.ask,
});

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The sample carries the testnet ETH/USD stream id. Look it up on both networks so mainnet can name it too. */
const assetOfStream = (id: string): Asset | undefined => assetByStreamId('testnet', id) ?? assetByStreamId('mainnet', id);

export function VerifyBox({ network, deployment, pushPrices }: Props) {
  const [text, setText] = useState(SAMPLE_REPORT_HEX);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const now = useNow();
  const nowS = Math.floor(now / 1000);
  const net = NETWORKS[network];
  const via: Via = deployment ? 'contract' : 'verifier';

  const local = useMemo(() => {
    try {
      const { full, report } = decodeSignedReport(text);
      return { ok: true as const, full, report };
    } catch (err) {
      return { ok: false as const, message: describe(err) };
    }
  }, [text]);

  const run = (hex: string, tampered: boolean) => {
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(hex);
    } catch (err) {
      setOutcome({ kind: 'error', via, message: describe(err), code: null, detail: null, tampered });
      return;
    }
    setOutcome({ kind: 'busy' });
    const call = deployment
      ? simulateVerifyReport(net, deployment, bytes).then((r) => ({ fields: fromNative(r.value), ledger: r.latestLedger }))
      : simulateVerifierRaw(net, bytes).then((r) => ({ fields: decodeReportV3(r.value), ledger: r.latestLedger }));
    call
      .then(({ fields, ledger }) => setOutcome({ kind: 'ok', via, fields, ledger, bytes: bytes.length }))
      .catch((err: unknown) =>
        setOutcome({
          kind: 'error',
          via,
          message: describe(err),
          code: err instanceof ContractError ? err.code : null,
          detail: err instanceof ContractError ? err.explanation : null,
          tampered,
        }),
      );
  };

  const flip = () => {
    try {
      const hex = bytesToHex(flipBit(hexToBytes(text), SAMPLE_TAMPER_BYTE));
      setText(hex);
      run(hex, true);
    } catch (err) {
      setOutcome({ kind: 'error', via, message: describe(err), code: null, detail: null, tampered: true });
    }
  };

  const reset = () => {
    setText(SAMPLE_REPORT_HEX);
    setOutcome({ kind: 'idle' });
  };

  const busy = outcome.kind === 'busy';
  const isSample = text.trim().toLowerCase() === SAMPLE_REPORT_HEX.toLowerCase();

  return (
    <Card title="Verify a report">
      <p className="mb-3 text-sm text-muted">
        {via === 'contract' ? (
          <>
            <Mono>verify_report(signed_report)</Mono> on the Two Clocks contract hands the bytes to the Chainlink
            verifier, decodes the 288 bytes it returns and writes nothing. The box is prefilled with the one signed
            testnet report Chainlink publishes.
          </>
        ) : (
          <>
            No contract on {net.label}, so the box calls <Mono>verify(signed_report, sender)</Mono> on the Chainlink
            verifier directly, with the simulation source as sender.
            {network === 'mainnet'
              ? ' The sample was signed for the testnet DON config, so mainnet answers #9 DigestNotSet.'
              : ' Expect the 288 report bytes back.'}
          </>
        )}
      </p>
      <label className="block text-sm">
        <span className="text-muted">Signed report, hex</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={6}
          className="mt-1 block w-full resize-y rounded-md border border-line bg-bg p-2 font-mono text-xs leading-relaxed wrap-anywhere"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => run(text, false)} disabled={busy} className={BUTTON}>
          {busy ? 'Simulating...' : 'Verify by simulation'}
        </button>
        <button type="button" onClick={flip} disabled={busy} className={BUTTON}>
          Flip byte {SAMPLE_TAMPER_BYTE} and verify
        </button>
        <button type="button" onClick={reset} disabled={busy || (isSample && outcome.kind === 'idle')} className={BUTTON}>
          Reset to sample
        </button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-medium">Decoded in the browser</h3>
          {local.ok ? (
            <>
              <p className="mt-1 text-xs text-muted">
                {hexToBytes(text).length} bytes · reportData {local.full.reportData.length} bytes at offset{' '}
                {local.full.reportDataOffset} · {local.full.rs.length} signatures, so f = {local.full.rs.length - 1}
              </p>
              <FieldList fields={local.report} nowS={nowS} pushPrices={pushPrices} />
            </>
          ) : (
            <Notice tone="bad">Cannot decode: {local.message}</Notice>
          )}
        </div>
        <div>
          <h3 className="text-sm font-medium">
            {via === 'contract' ? 'Decoded by the contract, by simulation' : 'Returned by the verifier, by simulation'}
          </h3>
          {outcome.kind === 'idle' && <p className="mt-1 text-sm text-muted">Not run yet.</p>}
          {outcome.kind === 'busy' && <p className="mt-1 text-sm text-muted">Simulating...</p>}
          {outcome.kind === 'error' && <Failure outcome={outcome} network={network} />}
          {outcome.kind === 'ok' && (
            <>
              <p className="mt-1 text-xs text-muted">
                ledger {outcome.ledger} · {outcome.bytes} bytes in ·{' '}
                {local.ok && sameFields(outcome.fields, local.report) ? 'same fields as the browser decode' : 'differs from the browser decode'}
              </p>
              <FieldList fields={outcome.fields} nowS={nowS} pushPrices={pushPrices} />
              <Notice tone="warn">
                The verifier checked the signatures only. It does not look at expiresAt. <Mono>submit_report</Mono>{' '}
                would refuse this report with #23 Expired.
              </Notice>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

const sameFields = (a: Fields, b: Fields): boolean =>
  a.streamId === b.streamId &&
  a.validFrom === b.validFrom &&
  a.observationsTs === b.observationsTs &&
  a.expiresAt === b.expiresAt &&
  a.price === b.price &&
  a.bid === b.bid &&
  a.ask === b.ask;

function Failure({ outcome, network }: { outcome: Extract<Outcome, { kind: 'error' }>; network: NetworkName }) {
  const expected =
    outcome.code === 9 && network === 'mainnet'
      ? 'This is the expected answer on mainnet.'
      : outcome.code === 12 && outcome.tampered
        ? 'This is the expected answer for a changed byte.'
        : null;
  return (
    <Notice tone="bad">
      {outcome.message}
      {outcome.detail ? ` ${outcome.detail}` : ''}
      {expected ? ` ${expected}` : ''}
    </Notice>
  );
}

function FieldList({ fields, nowS, pushPrices }: { fields: Fields; nowS: number; pushPrices: ReadonlyMap<string, bigint> }) {
  const asset = assetOfStream(fields.streamId);
  const push = asset ? (pushPrices.get(asset.key) ?? null) : null;
  const bps = spreadBps(push, fields.price);
  const expired = fields.expiresAt <= nowS;
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-muted">stream</dt>
      <dd>
        {asset ? `${asset.label} ` : ''}
        <Mono>{fields.streamId}</Mono>
      </dd>
      <dt className="text-muted">valid from</dt>
      <dd className="font-mono tabular-nums">{isoFromSeconds(fields.validFrom)}</dd>
      <dt className="text-muted">observed</dt>
      <dd className="font-mono tabular-nums">{isoFromSeconds(fields.observationsTs)}</dd>
      <dt className="text-muted">expires</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <span className="font-mono tabular-nums">{isoFromSeconds(fields.expiresAt)}</span>
        {expired ? (
          <Pill tone="bad">expired {daysBetween(fields.expiresAt, nowS)} days ago</Pill>
        ) : (
          <Pill tone="ok">valid for {formatSeconds(fields.expiresAt - nowS)}</Pill>
        )}
      </dd>
      <dt className="text-muted">price</dt>
      <dd className="font-mono tabular-nums">{formatE18Price(fields.price)}</dd>
      <dt className="text-muted">bid / ask</dt>
      <dd className="font-mono tabular-nums">
        {formatE18Price(fields.bid)} / {formatE18Price(fields.ask)}
      </dd>
      <dt className="text-muted">would-be spread</dt>
      <dd>
        {bps !== null && push !== null && asset ? (
          <span className="font-mono tabular-nums">
            {formatBps(bps)} ({bpsToPercent(bps)}) against the {asset.label} push price {formatE18Price(push)}
          </span>
        ) : (
          <span className="text-muted">{asset ? `no push price for ${asset.label} on this board` : 'unknown stream'}</span>
        )}
      </dd>
    </dl>
  );
}
