#![no_std]

//! Two Clocks: Chainlink push and pull prices on Stellar.
//!
//! One contract keeps two prices per asset. The push price is the latest
//! round of the Chainlink Data Feeds proxy. The pull price comes from a
//! Data Streams report that the Chainlink verifier contract checked. The
//! verifier does not check freshness, so this contract owns the freshness
//! rules and the replay protection for both legs.

use soroban_sdk::{
    contract, contractevent, contractimpl, panic_with_error, Address, Bytes, BytesN, Env,
    InvokeError, Vec,
};

pub mod clients;
mod error;
pub mod report;
mod state;

#[cfg(test)]
mod test;

pub use error::Error;
pub use state::{
    AssetInit, AssetMeta, AssetView, Config, DataKey, FreshPrice, Pair, PullLeg, PushLeg, ReportV3,
    Source, MAX_ASSETS, TTL_EXTEND_TO, TTL_THRESHOLD,
};

use clients::{DataFeedsProxyClient, VerifierClient};

/// Every feed stores 18 decimals. The contract always asks for all of them.
const FEED_DECIMALS: u32 = 18;
/// A feed time or observations time may run this far ahead of ledger time.
const FUTURE_SLACK_S: u64 = 60;
/// The proxy's cache error for a frozen feed. It arrives as a panic code,
/// not as a `ProxyReadError`.
const FEED_FROZEN_CODE: u32 = 109;
/// Basis points in one.
const BPS: i128 = 10_000;

/// Published once per stored push leg. Topics `("push", data_id)`, data `PushLeg`.
#[contractevent(topics = ["push"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PushEvent {
    #[topic]
    pub data_id: BytesN<32>,
    pub leg: PushLeg,
}

/// Published once per stored pull leg. Topics `("pull", data_id)`, data `PullLeg`.
#[contractevent(topics = ["pull"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PullEvent {
    #[topic]
    pub data_id: BytesN<32>,
    pub leg: PullLeg,
}

#[contract]
pub struct TwoClocks;

#[contractimpl]
impl TwoClocks {
    /// Store the settings and the asset table. At most 32 assets.
    pub fn __constructor(
        env: Env,
        admin: Address,
        proxy: Address,
        verifier: Address,
        max_push_age_s: u64,
        max_pull_age_s: u64,
        assets: Vec<AssetInit>,
    ) {
        if assets.len() > MAX_ASSETS {
            panic_with_error!(&env, Error::TooManyAssets);
        }
        state::set_config(
            &env,
            &Config {
                admin,
                proxy,
                verifier,
                max_push_age_s,
                max_pull_age_s,
            },
        );
        let mut ids: Vec<BytesN<32>> = Vec::new(&env);
        for asset in assets.iter() {
            // The first entry for a data id wins.
            if ids.contains(&asset.data_id) {
                continue;
            }
            ids.push_back(asset.data_id.clone());
            if let Some(stream_id) = &asset.stream_id {
                state::set_stream_of(&env, stream_id, &asset.data_id);
            }
            state::set_meta(
                &env,
                &asset.data_id,
                &AssetMeta {
                    label: asset.label,
                    stream_id: asset.stream_id,
                },
            );
        }
        state::set_assets(&env, &ids);
        state::extend_contract_ttl(&env);
    }

    /// Map a stream id to a configured asset. Admin only.
    pub fn set_stream(env: Env, data_id: BytesN<32>, stream_id: BytesN<32>) -> Result<(), Error> {
        state::extend_contract_ttl(&env);
        let config = state::get_config(&env);
        config.admin.require_auth();
        let mut meta = state::get_meta(&env, &data_id).ok_or(Error::UnknownAsset)?;
        if let Some(old) = &meta.stream_id {
            if *old != stream_id {
                state::remove_stream_of(&env, old);
            }
        }
        meta.stream_id = Some(stream_id.clone());
        state::set_meta(&env, &data_id, &meta);
        state::set_stream_of(&env, &stream_id, &data_id);
        Ok(())
    }

