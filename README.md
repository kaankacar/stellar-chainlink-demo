# Chainlink on Stellar: Two Clocks

Chainlink gives Stellar contracts two ways to read a price. **Data Feeds** push a reference price into one proxy contract whenever it moves 0.5 percent or 24 hours pass. **Data Streams** let you pull a signed report off-chain and have Chainlink's verifier contract check the signatures on-chain. This repo keeps both on one board: a Soroban contract, **Two Clocks**, stores the push price and the pull price of each asset with their timestamps, computes the spread, and tells you which one is fresh enough to use.

Testnet only. Mainnet is read by simulation, nothing is signed there.

The field note is about Data Feeds. The pull leg exists in the contract and on the page, but Data Streams has no free tier, so the note only shows what the verifier does with Chainlink's one public sample report, which is expired. The Pages site is at `https://kaankacar.github.io/stellar-chainlink-demo/` and is published by the workflow on every push to `main`.

## The three verbs

1. **Read.** `refresh` calls the Data Feeds proxy `latest_round(data_id, 18)` for every asset in one transaction and stores the round. A round older than `max_push_age_s` is `Stale`, a round that is not newer than the stored one is skipped.
2. **Verify.** `submit_report` hands a signed Data Streams report to Chainlink's verifier. The verifier checks the signatures and nothing else. The contract decodes the v3 report, rejects it if `expiresAt` has passed or `observationsTimestamp` is older than `max_pull_age_s`, and stores price, bid and ask. `verify_report` does the same without storing, for the page's verify box.
3. **Compare.** `latest` returns both legs, `spread_bps` the gap between them, and `fresh_price(max_age_s)` the newest leg inside the window, or `Stale`.

Freshness is the consumer's job on both legs. The proxy does not check it, and the verifier does not either.

## Layout

```
contracts/two-clocks/    the contract (soroban-sdk 29), unit tests, the sample report fixture
scripts/                 recon, deploy, refresh, submit, watch, verify-raw, read-feed (tsx)
scripts/lib/             log, stellar (submit with a fee margin), streams (HMAC and candlestick clients), clocks
src/                     the read-only page (Vite 8, React 19, Tailwind 4) and the shared feeds table and report decoder
tests/                   vitest
docs/field-note/         the write-up, the friction logs, run logs, the card, the stills
```

## Requirements

- Node 24, pnpm 11, Rust 1.95 with the `wasm32v1-none` target, Stellar CLI 26.
- A funded testnet key in `.env` as `STELLAR_SECRET`, or leave it empty for a throwaway friendbot key.
- Chainlink Data Streams credentials in `.env` (`DATA_STREAMS_USERNAME`, `DATA_STREAMS_SECRET`, `CANDLESTICK_API_KEY`) for the API sections of `recon`. Everything on chain works without them: the sample report ships in the repo.

```bash
pnpm install
cp .env.example .env     # fill what you have
pnpm recon               # read-only on both networks, signs nothing
```

## Contract

`contracts/two-clocks`, built with `pnpm build:wasm` (`stellar contract build`). Functions:

| Function | What it does |
|---|---|
| `__constructor(admin, proxy, verifier, max_push_age_s, max_pull_age_s, assets)` | Sets the two Chainlink contracts, the windows and the assets with their stream ids. |
| `refresh(data_ids) -> u32` | Reads every id from the proxy, stores the new rounds, returns the count. |
| `refresh_one(data_id) -> PushLeg` | The same for one id, with the error instead of a skip. |
| `submit_report(signed_report) -> PullLeg` | Verifier, decode, freshness, store. |
| `verify_report(signed_report) -> ReportV3` | Verifier and decode only. |
| `latest(data_id) -> Pair`, `latest_many(ids)` | Both legs. |
| `spread_bps(data_id) -> i128` | `(pull - push) * 10_000 / push`. |
| `fresh_price(data_id, max_age_s) -> FreshPrice` | The newest leg inside the window. |
| `assets()`, `config()`, `set_stream(data_id, stream_id)` | Reads and the one admin call. |

Error codes: 2 to 18 are Chainlink's verifier errors passed through unchanged (9 `DigestNotSet`, 12 `BadVerification`), 20 to 32 are ours (20 `Stale`, 21 `NothingNew`, 23 `Expired`, 28 `UnknownAsset`, 29 `UnknownStream`), 50 to 52 are the proxy's (`NoDataPresent`, `InvalidDecimals`, `RoundsToZero`) and 109 is the proxy's `FeedFrozen`.

