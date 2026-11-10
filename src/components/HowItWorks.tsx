import { ASSETS, FEED_DECIMALS } from '../lib/feeds';
import { contractUrl, NETWORKS, type NetworkName } from '../lib/networks';
import { Card, CopyButton, Ext, Mono } from './ui';

/** sha256 of the empty string: the body hash of every GET. */
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const xlm = ASSETS[0];

/** A keyless proxy read with the CLI. Any account that exists works as --source when nothing is sent. */
function invokeCommand(network: NetworkName): string {
  return [
    'stellar contract invoke \\',
    `  --id ${NETWORKS[network].proxy} \\`,
    `  --network ${network} \\`,
    '  --source <G... or key name> \\',
    '  --send=no \\',
    '  -- latest_round \\',
    `  --data_id ${xlm?.dataId ?? ''} \\`,
    `  --decimals ${FEED_DECIMALS}`,
  ].join('\n');
}

/** The string the HMAC signs, then the headers that carry it. */
function signingString(network: NetworkName): string {
  const streamId = xlm?.streamIds[network] ?? '0x...';
  return [
    '# METHOD PATH_WITH_QUERY SHA256HEX(body) USERNAME TIMESTAMP_MS',
    `GET /api/v1/reports/latest?feedID=${streamId} ${EMPTY_BODY_SHA256} <username> <unix ms>`,
    '',
    '# headers',
    'Authorization: <username>',
    'X-Authorization-Timestamp: <unix ms>',
    'X-Authorization-Signature-SHA256: hex(HMAC-SHA256(<secret>, the line above))',
    'User-Agent: Mozilla/5.0 (a browser-like value, or Cloudflare answers 403)',
  ].join('\n');
}

export function HowItWorks({ network }: { network: NetworkName }) {
  const net = NETWORKS[network];
  const invoke = invokeCommand(network);
  const signing = signingString(network);
  return (
    <Card title="How it works">
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li>
          <span className="font-medium">Read.</span> One{' '}
          <Ext href={contractUrl(net, net.proxy)}>proxy contract</Ext> serves every feed. You select a feed by its
          32-byte <Mono>data_id</Mono>, the same on both networks. <Mono>latest_round(data_id, decimals)</Mono> returns{' '}
          <Mono>answer</Mono> (an I256), <Mono>round_id</Mono> and <Mono>timestamp</Mono>. Every feed stores 18
          decimals; the proxy truncates down to 8. Errors: #50 <Mono>NoDataPresent</Mono> for an unknown id, #51{' '}
          <Mono>InvalidDecimals</Mono> for decimals 0, #52 <Mono>RoundsToZero</Mono> when truncation leaves nothing.
          A frozen feed panics with #109. The contract calls <Mono>try_latest_round</Mono> and stores the round as
          the push leg.
        </li>
        <li>
          <span className="font-medium">Verify.</span> A Data Streams report is an ABI envelope: the 288-byte report
          data plus f+1 secp256k1 signatures. The{' '}
          <Ext href={contractUrl(net, net.verifier)}>verifier contract</Ext> recovers each signer and checks it
          against the DON config named in the report. The same bytes give #9 <Mono>DigestNotSet</Mono> on mainnet,
          because the config lives on testnet only, and #12 <Mono>BadVerification</Mono> after one flipped byte. The
          verifier does not check freshness. The contract does: it refuses a report past <Mono>expiresAt</Mono> with
          #23 and stores an accepted one as the pull leg.
        </li>
        <li>
          <span className="font-medium">Compare.</span> Two clocks. The push clock ticks when the price moves by the
          deviation (0.5%, gold 0.1%) or when the heartbeat passes (about a day). The pull clock ticks when someone
          submits a signed report. <Mono>spread_bps</Mono> shows the gap and <Mono>fresh_price</Mono> picks the newer
          leg under a max age. Freshness is the consumer's job on both legs.
        </li>
      </ol>
      <p className="mt-4 text-sm text-muted">
        Why no live pull leg? The Data Streams API needs a paid subscription since 1 September 2026, and the one public
        signed report expired on 2026-05-03. The verify box shows what the verifier says about it; the board shows the
        push legs the contract holds.
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Read a feed with the CLI</span>
        <CopyButton text={invoke} />
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-code p-3 font-mono text-xs leading-relaxed">{invoke}</pre>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Sign a Data Streams request</span>
        <CopyButton text={signing} />
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-code p-3 font-mono text-xs leading-relaxed">{signing}</pre>
      <p className="mt-2 text-xs text-muted">
        The timestamp must be within 5 s of the server clock. Credentials are per environment. The page sends none of
        this: it reads the chain only.
      </p>
    </Card>
  );
}