    /// Read the proxy for every id and store each round that is fresh and
    /// new. `Stale` and `NothingNew` skip the id; any other error fails
    /// the call. Returns the number stored. `NothingNew` if that is zero.
    pub fn refresh(env: Env, data_ids: Vec<BytesN<32>>) -> Result<u32, Error> {
        state::extend_contract_ttl(&env);
        let config = state::get_config(&env);
        let mut stored = 0u32;
        for data_id in data_ids.iter() {
            match refresh_push(&env, &config, &data_id) {
                Ok(_) => stored += 1,
                Err(Error::Stale | Error::NothingNew) => {}
                Err(err) => return Err(err),
            }
        }
        if stored == 0 {
            return Err(Error::NothingNew);
        }
        Ok(stored)
    }

    /// Read the proxy for one id and store the round. Fails with the
    /// reason when nothing is stored.
    pub fn refresh_one(env: Env, data_id: BytesN<32>) -> Result<PushLeg, Error> {
        state::extend_contract_ttl(&env);
        let config = state::get_config(&env);
        refresh_push(&env, &config, &data_id)
    }

    /// Verify a signed report and store it as the pull leg of the asset
    /// its stream maps to.
    pub fn submit_report(env: Env, signed_report: Bytes) -> Result<PullLeg, Error> {
        state::extend_contract_ttl(&env);
        let config = state::get_config(&env);
        let report = verify(&env, &config, &signed_report)?;
        let data_id = state::get_stream_of(&env, &report.stream_id).ok_or(Error::UnknownStream)?;

        let now = env.ledger().timestamp();
        if report.expires_at <= now {
            return Err(Error::Expired);
        }
        if report.observations_ts > now.saturating_add(FUTURE_SLACK_S) {
            return Err(Error::NotYetValid);
        }
        if now > report.observations_ts.saturating_add(config.max_pull_age_s) {
            return Err(Error::Stale);
        }
        if state::get_pull(&env, &data_id)
            .is_some_and(|prev| prev.observations_ts >= report.observations_ts)
        {
            return Err(Error::NothingNew);
        }

        let leg = PullLeg {
            price: report.price,
            bid: report.bid,
            ask: report.ask,
            valid_from: report.valid_from,
            observations_ts: report.observations_ts,
            expires_at: report.expires_at,
            stream_id: report.stream_id,
            stored_at: now,
        };
        state::set_pull(&env, &data_id, &leg);
        PullEvent {
            data_id,
            leg: leg.clone(),
        }
        .publish(&env);
        Ok(leg)
    }

    /// Verify a signed report and decode it. Writes nothing, so an
    /// expired report still returns its fields.
    pub fn verify_report(env: Env, signed_report: Bytes) -> Result<ReportV3, Error> {
        state::extend_contract_ttl(&env);
        let config = state::get_config(&env);
        verify(&env, &config, &signed_report)
    }

    /// Both legs of one configured asset.
    pub fn latest(env: Env, data_id: BytesN<32>) -> Result<Pair, Error> {
        state::extend_contract_ttl(&env);
        state::get_meta(&env, &data_id).ok_or(Error::UnknownAsset)?;
        Ok(pair(&env, &data_id))
    }

    /// Both legs of many ids. An unknown id gives two `None`s.
    pub fn latest_many(env: Env, data_ids: Vec<BytesN<32>>) -> Vec<Pair> {
        state::extend_contract_ttl(&env);
        let mut out = Vec::new(&env);
        for data_id in data_ids.iter() {
            out.push_back(pair(&env, &data_id));
        }
        out
    }

    /// Pull price against push price in basis points, truncated toward
    /// zero. `NotFound` if a leg is missing.
    pub fn spread_bps(env: Env, data_id: BytesN<32>) -> Result<i128, Error> {
        state::extend_contract_ttl(&env);
        state::get_meta(&env, &data_id).ok_or(Error::UnknownAsset)?;
        let push = state::get_push(&env, &data_id).ok_or(Error::NotFound)?;
        let pull = state::get_pull(&env, &data_id).ok_or(Error::NotFound)?;
        pull.price
            .checked_sub(push.answer)
            .and_then(|diff| diff.checked_mul(BPS))
            .and_then(|scaled| scaled.checked_div(push.answer))
            .ok_or(Error::Overflow)
    }