Rent: every entry extends its TTL only when it is within 30 days of expiry, to 90 days. The first write of an entry pays once, later calls pay compute and the write.

## Scripts

Run them as `pnpm <name> -- --flag`. Every script takes `--log <path>` and writes timestamped lines.

| Script | Use |
|---|---|
| `recon` | Read-only, both networks: the proxy's answers for all ten feeds, the verifier with the sample report, the tampered byte, the mainnet rejection, the Data Streams API with your credentials, the candlestick API. |
| `deploy -- --network testnet` | Uploads and creates the contract, writes `src/deployments.json`. |
| `refresh -- --network testnet [--assets xlm,btc]` | One transaction, all feeds. |
| `submit -- --network testnet [--file <hex>] [--expect-expired]` | A signed report through the contract. The sample is expired, and the contract says so. |
| `watch -- --network testnet --every 600 --minutes 120` | Refresh in a loop, log which feeds moved and what it cost. |
| `verify-raw -- --network testnet --file <hex> [--tamper]` | The verifier alone, by simulation. |
| `read-feed -- --network mainnet --asset xlm` | One proxy read, no key needed. |

Use `pnpm run deploy`, not `pnpm deploy`: `deploy` is a pnpm built-in.

## Feeds

| Key | Feed | data_id | Deviation | Stream on testnet |
|---|---|---|---|---|
| xlm | XLM / USD | `017be2f55a000332…` | 0.5 % | yes |
| btc | BTC / USD | `01a0b4d920000332…` | 0.5 % | yes |
| eth | ETH / USD | `01d585327c000332…` | 0.5 % | yes (the sample report) |
| link | LINK / USD | `0101199b3b000332…` | 0.5 % | yes |
| usdt | USDT / USD | `016d06ebb6000332…` | 0.5 % | yes |
| usdc | USDC / USD | `01a80ff216000332…` | 0.5 % | yes |
| eurc | EURC / USD | `01962615c3000332…` | 0.5 % | no |
| xaum | XAUM Reference Rate | `0197aabf9c000332…` | 0.1 % | no |
| flhy | FLHY / USD | `0142ac24bc000332…` | 0.5 % | no |
| uspc | USPC NAV | `016e06407e000332…` | 0.5 % | no |

Every id is the 16 hex characters shown plus 48 zeros. All feeds store 18 decimals. The heartbeat is 24 hours (86355 s on testnet). The full table with the stream ids is in `src/lib/feeds.ts`.

## Contract ids

| Network | Two Clocks | Data Feeds proxy | Data Streams verifier |
|---|---|---|---|
| testnet | see `src/deployments.json` | `CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4` | `CA7GVHWH4GRHE6GI7MHEKQZAOYO4GE7KRGSU3EOS3HYJRVLX3XEA4ONQ` |
| mainnet | not deployed (testnet only) | `CDQBHEUGLDHMSUHG4IH33RJBUTMNCZOT4JIAQR4WZFRDZW6DR6S32ZLZ` | `CAKA3NBYPC6OBEUEGNIYGNYG3ES2GPQK736B5SR7ASGUXRDAKXI2JCQI` |

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
cd contracts/two-clocks && cargo test && cargo clippy --all-targets -- -D warnings
```

## Links

- Chainlink: [Data Feeds on Stellar](https://docs.chain.link/data-feeds/stellar), [feed list](https://docs.chain.link/data-feeds/price-feeds/addresses?network=stellar), [Data Streams on Stellar](https://docs.chain.link/data-streams/tutorials/stellar-onchain-report-verification), [report schemas](https://docs.chain.link/data-streams/reference/report-schema-overview), [chainlink-stellar](https://github.com/smartcontractkit/chainlink-stellar), [data-streams-stellar](https://github.com/smartcontractkit/data-streams-stellar).
- Stellar: [oracle providers](https://developers.stellar.org/docs/data/oracles/oracle-providers), [the launch post](https://stellar.org/blog/foundation-news/chainlink-is-now-live-on-stellar-unleashing-a-new-wave-of-defi-innovation), [Two Ways to Read Chainlink Prices on Stellar](https://stellar.org/blog/developers/ways-to-read-chainlink-prices-on-stellar-data-feeds-and-data-streams).

Not affiliated with Chainlink Labs or SmartContract Chainlink Limited. The sample report is Chainlink's published testnet example. MIT.

## Field note

This repo is the demo behind Field Note No. 03, "Chainlink on Stellar". The write-up, the friction logs, the run logs, the card and the stills live in [docs/field-note](docs/field-note).
