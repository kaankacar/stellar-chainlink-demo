# Spec: Chainlink on Stellar (Field Note No. 03, DR-5)

One Soroban contract, **Two Clocks**, keeps two prices per asset: the **push** price read from the Chainlink Data Feeds proxy and the **pull** price taken from a Chainlink Data Streams report that the Chainlink verifier contract checked. Scripts drive it on testnet, a read-only page shows it, and the field note tells what happened. This file is the contract between the people (and agents) working on the parts. Follow it; change it only with a note in the addendum at the end.

## Facts verified on 9 and 10 November 2026

Launch: Chainlink Data Feeds and Data Streams on Stellar mainnet, announced 14 October 2026 (stellar.org/blog/foundation-news/chainlink-is-now-live-on-stellar-unleashing-a-new-wave-of-defi-innovation). SDF developer post 19 October 2026: "Two Ways to Read Chainlink Prices on Stellar". Notion card DR-5: "Read a Chainlink Data Feed from a Soroban contract on testnet."

### Data Feeds (push)
- One proxy per network serves every feed. Select a feed by its 32-byte `data_id`. Ids are the same on both networks.
- Testnet proxy `CBUF6IADAWPWIDWRTHJNINKXHG2UTIQ6TU2F2HRAXWAI7OT3KJPKK6O4`, mainnet proxy `CDQBHEUGLDHMSUHG4IH33RJBUTMNCZOT4JIAQR4WZFRDZW6DR6S32ZLZ`. `type_and_version()` = `DataFeedsProxy 1.0.0`, `version()` = 1.
- Interface (copied by hand, no crate or npm package exists; Chainlink's docs say copy the trait):
  ```rust
  fn latest_round(env, data_id: BytesN<32>, decimals: u32) -> Result<Round, ProxyReadError>;
  fn get_round(env, data_id: BytesN<32>, round_id: u64, decimals: u32) -> Result<Round, ProxyReadError>;
  fn decimals(env, data_id: BytesN<32>) -> Result<u32, ProxyReadError>;      // 18 for every feed
  fn description(env, data_id: BytesN<32>) -> Result<String, ProxyReadError>; // "XLM/USD"
  fn get_min_decimals(env, data_id: BytesN<32>) -> u32;                       // 8 today
  fn version(env) -> u32; fn type_and_version(env) -> String;
  struct Round { answer: I256, round_id: u64, timestamp: u64 }               // timestamp in unix seconds
  enum ProxyReadError { NoDataPresent = 50, InvalidDecimals = 51, RoundsToZero = 52 }
  ```
  A frozen feed panics inside the proxy with `CacheError::FeedFrozen = 109`, which reaches a caller of `try_latest_round` as `InvokeError::Contract(109)`. Asking for fewer decimals than 18 truncates (`answer / 10^(18-decimals)`); a non-zero answer that truncates to zero is `RoundsToZero`. `decimals: 0` gives `#51`. Unknown id gives `#50`.
- Ten USD feeds, all 18 decimals, deviation 0.5 percent (XAUM 0.1 percent), heartbeat 86400 s on mainnet and 86355 s on testnet. Testnet XLM/USD moved about 44 rounds a day in October and November (deviation-driven). Source of the table: `docs.chain.link/files/json/feeds-stellar-{testnet,mainnet}.json` (the id is in the `proxyAddress` field with a `0x` prefix). Copies are in the scratchpad reference folder listed below.

| key | label | assetName | data_id (64 hex, no 0x) |
|---|---|---|---|
| xlm | XLM / USD | Stellar | `017be2f55a000332` + 48 zeros |
| btc | BTC / USD | Bitcoin | `01a0b4d920000332` + 48 zeros |
| eth | ETH / USD | Ethereum | `01d585327c000332` + 48 zeros |
| link | LINK / USD | Chainlink | `0101199b3b000332` + 48 zeros |
| usdt | USDT / USD | Tether | `016d06ebb6000332` + 48 zeros |
| usdc | USDC / USD | USD Coin | `01a80ff216000332` + 48 zeros |
| eurc | EURC / USD | EURC | `01962615c3000332` + 48 zeros |
| xaum | XAUM Reference Rate | Gold | `0197aabf9c000332` + 48 zeros (deviation 0.1) |
| flhy | FLHY / USD | labelled "Flare" by Chainlink, it is a tokenized bond ETF | `0142ac24bc000332` + 48 zeros |
| uspc | USPC NAV | Coinshift USPC NAV, category custom | `016e06407e000332` + 48 zeros |

- Testnet read on 9 Nov 18:56Z: XLM/USD answer `147519375000000000` (0.1475), round 2338, timestamp 1794249509. Reads by simulation cost nothing and need no secret key.
- Not SEP-40.

### Data Streams (pull)
- Verifier testnet `CA7GVHWH4GRHE6GI7MHEKQZAOYO4GE7KRGSU3EOS3HYJRVLX3XEA4ONQ`, mainnet `CAKA3NBYPC6OBEUEGNIYGNYG3ES2GPQK736B5SR7ASGUXRDAKXI2JCQI`. Source: github.com/smartcontractkit/data-streams-stellar (MIT), `contracts/verifier/src/lib.rs`, soroban-sdk 25.1.1.
  ```rust
  fn verify(env, signed_report: Bytes, sender: Address) -> Result<Bytes, ContractError>;
  fn is_initialized(env) -> bool; fn extend_contract_ttl(env);
  enum ContractError { NotInitialized = 2, ZeroAddress = 3, FaultToleranceMustBePositive = 4, ExcessSigners = 5, InsufficientSigners = 6, NonUniqueSignatures = 7, DigestEmpty = 8, DigestNotSet = 9, DigestInactive = 10, ConfigDigestAlreadySet = 11, BadVerification = 12, MismatchedSignatures = 13, IncorrectSignatureCount = 14, NoProposedOwner = 15, InvalidReportFormat = 16, SignatureRecoveryFailed = 17, InvalidProposedOwner = 18 }
  ```
  `verify` calls `sender.require_auth()`, extends its own TTLs (threshold 518,400 ledgers, extend to 1,555,200), parses the EVM ABI envelope, checks exactly f+1 unique secp256k1 signatures, emits a `verified` event with `(feed_id, sender)`, and returns `report_data`. It does not charge a fee and does not check freshness.
- The full signed report is `abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs, bytes32[] ss, bytes32 rawVs)`. `reportData` for schema v3 is 9 words: `feedId (bytes32)`, `validFromTimestamp (uint32)`, `observationsTimestamp (uint32)`, `nativeFee (uint192, legacy)`, `linkFee (uint192, legacy)`, `expiresAt (uint32)`, `price (int192)`, `bid (int192)`, `ask (int192)`; prices are 18 decimals.
- Chainlink's tutorial (docs.chain.link/data-streams/tutorials/stellar-onchain-report-verification) publishes one signed testnet report: ETH/USD v3, stream `0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782`. It is in `contracts/two-clocks/fixtures/streams-eth-usd-testnet-sample.hex` (736 bytes, one hex line, starts `00090d9e8d96765a`). Expected decode (verify in tests): `reportData` 288 bytes at byte offset 256 of the full report (length word at 224), validFrom = observations = 1775220938 (2026-04-03T12:55:38Z), expiresAt = 1777812938 (2026-05-03T12:55:38Z), price 2050.205901, bid 2050.188807, ask 2050.293175, two signatures (f = 1). Flipping byte 479 of the full report changes the low byte of the price and makes the verifier return `#12`. Sending it to the mainnet verifier returns `#9`.
- Stream ids (schema V3, name `<BASE>/USD-Streams-CexPrice`, from the keyless `/api/v1/discovery` catalog; the `feedId` field): testnet XLM/USD `0x00037dfe3b67b7552cf15e10ee5fb0c0ab6d658b20eb558effe2ae4579d24c58`, ETH/USD the sample's id above, BTC/USD `0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439`, LINK/USD `0x00036fe43f87884450b4c7e093cd5ed99cac6640d8c2000e6afc02c8838d0265`, USDT/USD and USDC/USD: take the V3 `-Streams-CexPrice` entry from `discovery-testnet.json`; mainnet XLM/USD `0x000358cb12b1f5bbeca8b5b4666025a40b15520af1f82516ee2fb9a335055e9a`, BTC `0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8`, ETH `0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9`, LINK `0x00036d7a1251e3f67d6658466b5e9e7fe8418af7feac9567ff322bff95cc2401`, USDC `0x00038f83323b6b08116d1614cf33a9bd71ab5e0abf0c9f1b783a74a43e7bd992`, USDT `0x0003a910a43485e0685ff5d6d366541f5c21150f0634c5b14254392d1a1c06db`. EURC, XAUM, FLHY and USPC have no stream. Ignore the `0x1003…` duplicates.

### Data Streams API and access
- REST testnet `https://api.testnet-dataengine.chain.link`, mainnet `https://api.dataengine.chain.link`. Endpoints: `GET /api/v1/discovery` (keyless catalog), `GET /api/v1/feeds` (feeds the account may read), `GET /api/v1/reports/latest?feedID=0x…`, `GET /api/v1/reports/bulk?feedIDs=a,b&timestamp=`, `GET /api/v1/reports/page?feedID=&startTimestamp=&limit=`, WebSocket `GET /api/v1/ws?feedIDs=`.
- Auth (HMAC): headers `Authorization: <username, a UUID>`, `X-Authorization-Timestamp: <unix ms>`, `X-Authorization-Signature-SHA256: hex(HMAC-SHA256(secret, "METHOD PATH_WITH_QUERY SHA256HEX(body) USERNAME TIMESTAMP"))`; empty body hashes as sha256 of the empty string. Timestamp must be within 5 s of the server. Send a browser-like `User-Agent`; without one Cloudflare answers 403 with body `error code: 1010`.
- Plans: no free tier since 1 September 2026 ("All Data Streams subscriptions are paid", from $150 per month per feed, Stripe, 30-day cycles). Credentials are per environment. Kaan's credentials on 9 Nov: mainnet `/api/v1/feeds` 200 `{"feeds":[]}`, `reports/latest` for any id 404 `{"message":"report not found"}`, `reports/bulk` 400 "at least one active feedID is required", `x-ratelimit-limit: 200`; testnet 401 `{"error":"user does not exist"}`. Without headers: 400 listing the missing headers.
- Candlestick API (OHLC history, no signatures, separate password): mainnet `https://priceapi.dataengine.chain.link`, testnet `https://priceapi.testnet-dataengine.chain.link`. `POST /api/v1/authorize` form `login=<username>&password=<candlestick key>` returns `{"s":"ok","d":{"access_token":"<jwt>","expiration":<unix s>}}` (about 24 h); then `Authorization: Bearer <jwt>`. `GET /api/v1/groups` (equities, crypto, forex), `GET /api/v1/symbol_info[?group=crypto]` (172 symbols, format `XLMUSD`, field `symbol` is a list), `GET /api/v1/history/rows?symbol=XLMUSD&resolution=1h&from=&to=` returns `{"s":"ok","candles":[[t,o,h,l,c,v],…]}` newest first, `GET /api/v1/history?…` returns columns `t,o,h,l,c,v`. Values are 18-decimal integers serialised as JSON numbers: XLM fits (`147087870178380500`) but ETH and BTC arrive as floats such as `2.1237031154468313e+21`, so `JSON.parse` loses precision. Kaan's key works on mainnet; testnet says 404 "user not found".

### Toolchain and accounts
- pnpm 11.6, node 24, rustc 1.95.0, stellar-cli 26.0.0, protocol 29 on both networks, target `wasm32v1-none`. Chainlink's own crates pin soroban-sdk 26.1.0 (proxy) and 25.1.1 (verifier); their tutorial says Rust 1.84 or later but not 1.91. We use soroban-sdk 29.0.1; if it does not build or call the proxy, pin 26.1.1 and record the fact in `friction-log-full.md`.
- Testnet identity `chainlink-fieldnote` = `GARGB3SHPUXQEFUNLCD67QLP4ABG4WVYM2KB3UURWA53ADAP7U6TEICC` (10,000 XLM, secret in `.env` as `STELLAR_SECRET`). Mainnet reads use `MAINNET_READER` (any funded public key) as simulation source.
- `.env` keys: `DATA_STREAMS_USERNAME`, `DATA_STREAMS_SECRET`, `CANDLESTICK_API_KEY`, `STELLAR_SECRET`. Never print them. Logs may show the first 8 characters of the username only.
- Reference copies (read-only, not committed): `/private/tmp/claude-501/-Users-kaankacar-usdt0test/7628fd76-75f7-4a0f-80f8-ad638349e45e/scratchpad/chainlink-ref/` holds the proxy trait (`…data_feeds_proxy.rs`), the verifier `lib.rs` and `errors.rs`, the tutorial markdown, the two feeds JSON files and `discovery-{testnet,mainnet}.json`.

## Decisions
- All transactions on testnet. Mainnet is read-only by simulation (recon, page toggle).
- The pull leg uses only the published sample report. The 401/404 story and the expired sample are findings.
- Sections 5 "Where I think this goes" and 6 "Try it yourself" are in this note.
- No feedback aimed at Stellar or SDF anywhere (repo or Drive). Stellar-side facts may appear in `friction-log-full.md` as plain rows with a workaround, never with an Ask.
- Card caption: `Chainlink on Stellar` / `No. 03` / `read / verify / compare` / `2026`.

## Repo layout
```
contracts/two-clocks/      Cargo.toml, src/{lib,state,error,clients,report,test}.rs, fixtures/streams-eth-usd-testnet-sample.hex
scripts/                   recon, deploy, refresh, submit, watch, verify-raw, read-feed (.ts)
scripts/lib/               log.ts (as is), stellar.ts (adapted), streams.ts, clocks.ts
src/lib/                   feeds.ts, report.ts (pure, shared with scripts and tests), networks.ts, contract.ts, format.ts, hooks.ts
src/components/            Header, Board, VerifyBox, HowItWorks, Footer, ui
src/deployments.json       written by deploy
tests/                     vitest: report, streams, feeds, stellar, format
docs/field-note/           chainlink-field-note.md, friction-log.md, friction-log-full.md, runs/, shots/, shots.mjs, assemble-video.sh, card/
```
`tsconfig.node.json` must include `src/lib` so scripts can import `../src/lib/feeds.ts` and `../src/lib/report.ts`.

## Contract `two-clocks` (`contracts/two-clocks`, crate `two-clocks`, wasm `two_clocks.wasm`)
`#![no_std]`, `crate-type = ["cdylib"]`, release profile as in `Cargo.toml` (copied from No. 02).

### Types (`state.rs`)
```rust
#[contracttype] pub struct Config { pub admin: Address, pub proxy: Address, pub verifier: Address, pub max_push_age_s: u64, pub max_pull_age_s: u64 }
#[contracttype] pub struct AssetInit { pub data_id: BytesN<32>, pub label: String, pub stream_id: Option<BytesN<32>> }
#[contracttype] pub struct AssetView { pub data_id: BytesN<32>, pub label: String, pub stream_id: Option<BytesN<32>> }
#[contracttype] pub struct PushLeg { pub answer: i128, pub round_id: u64, pub timestamp: u64, pub stored_at: u64 }          // answer at 18 decimals
#[contracttype] pub struct PullLeg { pub price: i128, pub bid: i128, pub ask: i128, pub valid_from: u64, pub observations_ts: u64, pub expires_at: u64, pub stream_id: BytesN<32>, pub stored_at: u64 }
#[contracttype] pub struct ReportV3 { pub stream_id: BytesN<32>, pub valid_from: u64, pub observations_ts: u64, pub expires_at: u64, pub price: i128, pub bid: i128, pub ask: i128 }
#[contracttype] pub struct Pair { pub push: Option<PushLeg>, pub pull: Option<PullLeg> }
#[contracttype] pub enum Source { Push, Pull }
#[contracttype] pub struct FreshPrice { pub price: i128, pub source: Source, pub timestamp: u64 }
#[contracttype] pub enum DataKey { Config, Assets, Meta(BytesN<32>), StreamOf(BytesN<32>), Push(BytesN<32>), Pull(BytesN<32>) }
```
Instance storage: `Config`, `Assets: Vec<BytesN<32>>` (max 32, `TooManyAssets`). Persistent: `Meta(data_id) -> AssetInit`-shaped `AssetMeta { label, stream_id }`, `StreamOf(stream_id) -> data_id`, `Push(data_id)`, `Pull(data_id)`.

TTL policy: `TTL_THRESHOLD = 518_400`, `TTL_EXTEND_TO = 1_555_200` ledgers (the verifier's own numbers, about 30 and 90 days). Every entry point calls `instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO)` (covers instance and code). Persistent entries get the same `extend_ttl` on write and on read. Rent is paid only when an entry is within 30 days of expiry. This is the deliberate contrast with No. 02, which extended to the maximum on every call.

### Errors (`error.rs`)
```rust
#[contracterror] #[repr(u32)] pub enum Error {
  // verifier pass-through, same codes and names as Chainlink's ContractError
  NotInitialized = 2, ZeroAddress = 3, FaultToleranceMustBePositive = 4, ExcessSigners = 5, InsufficientSigners = 6, NonUniqueSignatures = 7, DigestEmpty = 8, DigestNotSet = 9, DigestInactive = 10, ConfigDigestAlreadySet = 11, BadVerification = 12, MismatchedSignatures = 13, IncorrectSignatureCount = 14, NoProposedOwner = 15, InvalidReportFormat = 16, SignatureRecoveryFailed = 17, InvalidProposedOwner = 18,
  // our own
  Stale = 20, NothingNew = 21, NotFound = 22, Expired = 23, NotYetValid = 24, UnsupportedSchema = 25, MalformedReport = 26, Overflow = 27, UnknownAsset = 28, UnknownStream = 29, TooManyAssets = 30, ProxyInvokeFailed = 31, VerifierInvokeFailed = 32,
  // proxy pass-through
  NoDataPresent = 50, InvalidDecimals = 51, RoundsToZero = 52, FeedFrozen = 109,
}
```
Mapping: `try_latest_round` → `Err(Ok(e))` keeps the code; `Err(Err(InvokeError::Contract(109)))` → `FeedFrozen`; any other `Err(Err(_))` → `ProxyInvokeFailed`. `try_verify` → `Err(Ok(e))` keeps the code (2..18); other failures → `VerifierInvokeFailed`.

### Functions (`lib.rs`, `#[contract] pub struct TwoClocks`)
```rust
pub fn __constructor(env, admin: Address, proxy: Address, verifier: Address, max_push_age_s: u64, max_pull_age_s: u64, assets: Vec<AssetInit>)
pub fn set_stream(env, data_id: BytesN<32>, stream_id: BytesN<32>) -> Result<(), Error>   // admin.require_auth(); UnknownAsset if unknown
pub fn refresh(env, data_ids: Vec<BytesN<32>>) -> Result<u32, Error>
pub fn refresh_one(env, data_id: BytesN<32>) -> Result<PushLeg, Error>
pub fn submit_report(env, signed_report: Bytes) -> Result<PullLeg, Error>
pub fn verify_report(env, signed_report: Bytes) -> Result<ReportV3, Error>
pub fn latest(env, data_id: BytesN<32>) -> Result<Pair, Error>             // UnknownAsset if not configured
pub fn latest_many(env, data_ids: Vec<BytesN<32>>) -> Vec<Pair>            // unknown id gives Pair { None, None }
pub fn spread_bps(env, data_id: BytesN<32>) -> Result<i128, Error>         // (pull.price - push.answer) * 10_000 / push.answer, checked; NotFound if a leg is missing
pub fn fresh_price(env, data_id: BytesN<32>, max_age_s: u64) -> Result<FreshPrice, Error>
pub fn assets(env) -> Vec<AssetView>
pub fn config(env) -> Config
```
- `refresh_one(data_id)`: `UnknownAsset` if not configured. Call `proxy.try_latest_round(data_id, 18)`. `answer.to_i128()` or `Overflow`. Let `now = env.ledger().timestamp()`. `Stale` if `now > timestamp + max_push_age_s` or `timestamp > now + 60`. `NothingNew` if a stored leg has `round_id >= this round_id`. Store `PushLeg { answer, round_id, timestamp, stored_at: now }`, publish `PushEvent`, return the leg.
- `refresh(data_ids)`: runs `refresh_one` per id; `Stale` and `NothingNew` are skipped and counted, every other error fails the whole call; returns the number stored; `NothingNew` if that number is 0. Empty vec → `NothingNew`.
- `verify_report(signed_report)`: `verifier.try_verify(signed_report, env.current_contract_address())` (the contract is the direct invoker, so `require_auth` on its own address passes without user auth); decode the returned bytes with `report::decode_v3` (below); return the `ReportV3`. No storage write. This is the path the page's verify box and the expired sample take.
- `submit_report(signed_report)`: `verify_report`, then `data_id = StreamOf(stream_id)` or `UnknownStream`; `Expired` if `expires_at <= now`; `NotYetValid` if `observations_ts > now + 60`; `Stale` if `now > observations_ts + max_pull_age_s`; `NothingNew` if a stored leg has `observations_ts >= this`. Store `PullLeg`, publish `PullEvent`, return it.
- `fresh_price(data_id, max_age_s)`: candidates are the push leg (time `timestamp`) and the pull leg (time `observations_ts`, only if `expires_at > now`); pick the newest whose age is `<= max_age_s`; `Stale` if none; `UnknownAsset` if not configured.
- Events: `#[contractevent(topics = ["push"], data_format = "single-value")] pub struct PushEvent { #[topic] pub data_id: BytesN<32>, pub leg: PushLeg }` and the same shape `PullEvent` with topic `"pull"`.

### Report decoder (`report.rs`)
`pub fn decode_v3(env: &Env, data: &Bytes) -> Result<ReportV3, Error>`: length must be exactly 288 (`MalformedReport`); word 0 is the stream id, whose first two bytes must be `0x00 0x03` (`UnsupportedSchema`); words 1, 2 and 5 are u32 in the last 4 bytes with the first 28 bytes zero (`MalformedReport` otherwise); words 3 and 4 are ignored; words 6, 7, 8 are int192 values stored as 32-byte two's complement: the first 16 bytes must be all `0x00` or all `0xFF` (`Overflow` otherwise), the last 16 bytes give `i128::from_be_bytes`. No I256 arithmetic.

### `clients.rs`
The two traits above as `#[contractclient(name = "DataFeedsProxyClient")] pub trait DataFeedsProxy` (only the read functions we use) and `#[contractclient(name = "VerifierClient")] pub trait Verifier` with `verify`, plus `Round`, `ProxyReadError` (`#[contracterror]`) and `VerifierError` (`#[contracterror]`, codes 2..18) so `try_*` returns typed errors.

### Tests (`test.rs`, `cargo test --locked`)
Test-only contracts in the test module: `MockProxy` (a `Map<BytesN<32>, Round>` set by `set_round(data_id, answer: I256, round_id, timestamp)`, plus `set_mode(code: u32)` to return `ProxyReadError` 50/51/52 or `panic_with_error!(109)`), `MockVerifier` (modes: `extract` returns `reportData` cut from the ABI envelope by reading the offset at word 3; `echo` returns the input; `fail(code)` returns the verifier error). Cases: refresh stores and emits; second refresh `NothingNew`; older round never overwrites; stale and future rounds `Stale`; 50, 51, 52 and 109 pass through unchanged; `refresh` with mixed ids counts stored and skips; the fixture report stored by `submit_report` when the ledger time is `1775220938 + 1` (fields as in the facts); same report again `NothingNew`; at ledger time 2026-11-10 `Expired`; 287 bytes `MalformedReport`; schema `0x0006` `UnsupportedSchema`; unmapped stream `UnknownStream`; verifier 9, 12, 16 pass through; `verify_report` writes nothing; `spread_bps` sign and size; `fresh_price` picks the newest leg and gives `Stale` when none; TTL: a call above the threshold leaves TTLs unchanged, a call below it extends to the target; 33 assets `TooManyAssets`; `set_stream` needs admin auth (`mock_auths`). Load the fixture with `include_str!` and a small hex decoder (hex-literal cannot take `include_str!`).

## Shared TypeScript (`src/lib`)
- `feeds.ts`: `export interface Asset { key, label, assetName, dataId /* 64 hex, no 0x */, category: 'crypto' | 'stablecoin' | 'commodity' | 'rwa' | 'nav', deviationBps, streamIds: { testnet?: string; mainnet?: string } }`, `ASSETS` (the ten, in the table order), `HEARTBEAT_S = { testnet: 86355, mainnet: 86400 }`, `assetByKey`, `assetByDataId`, `assetByStreamId(net, id)`, `parseAssetKeys('all' | 'xlm,eth')`.
- `report.ts` (pure, no Node imports): `hexToBytes`, `bytesToHex`, `flipBit(bytes, index, bit = 0)`, `decodeFullReport(bytes) -> { context: Uint8Array[3], reportData: Uint8Array, rs: Uint8Array[], ss: Uint8Array[], rawVs: Uint8Array }` (ABI offsets, throws on bad layout), `decodeReportV3(reportData) -> { streamId: string (0x…), validFrom: number, observationsTs: number, expiresAt: number, nativeFee: bigint, linkFee: bigint, price: bigint, bid: bigint, ask: bigint }`, `isExpired(report, nowSec)`, `formatE18(value: bigint, fractionDigits = 6)`.
- `networks.ts`: `NETWORKS = { testnet: { rpcUrl: 'https://soroban-testnet.stellar.org', passphrase, explorer: 'testnet', proxy, verifier }, mainnet: { rpcUrl: 'https://mainnet.sorobanrpc.com', passphrase, explorer: 'public', proxy, verifier } }`, `DEPLOYMENTS` from `deployments.json`, `contractUrl`, `txUrl`.
- `contract.ts`: `simulate(net, contractId, method, args, source)` with a null-account fallback, typed readers `readLatestMany`, `readAssets`, `readConfig`, `simulateVerifyReport` (our contract), `simulateVerifierRaw` (the verifier itself, for mainnet `#9`), `simulateProxyLatestRound` (mainnet toggle), `ERROR_NAMES` for every code above and a `contractErrorCode(message)` parser.

`src/deployments.json` shape:
```json
{ "testnet": { "twoClocks": "C…", "proxy": "C…", "verifier": "C…", "maxPushAgeS": 90000, "maxPullAgeS": 120, "assets": ["xlm","btc","eth","link","usdt","usdc","eurc","xaum","flhy","uspc"], "deployedAt": "2026-11-10T..Z", "deployTx": "…", "reader": "G…" } }
```

## Scripts (`scripts/*.ts`, run as `pnpm <name> -- <flags>`; a leading `--` is stripped by `scriptArgs()`)
Common: `--log <path>` (ISO-stamped lines, `== Section` headers, as `log.ts` writes them; `shots.mjs` parses this format), `--help`, `--network testnet|mainnet` where relevant. `requireSendableNetwork` refuses mainnet for anything that signs. Secrets come from `.env` via `loadEnv()`; never logged.
- `recon.ts [--network both] [--skip-api] [--report <hex|path>]`: read-only, keyless where possible. Sections: `Stellar RPC` (both networks: ledger, protocol, passphrase); `Simulation sources`; `Data Feeds proxy` per network: `version`, `type_and_version`, then per asset `description`, `decimals`, `get_min_decimals`, `latest_round(18)` with price, round, feed time, age and heartbeat verdict; probes `#50` (unknown id) and `#51` (decimals 0) and the truncation at `decimals 8`; `Verifier` per network: `is_initialized`; `Sample report` decoded locally (sizes, dates, expired by N days); `verify_update by simulation`: the sample through the testnet verifier (288 bytes, identical to the local decode); `Tampered byte` (479 → `#12`); `Mainnet verifier` (same bytes → `#9`); `Data Streams API` (with credentials): `discovery` both environments with and without a User-Agent (status only), `/api/v1/feeds`, `reports/latest` for XLM/USD and ETH/USD on both environments with the exact status and body, rate-limit headers; `Candlestick`: mainnet authorize (expiry), `symbol_info` count and XLMUSD/ETHUSD presence, `history/rows ETHUSD 1h` last three candles exact and the `JSON.parse` float of the same text, testnet authorize status; `Summary`: `N/N sections ok`, `nothing was signed or sent`. Exit 1 if a section failed.
- `deploy.ts --network testnet [--max-push-age-s 90000] [--max-pull-age-s 120] [--assets all] [--wasm <path>]`: upload, create with constructor args (`admin` = signer, proxy and verifier from the network table, assets with testnet stream ids where known), `config()` and `assets()` check by simulation, write `src/deployments.json`, log fees and sizes.
- `refresh.ts --network testnet [--assets all] [--one]`: `refresh` with all ids in one transaction (or `refresh_one` each with `--one`); log stored count, per asset round, price, feed age, heartbeat countdown, fee, fetch-to-ledger latency, then `latest_many` read-back.
- `submit.ts --network testnet (--file <path> | --hex <hex>) [--peek] [--expect-expired]`: local decode, `verify_report` by simulation (decoded fields, expiry), then `submit_report` sent; with `--expect-expired` a `#23` exits 0 and prints both dates. Default file: the fixture.
- `watch.ts --network testnet --every 600 --minutes 120 [--assets all]`: loop `refresh`, one line per round (`stored n`, which assets moved and by how many bps, age vs heartbeat, fee, latency; `NothingNew` as skip), SIGINT finishes the round, `== Summary` (rounds, stored, skips, errors, total XLM, observed intervals). Run under `caffeinate -i`.
- `verify-raw.ts --network <net> (--file|--hex) [--tamper] [--tamper-byte 479]`: direct verifier simulation and decode; expected `#12` with `--tamper`, `#9` on mainnet.
- `read-feed.ts --network <net> --asset xlm [--decimals 18] [--round <n>]`: keyless proxy read for the README quickstart.
- `scripts/lib/streams.ts`: `signingString`, `hmacHeaders`, `streamsGet(env, path)` (never throws on HTTP errors; returns status, body, ms, rate-limit headers), `discovery`, `feedsList`, `latestReport`, `bulkReports`; candlestick `authorize`, `symbolInfo`, `historyRows` with exact-number parsing (a regex pass turns bare numeric literals into strings before `JSON.parse`) plus `jsonLossy` for the comparison.
- `scripts/lib/clocks.ts`: `clocksId`, `refreshAssets`, `submitReport`, `verifyReport`, `readLatestMany`, `describePair`.
- Vitest (`tests/`): `report.test.ts` (fixture offsets, dates, prices, `flipBit(479)` changes only the price word, bad layouts throw), `streams.test.ts` (signing string against a hand-computed HMAC vector, headers present incl. User-Agent, `stubFetch` for 401/404/429 bodies, exact candle parsing vs float loss), `feeds.test.ts` (64-hex ids, lookup helpers, keys parse), `stellar.test.ts` (mainnet guard, error names), `format.test.ts`.

## Web page (Vite 8 + React 19 + Tailwind 4, read-only, no wallet)
- `Header`: title "Two Clocks: Chainlink push and pull prices on Stellar", network toggle, links to the contract, proxy and verifier, both max ages.
- `Board`: one row per asset with three groups. Push: price, round, feed time, age, heartbeat countdown, pill fresh/due/stale (stale when age > max_push_age_s). Pull: price, bid, ask, observations time, expiry, pill; "no stream on this network" for eurc, xaum, flhy, uspc; "no accepted report yet: the only public sample expired 2026-05-03" otherwise. Spread in bps when both legs exist. Refresh every 10 s via `latest_many` simulation. Mainnet toggle: proxy `latest_round` by simulation for all ten assets, pull column "testnet only", no deployment.
- `VerifyBox`: textarea prefilled with the sample; "Verify by simulation" runs `verify_report` on our contract (testnet) or the raw verifier (mainnet, expect `#9`); "Flip byte 479" then verify (expect `#12`); shows decoded fields, an "expired N days ago" red pill, the would-be spread against the push leg, and the error name on failure.
- `HowItWorks`: read (one proxy, one id per feed, 18 decimals, min 8, errors 50 to 52), verify (f+1 signatures, `#9` across networks, `#12` on tamper, no freshness check), compare (two clocks, freshness is the consumer's job); copyable `stellar contract invoke … latest_round` and the HMAC signing string with placeholders.
- `Footer`: repo, Chainlink's three Stellar pages, Stellar oracle docs, "Field Note No. 03. Not affiliated with Chainlink Labs."

## Docs and hand-in (owner: Kaan's session)
- Writeup `docs/field-note/chainlink-field-note.md`: Attribution; 1 What I built; 2 How it went; 3 The mental model that made it click; 4 Friction log; 5 Where I think this goes; 6 Try it yourself. First person, short sentences, no em dashes, ISO Z timestamps, only numbers that carry a finding.
- `friction-log.md`: `# | While doing | What went wrong | Fix or workaround | Status`, rows C1… for Chainlink only, each Fix cell ends with "Ask: …", Status fixed / open / by design.
- `friction-log-full.md`: A Data Feeds proxy, B Verifier and reports, C Data Streams API and Candlestick, D Contract and SDK, E Running it on Stellar (facts with workarounds, no asks), F Docs and tooling.
- Stills `DR-5_chainlink-field-note_<NN>-<slug>.png`, video `DR-5_chainlink-field-note_<date>.mp4`, Drive `Demos + Field Notes/Chainlink`, Google Docs by rclone markdown import, repo `kaankacar/stellar-chainlink-demo` with Pages, Notion DR-5 Deliverable, Slack draft.

## Conventions
- Short sentences, active voice, no em dashes anywhere (code comments included).
- Commit messages: short, human, imperative, no AI attribution of any kind.
- Timestamps in ISO 8601 UTC with a `Z`. Amounts in XLM with 7 decimals when they matter.
- Code: strict TypeScript, no `any`, `noUncheckedIndexedAccess`; Rust `clippy -D warnings` clean; `#[contractevent]`, never `events().publish`.
- Every log line that mentions a transaction carries its hash and ledger.

## Addendum

**10 Nov 2026, build.** Contract deviations, all tested: `Pair` is defined twice, split on `cfg(target_family = "wasm")`, because an `Option<UserType>` field inside a `#[contracttype]` struct does not compile when soroban-sdk's `testutils` feature is on (stellar-xdr needs `Into<ScVal>`, which user types never get); the wasm build uses the macro, native builds use hand-written `TryFromVal` impls with the same layout. `export = false` is rejected by sdk 29 (the spec is pruned by reachability), so `Round`, `ProxyReadError` and `VerifierError` carry plain attributes and still stay out of the spec. `decode_v3` also checks that the sign of the low 16 bytes of an int192 agrees with the head, else `Overflow`. `spread_bps` answers `UnknownAsset` before `NotFound`. A repeated `data_id` in the constructor is listed once, the first entry wins. `set_stream` removes the old `StreamOf` entry. sdk 29's build script refuses `cargo build --target wasm32v1-none`; `stellar contract build` is the only build path. 28 tests. Wasm 23,770 bytes, sha256 `7ccdf4c461b1dbf76b2bd32c8ec96a261efe255dcefc0c3cb64a30c59d9a0d88`.

**10 Nov 2026, scripts.** No character of the Data Streams username reaches a log (the earlier allowance of 8 characters is withdrawn); API bodies that echo it are redacted. `networkInfo()` reads `getLatestLedger` and `getNetwork` by raw JSON-RPC because `@stellar/stellar-sdk` 17.2.1 throws `LedgerHeader.scpValue.ext.v: unknown enum value 3` on both networks. Testnet simulations use the field-note identity as source; mainnet uses `MAINNET_READER`. `submit()` caches the source account for simulations and retries on HTTP 429 (mainnet.sorobanrpc.com rate-limits after about 34 quick simulations; the testnet RPC answered in 3 to 4 s per call on 10 Nov). The recon section for the verifier is titled `verify by simulation (testnet verifier)`. Proxy and verifier read helpers live in `scripts/lib/clocks.ts`. 81 vitest tests.

**10 Nov 2026, facts that moved since 9 Nov.** Testnet runs protocol 30 (mainnet 29). Mainnet `reports/latest` now answers 401 `{"error":"feeds not authorized"}` for an unsubscribed stream (9 Nov: 404 `report not found`). The Cloudflare `error code: 1010` of 9 Nov (python urllib's default User-Agent) did not reproduce on 10 Nov with any User-Agent, including an empty one. Candlestick values are already in float notation in the response text, so the precision is lost on the server, not only in `JSON.parse`. `get_min_decimals` is 18 for `xaum` and `uspc`, 8 for the other eight. `symbol_info?group=crypto` lists 132 symbols (172 without the filter).

**10 Nov 2026, deployment.** Testnet `two-clocks` `CDJTBGMNA4T2Q4IALTUQVNSUTFHISVQIDKMKNKW26AYJIM5QWFQ3I4FP`, deployed 14:09:28Z (upload 1.5417094 XLM, create 18.6952377 XLM, 1 min 03 s), `max_push_age_s` 90000, `max_pull_age_s` 120, ten assets, six with testnet stream ids. Run 2 stored ten push legs in one transaction for 0.7125352 XLM. Run 3: `verify_report` returned the sample in 10.9 s by simulation, `submit_report` answered `#23 Expired` at the simulate stage, no fee.

**10 Nov 2026, docs.** `friction-log-full.md` has sections A to E; the docs and tooling rows sit in A6, B4 to B7 and C7, so there is no F. The short log has seven rows, C1 to C7.
