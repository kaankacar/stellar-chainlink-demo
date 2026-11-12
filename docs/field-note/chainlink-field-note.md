# Field Note No. 03: Chainlink Data Feeds on Stellar

*read / verify / compare. 2026.*

![Field Note No. 03 card](card/card.png)

## Attribution

- **Built by:** Kaan Kacar, Developer Relations at the Stellar Development Foundation. GitHub [kaankacar](https://github.com/kaankacar). Live demo: [kaankacar.github.io/stellar-chainlink-demo](https://kaankacar.github.io/stellar-chainlink-demo/).
- **Release:** Chainlink Data Feeds and Data Streams on Stellar mainnet, announced 14 October 2026. [The launch post on the Stellar blog](https://stellar.org/blog/foundation-news/chainlink-is-now-live-on-stellar-unleashing-a-new-wave-of-defi-innovation), [Two Ways to Read Chainlink Prices on Stellar](https://stellar.org/blog/developers/ways-to-read-chainlink-prices-on-stellar-data-feeds-and-data-streams) from 19 October, and the [oracle providers page](https://developers.stellar.org/docs/data/oracles/oracle-providers) in the docs.
- **Demo:** the walkthrough video `DR-5_chainlink-field-note_2026-11-10.mp4` and the screenshots `DR-5_chainlink-field-note_00` to `12` in the Drive folder `Demos + Field Notes/Chainlink`. Code: [github.com/kaankacar/stellar-chainlink-demo](https://github.com/kaankacar/stellar-chainlink-demo), MIT.
- **Repos used:** Chainlink's [chainlink-stellar](https://github.com/smartcontractkit/chainlink-stellar) (the Data Feeds proxy interface, copied by hand because there is no crate) and, for the one Streams check in this note, [data-streams-stellar](https://github.com/smartcontractkit/data-streams-stellar) (the verifier's interface and error codes). Docs: the [Stellar Data Feeds guide](https://docs.chain.link/data-feeds/stellar) and the [feed list](https://docs.chain.link/data-feeds/price-feeds/addresses?network=stellar). Versions: `soroban-sdk` 29.0.1, Stellar CLI 26.0.0, `@stellar/stellar-sdk` 17.2.1. I forked nothing and deployed no copy of Chainlink's contracts: my contract calls the proxy Chainlink deployed. Not affiliated with Chainlink Labs.

## 1. What I built

The brief was one sentence: read a Chainlink Data Feed from a Soroban contract on testnet.

This note is about Data Feeds. Chainlink launched Data Streams on Stellar the same day, and the request named both, but Streams has had no free tier since 1 September 2026, and a developer cannot fetch one live report without a subscription. I say why in one paragraph below, show what I could check for free, and leave the rest for a note with a subscription behind it.

**Two Clocks** is a small Soroban contract that keeps the Data Feeds price of each asset. One proxy contract per network serves every feed; you pass a 32-byte id and get a round with a price at 18 decimals and a timestamp. My contract reads all ten feeds in one transaction, stores each round with its time, refuses a round older than its window, never overwrites a newer round with an older one, and answers the one question a lending protocol asks: give me a price I can trust, or tell me there is none. Around it: a script that refreshes the ten feeds, a watcher that does that in a loop, and a read-only page that shows every feed with its age and the time left on its heartbeat. The contract also has a slot for a verified Data Streams report next to each feed. On a free account that slot stays empty, and the page says so.

I ran it on testnet only. The proxy is deployed on testnet and mainnet with the same interface and the same ten ids, and reading it by simulation costs nothing, so the recon run reads mainnet too, without a key and without a transaction.

**Why feeds and not streams.** A Data Feed is free to read: ten USD feeds, no key, no subscription, one simulation per read. A Data Streams report is a signed blob you fetch from Chainlink's API and bring on chain yourself, and the API is a paid product: Chainlink closed the free tier on 1 September 2026 and sells streams from $150 per month per feed. The Chainlink Platform gave me a username and a secret. On the testnet API they answer `401 user does not exist`. On the mainnet API they authenticate, list zero feeds, and answer `401 feeds not authorized` for every stream. Nothing in either body says "subscribe". The only signed report a developer can get for free is the sample in Chainlink's tutorial, signed on 3 April 2026 and expired on 3 May. I ran that one through Chainlink's verifier contract: it accepted the signatures, and my contract rejected the report as expired. That is all a free account can show, so this note is about the feeds, and the Streams findings are in the friction log for whoever picks them up with a subscription.

**What a Data Feed is on Stellar.** A promise with two triggers: the price on chain moves when the market moves 0.5 percent (0.1 for gold), or after 24 hours, whichever comes first. Chainlink's network writes it, you pay nothing to read it, and on a quiet day the stored price can be hours old and still be the right one. The proxy never refuses an old round. The freshness check is yours.

Other friction: there is no crate or npm package for the proxy interface, you copy a trait. The guide pins `soroban-sdk` 25; 29 worked. The docs list a `FeedFrozen` error in the wrong table, and it reaches you as a bare `#109`. Two feeds refuse any precision below 18 decimals, and no page says which.

Time: one day on 10 November, after a day of reading and probing on 9 November.

## 2. How it went

Five runs on 10 November and one after the site went public. Every transaction went to testnet; run 0 also read mainnet by simulation, which costs nothing. The logs with timestamps and transaction links are in `docs/field-note/runs/`. Only the numbers that carry a finding are here.

**Run 0, recon.** `pnpm recon`. Both proxies answer `DataFeedsProxy 1.0.0` and serve the same ten ids. XLM/USD on testnet: 0.143892, round 2365, 7 minutes old; on mainnet 0.144367, round 2451, 33 minutes old. USDT, USDC and the two RWA feeds sat 17 to 24 hours behind their last move, inside the heartbeat, exactly as a 0.5 percent trigger predicts on a flat day. An unknown id gives `#50`, `decimals: 0` gives `#51`, and asking for 8 decimals truncates. `get_min_decimals` is 8 for eight feeds and 18 for the gold rate and the NAV feed. Nothing was signed. (Screen 01.)

**Run 1, deploy.** `pnpm run deploy -- --network testnet`. A 23 KB wasm. Upload 1.54 XLM, create 18.70 XLM. The constructor extends every entry to 90 days and renews only inside the last 30, instead of the 180-day maximum on every call, which cost 211 XLM in No. 02. Contract `CDJTBGMNA4T2Q4IALTUQVNSUTFHISVQIDKMKNKW26AYJIM5QWFQ3I4FP`, ten assets. (Screen 04.)

**Run 2, one refresh.** `pnpm refresh -- --network testnet`. One transaction, ten proxy calls, ten rounds stored, 0.71 XLM: the first write of ten persistent entries pays their 90 days at once. FLHY/USD was 23 h 39 min old with 19 minutes left on its heartbeat; the crypto feeds were minutes old. (Screens 05 and 08.)

**Run 3, the streams check.** What a free account can verify. Chainlink's sample report went through the testnet verifier by simulation and came back byte for byte as my local decode. One flipped bit in the price gave `#12 BadVerification`. The same bytes on the mainnet verifier gave `#9 DigestNotSet`: a report is signed for one network. Through my contract, `submit_report` answered `#23 Expired` at the simulate stage, 191 days past `expiresAt`, nothing sent, no fee. The API with my credentials: testnet `401 user does not exist`, mainnet `{"feeds":[]}` and `401 feeds not authorized`. (Screens 02, 03, 06, 09 and 10.)

**Run 4, the watch.** `pnpm watch -- --network testnet --every 600 --minutes 120`. Thirteen rounds, 41 feed rounds stored, two rounds skipped as `NothingNew` at the simulate stage, which costs nothing. 0.051 XLM for two hours. The 0.5 percent trigger showed its shape: XLM, BTC, ETH and LINK each moved six to nine times, about every 10 to 15 minutes, in an afternoon with a 1.8 percent XLM swing. Gold, with its 0.1 percent trigger, moved eleven times. EURC moved once. FLHY moved once, at the 24-hour heartbeat, 23 h 59 min after its previous round. USDT, USDC and USPC did not move at all. A consumer that needs a stablecoin price younger than an hour cannot get it from a push feed on a flat day. (Screen 07.)

**Run 5, after the site went public.** The repo and the board went public an hour after the watch ended. One more `pnpm refresh` so the first visitor sees fresh rows: five of the ten feeds had a newer round, one transaction, 0.010 XLM. The other five were already current.

**The page.** It reads the contract by simulation every 10 seconds and shows every feed with its price, round, age and heartbeat countdown. The pull column says why it is empty. The verify box takes a report, runs it through the contract by simulation, and prints the decoded fields, the expiry and the error name when there is one. The mainnet toggle reads the ten feeds from the mainnet proxy, by simulation, with no deployment. (Screens 08 to 11.)

## 3. The mental model that made it click

**One proxy, one id per feed.** There is no aggregator address to find. Every feed on Stellar lives behind the same contract and is picked by a 32-byte id that is the same on testnet and mainnet. The id is the thing to pin, not an address.

**A feed is a 24-hour promise with a 0.5 percent trigger.** The price on chain moves when the market moves half a percent, or after 24 hours, whichever comes first. On a quiet day the stored price can be hours old and still be the right one. Freshness is a number you compare with the heartbeat, not a boolean.

**The proxy never says no.** It returns the latest round it has, however old. A lending contract that reads it without comparing the timestamp to the heartbeat is trusting yesterday. The check is one line, and it has to be in your code.

**18 decimals, and truncation is yours.** Every feed stores 18 decimals. Ask the proxy for fewer and it truncates, and two feeds refuse anything below 18. Store the raw integer and scale in the consumer.

**Rent is a policy, not a fee.** Extending every entry to the maximum on every call cost No. 02 211 XLM at deploy. Extending to 90 days and renewing inside the last 30 cost 18.70, and the watch paid 0.051 XLM for two hours. Pick the window on purpose.

## 4. Friction log

The log is [friction-log.md](https://github.com/kaankacar/stellar-chainlink-demo/blob/main/docs/field-note/friction-log.md): 6 rows, only the problems that change a developer's experience and that Chainlink can act on. Everything else I hit, Streams, Candlestick, my own mistakes and tooling included, is in [friction-log-full.md](https://github.com/kaankacar/stellar-chainlink-demo/blob/main/docs/field-note/friction-log-full.md).

What I would ask Chainlink to fix, in order:

1. Move `FeedFrozen` out of the `ProxyReadError` table and document code 109 (C1).
2. Publish the Stellar proxy interface as a crate and update the guide's `soroban-sdk` pin (C2).
3. Name the id field in the feed-list JSON `dataId`, show the ids on the page as text, and fix the FLHY label (C3).
4. Fix the retired `soroban.stellar.org` links in the Data Feeds guides (C4).
5. List each feed's minimum decimals next to its id (C5).
6. For Streams: give developers a way to rehearse the pull path for free, say which environment a key belongs to, and answer an unsubscribed stream with one clear message (C6).

## 5. Where I think this goes

Data Feeds are ready for the protocols the launch names: free to read, ten assets, a proxy you can call from any contract in one line, and a freshness rule you write yourself. That is enough for lending, stablecoin logic and vaults today. What I would watch: the feed list growing past ten, which the NAV and reference-rate feeds already hint at, and the first Stellar protocol that reads them in production. Data Streams are the perps and liquidation story, and they are a subscription; a builder cannot rehearse that path on a free account today, and that note waits for a key. For anything that holds funds, two sources and a divergence check still apply. Two Clocks has an empty column waiting for a second source. The next one is another oracle.

## 6. Try it yourself

```bash
git clone https://github.com/kaankacar/stellar-chainlink-demo && cd stellar-chainlink-demo
pnpm install && pnpm recon                          # read-only on both networks, no key needed
pnpm read-feed -- --network mainnet --asset xlm      # one proxy read by simulation
cp .env.example .env                                # a testnet key; Data Streams credentials only if you have them
pnpm build:wasm && pnpm run deploy -- --network testnet
pnpm refresh -- --network testnet                   # ten feeds in one transaction, then open the site
```

- Repo and live board: [github.com/kaankacar/stellar-chainlink-demo](https://github.com/kaankacar/stellar-chainlink-demo), [kaankacar.github.io/stellar-chainlink-demo](https://kaankacar.github.io/stellar-chainlink-demo/).
- Chainlink's [Data Feeds on Stellar](https://docs.chain.link/data-feeds/stellar) and [feed list](https://docs.chain.link/data-feeds/price-feeds/addresses?network=stellar).
- Stellar's [oracle providers page](https://developers.stellar.org/docs/data/oracles/oracle-providers) and the [Two Ways post](https://stellar.org/blog/developers/ways-to-read-chainlink-prices-on-stellar-data-feeds-and-data-streams).
- Bring questions to the next Stellar Developers Meeting.
