# Appendix: Pyth Pro, Chainlink Data Feeds and Reflector, side by side

The two field notes read Pyth Pro and Chainlink Data Feeds from a Soroban contract. Reflector is the third oracle on Stellar, and the one most protocols here already use, so this appendix puts the three next to each other. Everything below was read on 12 November 2026 at 14:51 UTC by simulation, with no key and no transaction; the log is `runs/run6-reflector-compare.log`. Reflector's public oracles are the free ReflectorPulse contracts; its ReflectorBeam oracles, with faster updates and prepaid access in XRF, are not covered here.

| | Chainlink Data Feeds | Reflector (public Pulse oracles) | Pyth Pro |
|---|---|---|---|
| Model | Push. Chainlink's network writes the price into one proxy contract. | Push. Reflector's nodes write every price every 5 minutes. | Pull. You fetch a signed update off-chain and bring it on chain; Pyth's verifier checks the signatures. |
| Where the price lives | One proxy per network, every feed behind it, picked by a 32-byte `data_id`. | One contract per data source: external CEXs and DEXs, the Stellar DEX, and FX rates. Pick by asset symbol or Stellar asset. | Nowhere until your transaction brings it. The verifier holds only the trusted signer. |
| Interface | `latest_round(data_id, decimals)`, `get_round`, `description`. Not SEP-40. | SEP-40: `lastprice(asset)`, `price(asset, ts)`, `prices(asset, n)`, `resolution`, `decimals`, `assets`, `last_timestamp`. | `verify_update(bytes)` returns the payload; you decode the feeds yourself. |
| Decimals | 18 for every feed. Fewer truncates; two feeds refuse anything below 18. | 14 for every asset in a contract. | Per feed exponent: -8 for crypto, -5 for FX, -3 for gold. |
| Update rule | 0.5 percent deviation or a 24-hour heartbeat (0.1 percent for gold). | Every 5 minutes (`resolution` 300 s); timestamps are floored to the 5-minute grid. | Whenever you push one. The REST API serves updates on 50 ms to 1 s channels. |
| Freshness check you write | Compare the round's `timestamp` with ledger time against the heartbeat. | Compare `timestamp` with ledger time against `resolution`; two missed ticks mean a stalled feed. | Compare `feedUpdateTimestamp` with ledger time, and skip carried-forward feeds. |
| Feed gap behaviour | The proxy returns the last round, however old. A frozen feed panics with `#109`. | `lastprice` keeps the old timestamp; `price(asset, ts)` for a missed tick returns `None`. An unknown asset returns `None`. | The verifier accepts any update Pyth ever signed; your contract rejects stale ones. |
| Cost to read | Free by simulation; one cross-contract call in a consumer. | Free on the public contracts; Beam access is prepaid in XRF per asset. | Subscription from $500 per month (14-day trial), plus the transaction that verifies. |
| Key needed | No. | No, for the public oracles. | Yes. |
| Assets today | 10 USD feeds: XLM, BTC, ETH, LINK, USDT, USDC, EURC, XAUM, FLHY, USPC NAV. | 16 on the CEX and DEX contract (BTC, ETH, USDT, XRP, SOL, USDC, ADA, AVAX, XLM and more); the Stellar DEX contract quotes in USDC; an FX contract. | 3,896 symbols in the catalog; 8 on a free key, XLM/USD from the Starter plan. |
| Networks | Mainnet and testnet, same ids. | Mainnet and testnet, three public contracts each. | Mainnet and testnet verifiers, same signer. |
| History on chain | `get_round(round_id)` while the round lives, about 180 days. | 24 hours (`history_retention_period` 86400 s), `prices(asset, n)`. | None. History comes from the REST API with a key. |
| XLM/USD at 14:51 UTC, 12 November | Mainnet 0.143783, round 2557, dated 14:36:00, 16 minutes old. | Mainnet 0.143692, dated 14:50:00, 2 minutes old. Testnet 0.143686. | No price without a key; the free trial ended on 9 November. |

Three things the table taught me.

**The same price, 6 basis points and 14 minutes apart.** Chainlink's mainnet XLM/USD and Reflector's differed by 6.3 basis points at the same moment, and the Chainlink round was 14 minutes older than the Reflector tick. Neither is wrong. Chainlink moves on a 0.5 percent trigger, Reflector on a 5-minute clock. A lending protocol that liquidates on one of them will liquidate at a different second than one that reads the other. Two sources and a divergence check is the Stellar docs' advice, and this is what the divergence looks like on a quiet afternoon.

**Staleness is the same question with three different answers.** Each oracle gives you a timestamp and leaves the comparison to you. For Chainlink the yardstick is the heartbeat, 24 hours, so a feed can be hours old and valid. For Reflector it is the resolution, 5 minutes, so anything older than two ticks is a stalled feed. For Pyth it is the feed's own update time, and a closed market keeps the old one. SEP-40 makes the Reflector case the easiest to write: `lastprice` plus `resolution` is the whole rule, and `price(asset, ts)` tells you whether a tick exists instead of making you guess.

**Feed lists change under you.** Reflector's `assets()` is a live list, Chainlink's feed list went from nine to ten in October, and a Pyth key reaches a different set of feeds than the catalog shows. A consumer that hard-codes "this symbol exists" will one day read a `None`, a `#50`, or a `403`. Read the list at runtime, treat an unknown asset as no price, and never as zero.

Two Clocks keeps one column per Chainlink leg and has an empty one waiting for a second source. Reflector's `lastprice` is one cross-contract call away from filling it; the freshness rule in `fresh_price` already takes a per-source window, and 300 seconds is the number for a Pulse oracle.

Not affiliated with Chainlink Labs, Pyth Network, Douro Labs or Reflector.
