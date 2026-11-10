# Field Note No. 03: Chainlink on Stellar

*read / verify / compare. 2026.*

![Field Note No. 03 card](card/card.png)

## Attribution

- **Built by:** Kaan Kacar, Developer Relations at the Stellar Development Foundation. GitHub [kaankacar](https://github.com/kaankacar). Live demo: [kaankacar.github.io/stellar-chainlink-demo](https://kaankacar.github.io/stellar-chainlink-demo/).
- **Release:** Chainlink Data Feeds and Data Streams on Stellar mainnet, announced 14 October 2026. [The launch post on the Stellar blog](https://stellar.org/blog/foundation-news/chainlink-is-now-live-on-stellar-unleashing-a-new-wave-of-defi-innovation), [Two Ways to Read Chainlink Prices on Stellar](https://stellar.org/blog/developers/ways-to-read-chainlink-prices-on-stellar-data-feeds-and-data-streams) from 19 October, and the [oracle providers page](https://developers.stellar.org/docs/data/oracles/oracle-providers) in the docs.
- **Demo:** the walkthrough video `DR-5_chainlink-field-note_2026-11-DD.mp4` and the screenshots `DR-5_chainlink-field-note_00` to `NN` in the DevRel Drive folder, subfolder `Chainlink`. Code: [github.com/kaankacar/stellar-chainlink-demo](https://github.com/kaankacar/stellar-chainlink-demo), MIT.
- **Repos used:** Chainlink's [chainlink-stellar](https://github.com/smartcontractkit/chainlink-stellar) (the Data Feeds proxy interface, copied by hand because there is no crate) and [data-streams-stellar](https://github.com/smartcontractkit/data-streams-stellar) (the verifier, read for its interface and error codes), the [Stellar Data Feeds guide](https://docs.chain.link/data-feeds/stellar) and the [Data Streams Stellar tutorial](https://docs.chain.link/data-streams/tutorials/stellar-onchain-report-verification), whose sample report is the only signed report in this note. `soroban-sdk` 29.0.1, Stellar CLI 26.0.0, `@stellar/stellar-sdk` 17.2.1. I forked nothing and deployed no copy of Chainlink's contracts: my contract calls the proxy and the verifier Chainlink deployed. Not affiliated with Chainlink Labs.

## 1. What I built

The brief was one sentence: read a Chainlink Data Feed from a Soroban contract on testnet.

Chainlink shipped two things on Stellar, and the second one is the interesting one, so I built for both. **Two Clocks** is a small Soroban contract that keeps two prices per asset. The **push** price comes from the Data Feeds proxy: one contract per network serves every feed, you pass a 32-byte id, you get a round with a price at 18 decimals and a timestamp. The **pull** price comes from a Data Streams report: a signed blob you fetch off-chain, hand to Chainlink's verifier contract, and decode after it has checked the signatures. The contract stores both legs with their timestamps, refuses what is stale, computes the spread between them, and answers one question a lending or perps protocol asks: give me the freshest price you trust, or tell me there is none. Around it: a pusher that refreshes all ten feeds in one transaction, a watcher that does that in a loop, scripts that push a report through the verifier, and a read-only page with both columns.

I ran it on testnet only. The proxy and the verifier are deployed on testnet and mainnet with the same interface, and reading either by simulation costs nothing, so the recon run reads mainnet too, without a key and without a transaction.

**Read this before you budget a build on it.** TODO after run 0: the free tier story, $150 per feed per month, credentials per environment, 404 means not subscribed, the sample report is the only free signed report and it expired on 3 May 2026.

**Push or pull.** TODO one paragraph: a 24-hour promise with a 0.5 percent trigger, versus a signature with an expiry; who pays, who checks freshness.

Other friction: TODO after the build (crate, docs errors, verifier trait).

Time: TODO.

## 2. How it went

TODO Runs 0 to 5 with ISO timestamps, only the numbers that carry a finding. Logs in `docs/field-note/runs/`.

## 3. The mental model that made it click

**One proxy, one id per feed.** There is no aggregator address to find. Every feed on Stellar lives behind the same contract and is picked by a 32-byte id that is the same on testnet and mainnet. The id is the thing to pin, not an address.

**A push feed is a 24-hour promise with a 0.5 percent trigger.** The price on chain moves when the market moves half a percent, or after 24 hours, whichever comes first. On a quiet day the stored price can be hours old and still be the right one. Freshness is a number you compare with the heartbeat, not a boolean.

**The verifier checks who signed, never when.** `verify` recovers f+1 signatures and returns the bytes. It accepted a report from April in November. The report carries `expiresAt` and `observationsTimestamp`, and the consumer contract is where they get enforced. That is not a gap, it is the division of labour, and it has to be in your code.

**The contract is the sender.** `verify` wants a `sender` that authorizes the call. A contract that calls the verifier directly can pass its own address and needs no user signature for that step. The user authorizes the contract, the contract authorizes the verifier.

**18 decimals, and truncation is yours.** Both products use 18 decimals. Ask the proxy for fewer and it truncates. Store the raw integer and scale in the consumer.

**A free account gets charts, not proofs.** TODO confirm after run 0: the Candlestick API answers with history on the free account, the report API answers with 404.

## 4. Friction log

TODO: link to friction-log.md, counts, "What I would ask Chainlink to fix, in order" numbered list.

## 5. Where I think this goes

TODO short closing take.

## 6. Try it yourself

```bash
git clone https://github.com/kaankacar/stellar-chainlink-demo && cd stellar-chainlink-demo
pnpm install && pnpm recon                          # read-only on both networks, no key needed
pnpm read-feed -- --network mainnet --asset xlm      # one proxy read by simulation
cp .env.example .env                                # a testnet key, and Data Streams credentials if you have them
pnpm build:wasm && pnpm run deploy -- --network testnet
pnpm refresh -- --network testnet                   # ten feeds in one transaction, then open the site
```

- Repo and live board: [github.com/kaankacar/stellar-chainlink-demo](https://github.com/kaankacar/stellar-chainlink-demo), [kaankacar.github.io/stellar-chainlink-demo](https://kaankacar.github.io/stellar-chainlink-demo/).
- Chainlink's [Data Feeds on Stellar](https://docs.chain.link/data-feeds/stellar), [feed list](https://docs.chain.link/data-feeds/price-feeds/addresses?network=stellar) and [Data Streams on Stellar](https://docs.chain.link/data-streams/tutorials/stellar-onchain-report-verification).
- Stellar's [oracle providers page](https://developers.stellar.org/docs/data/oracles/oracle-providers) and the [Two Ways post](https://stellar.org/blog/developers/ways-to-read-chainlink-prices-on-stellar-data-feeds-and-data-streams).
- Bring questions to the next Stellar Developers Meeting.
