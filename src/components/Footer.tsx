import { Ext } from './ui';

const LINKS = [
  { href: 'https://github.com/kaankacar/stellar-chainlink-demo', label: 'Source on GitHub' },
  { href: 'https://docs.chain.link/data-feeds/stellar', label: 'Chainlink Data Feeds on Stellar' },
  { href: 'https://docs.chain.link/data-feeds/price-feeds/addresses?network=stellar', label: 'Stellar feed ids' },
  {
    href: 'https://docs.chain.link/data-streams/tutorials/stellar-onchain-report-verification',
    label: 'Data Streams verification on Stellar',
  },
  { href: 'https://developers.stellar.org/docs/data/oracles', label: 'Stellar oracle docs' },
];

export function Footer() {
  return (
    <footer className="mt-10 border-t border-line pt-5 text-sm text-muted">
      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Ext href={l.href}>{l.label}</Ext>
          </li>
        ))}
      </ul>
      <p className="mt-3">Field Note No. 03. Not affiliated with Chainlink Labs.</p>
    </footer>
  );
}
