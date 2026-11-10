# Friction log, full: Chainlink on Stellar

Everything I hit while building Two Clocks on 9 and 10 November 2026, four weeks after the 14 October 2026 launch of Chainlink Data Feeds and Data Streams on Stellar. One row per problem: what I was doing, what went wrong, the fix or workaround, and whether it is fixed, open, or by design. This is the long list, my own mistakes and tooling included. The short, partner-facing list is in [friction-log.md](friction-log.md). Repo: https://github.com/kaankacar/stellar-chainlink-demo.

## A. Data Feeds proxy

| # | While doing | What went wrong | Fix or workaround | Status |
|---|---|---|---|---|
| A1 | Reading the error table on the Data Feeds Stellar page | It lists `FeedFrozen` as a `ProxyReadError` next to `NoDataPresent`, `InvalidDecimals` and `RoundsToZero`. The on-chain spec and the source have only codes 50, 51 and 52 in that enum. A frozen feed panics inside the proxy with `CacheError::FeedFrozen = 109`, so a caller sees `Error(Contract, #109)`, not a typed error. | The contract maps `InvokeError::Contract(109)` to its own `FeedFrozen`. | open |
| A2 | Adding the proxy interface to the contract | There is no crate on crates.io and no npm package. Chainlink's docs say to copy the `#[contractclient]` trait from the repo. | Copied the read functions into `clients.rs`. | open |
| A3 | Asking the proxy for fewer than 18 decimals | The answer is truncated, not rounded. `decimals: 0` returns `#51`. `get_min_decimals` is 8 today, which the docs do not mention. | Pass 18 and scale in the consumer. | by design |
| A4 | Looking up the `data_id` of a feed | The addresses page is rendered in the browser, so curl shows no ids. The JSON behind it keeps the id in a field named `proxyAddress`, with a `0x` prefix, while the CLI wants it without. | Read `feeds-stellar-{testnet,mainnet}.json` from `docs.chain.link/files/json/` and strip the prefix. | open |
| A5 | Labelling the ten feeds on the board | Chainlink's JSON names the asset behind `FLHY / USD` "Flare" with class "Crypto". FLHY is the ticker of a tokenized high-yield bond ETF, and the Stellar post classes it as RWA. | Kept Chainlink's label and added the note. | open |
| A6 | Following the "Install the Stellar CLI" and "Soroban RPC" links in the Data Feeds guides | They point at `soroban.stellar.org`, a retired domain. The CLI link lands on the developers.stellar.org home page. | Used developers.stellar.org directly. | open |

## B. Verifier and reports

| # | While doing | What went wrong | Fix or workaround | Status |
|---|---|---|---|---|
| B1 | Passing Chainlink's sample testnet report, signed on 3 April 2026, to `verify` on 10 November | It verifies. The verifier checks who signed and nothing else. A report with `expiresAt` six months in the past is accepted. | The contract checks `expiresAt` and `observationsTimestamp` itself and returns `Expired` for the sample. The tutorial says to do this, in one sentence. | by design |
| B2 | Calling `verify` from a contract | `verify` calls `sender.require_auth()`. Passing a user address means a signed authorization for the nested call. | The contract passes its own address as `sender`. A contract is authorized for the calls it makes directly, so no user signature is needed. | by design |
| B3 | Copying the verifier trait from the tutorial | The tutorial declares `verify(...) -> Bytes`. The deployed function returns `Result<Bytes, ContractError>`, so with the tutorial's trait a `try_verify` cannot give a typed error. | Declared the real signature with the 2 to 18 error enum. | open |
| B4 | Following the tutorial's test step | It says `cargo test` runs "the included `real_signature_tests`". Those tests live in Chainlink's verifier repo, not in the project the tutorial scaffolds. The verifier repo's README also says to build for `wasm32-unknown-unknown` with the "Soroban CLI", while the tutorial uses `wasm32v1-none` and the Stellar CLI. | Wrote my own tests with a mock verifier. | open |
| B5 | Reading the tutorial's toolchain list | It pins `soroban-sdk = "25"`, `stellar-cli@25.2.0` and Rust 1.84 or later but not 1.91.0. Current is soroban-sdk 29, CLI 26 and Rust 1.95. | Built with the current versions. See D for how it went. | open |
| B6 | Reading the tutorial as markdown (the `.md` copy and `llms-full.txt`) | The "Network addresses" section is filled in by the browser, so the text copies have the testnet verifier id only. The mainnet id appears nowhere in them. | Took the mainnet id from Chainlink's docs source repo and from the Stellar post. | open |
| B7 | Reading the Stellar page in the Stellar docs and the tutorial's prerequisites | The tutorial opens with "Data Streams is self-serve, no sales call required" and then requires "an allowlisted account in the Data Streams Access Controller (contact us)". The Stellar verifier has no access controller: anyone can call `verify`. | Called it. | open |

## C. Data Streams API and Candlestick

| # | While doing | What went wrong | Fix or workaround | Status |
|---|---|---|---|---|
| C1 | Trying to fetch one live report on a free Chainlink Platform account | There is no free tier. Chainlink's sign-up page says "All Data Streams subscriptions are paid", from $150 per month per feed, since 1 September 2026. The only signed testnet report a developer can get for free is the April sample in the tutorial. | The pull leg of this note uses the sample. | open |
| C2 | Calling the testnet REST API with the credentials the Platform gave me | HTTP 401 `{"error":"user does not exist"}`. Credentials are per environment, and mine are for mainnet. The Platform did not say which environment the key belongs to. | Used the mainnet endpoint for the API sections. | open |
| C3 | Calling the mainnet REST API with the same credentials | Authenticated (200, `x-ratelimit-limit: 200`), but `/api/v1/feeds` returns `{"feeds":[]}` and every `reports/latest` returns 404 `{"message":"report not found"}`. Nothing says "you are not subscribed to this stream". `reports/bulk` says "at least one active feedID is required". | Documented the bodies. | open |
| C4 | Calling the API from a script without a browser-like User-Agent | Cloudflare answers 403 with body `error code: 1010` before the request reaches Chainlink. | Send a User-Agent header. | open |
| C5 | Reading candles from the Candlestick API | The 18-decimal values come as JSON numbers. XLM fits in a double, ETH and BTC do not (`2.1237031154468313e+21`), so `JSON.parse` loses the low digits. | Rewrite bare numeric literals to strings before parsing. | open |
| C6 | Asking the Candlestick API for `XLM/USD` | 404 "Could not find feedID for symbol". The symbol format is `XLMUSD`, and `symbol_info` returns the list. | Used `XLMUSD`. | open |
| C7 | Following the Stellar link in Chainlink's changelog entry "Data Streams Expands to Stellar" | `docs.chain.link/data-streams/stellar-onchain-report-verification` returns 404. The page lives under `/tutorials/`. | Searched the docs. | open |
| C8 | Listing what my account may read | `/api/v1/feeds` answers, but I found it in nobody's docs. The documented catalog is `/api/v1/discovery`, which is keyless. | Used both. | open |

## D. Contract and SDK

| # | While doing | What went wrong | Fix or workaround | Status |
|---|---|---|---|---|

## E. Running it on Stellar

Facts about running on Stellar, with the workaround where one was needed.

| # | While doing | What went wrong | Fix or workaround | Status |
|---|---|---|---|---|

## F. Docs and tooling

| # | While doing | What went wrong | Fix or workaround | Status |
|---|---|---|---|---|