    /// The newest leg whose age is at most `max_age_s`. The push leg is
    /// aged by its feed time, the pull leg by its observations time, and
    /// an expired pull leg does not count. `Stale` if neither qualifies.
    pub fn fresh_price(env: Env, data_id: BytesN<32>, max_age_s: u64) -> Result<FreshPrice, Error> {
        state::extend_contract_ttl(&env);
        state::get_meta(&env, &data_id).ok_or(Error::UnknownAsset)?;
        let now = env.ledger().timestamp();

        let mut best: Option<FreshPrice> = None;
        if let Some(push) = state::get_push(&env, &data_id) {
            if now.saturating_sub(push.timestamp) <= max_age_s {
                best = Some(FreshPrice {
                    price: push.answer,
                    source: Source::Push,
                    timestamp: push.timestamp,
                });
            }
        }
        if let Some(pull) = state::get_pull(&env, &data_id) {
            let fresh =
                pull.expires_at > now && now.saturating_sub(pull.observations_ts) <= max_age_s;
            let newer = best
                .as_ref()
                .is_none_or(|b| pull.observations_ts > b.timestamp);
            if fresh && newer {
                best = Some(FreshPrice {
                    price: pull.price,
                    source: Source::Pull,
                    timestamp: pull.observations_ts,
                });
            }
        }
        best.ok_or(Error::Stale)
    }

    /// The configured assets, in constructor order.
    pub fn assets(env: Env) -> Vec<AssetView> {
        state::extend_contract_ttl(&env);
        let mut out = Vec::new(&env);
        for data_id in state::get_assets(&env).iter() {
            if let Some(meta) = state::get_meta(&env, &data_id) {
                out.push_back(AssetView {
                    data_id,
                    label: meta.label,
                    stream_id: meta.stream_id,
                });
            }
        }
        out
    }

    /// The deployment settings.
    pub fn config(env: Env) -> Config {
        state::extend_contract_ttl(&env);
        state::get_config(&env)
    }
}

/// Read the latest round of one configured asset and store it when it is
/// fresh and newer than the stored round.
fn refresh_push(env: &Env, config: &Config, data_id: &BytesN<32>) -> Result<PushLeg, Error> {
    state::get_meta(env, data_id).ok_or(Error::UnknownAsset)?;

    let proxy = DataFeedsProxyClient::new(env, &config.proxy);
    let round = match proxy.try_latest_round(data_id, &FEED_DECIMALS) {
        Ok(Ok(round)) => round,
        Ok(Err(_)) => return Err(Error::ProxyInvokeFailed),
        Err(Ok(code)) => return Err(code.into()),
        Err(Err(InvokeError::Contract(FEED_FROZEN_CODE))) => return Err(Error::FeedFrozen),
        Err(Err(_)) => return Err(Error::ProxyInvokeFailed),
    };
    let answer = round.answer.to_i128().ok_or(Error::Overflow)?;

    let now = env.ledger().timestamp();
    if now > round.timestamp.saturating_add(config.max_push_age_s)
        || round.timestamp > now.saturating_add(FUTURE_SLACK_S)
    {
        return Err(Error::Stale);
    }
    if state::get_push(env, data_id).is_some_and(|prev| prev.round_id >= round.round_id) {
        return Err(Error::NothingNew);
    }

    let leg = PushLeg {
        answer,
        round_id: round.round_id,
        timestamp: round.timestamp,
        stored_at: now,
    };
    state::set_push(env, data_id, &leg);
    PushEvent {
        data_id: data_id.clone(),
        leg: leg.clone(),
    }
    .publish(env);
    Ok(leg)
}

/// Hand the signed report to the verifier with this contract as the
/// sender. The contract is the direct invoker, so the verifier's
/// `require_auth` on that address passes without user auth. Then decode
/// the `report_data` it returns.
fn verify(env: &Env, config: &Config, signed_report: &Bytes) -> Result<ReportV3, Error> {
    let verifier = VerifierClient::new(env, &config.verifier);
    let data = match verifier.try_verify(signed_report, &env.current_contract_address()) {
        Ok(Ok(data)) => data,
        Ok(Err(_)) => return Err(Error::VerifierInvokeFailed),
        Err(Ok(code)) => return Err(code.into()),
        Err(Err(_)) => return Err(Error::VerifierInvokeFailed),
    };
    report::decode_v3(env, &data)
}

fn pair(env: &Env, data_id: &BytesN<32>) -> Pair {
    Pair {
        push: state::get_push(env, data_id),
        pull: state::get_pull(env, data_id),
    }
}
