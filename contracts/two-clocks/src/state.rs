//! Storage types and helpers.

use soroban_sdk::{contracttype, Address, BytesN, Env, IntoVal, String, TryFromVal, Val, Vec};

/// Extend an entry when its TTL is at or below this many ledgers. About
/// 30 days at 5 s per ledger. The verifier uses the same number.
pub const TTL_THRESHOLD: u32 = 518_400;
/// Extend an entry to this TTL. About 90 days. Rent is paid only when an
/// entry is within 30 days of expiry.
pub const TTL_EXTEND_TO: u32 = 1_555_200;
/// Hard cap on configured assets.
pub const MAX_ASSETS: u32 = 32;

/// Deployment settings. Instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// May call `set_stream`.
    pub admin: Address,
    /// The Chainlink Data Feeds proxy.
    pub proxy: Address,
    /// The Chainlink Data Streams verifier.
    pub verifier: Address,
    /// Max age of a proxy round, seconds.
    pub max_push_age_s: u64,
    /// Max age of a report's observations time, seconds.
    pub max_pull_age_s: u64,
}

/// One asset as the constructor takes it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetInit {
    /// Data Feeds id, same on both networks.
    pub data_id: BytesN<32>,
    /// Feed name, such as "XLM / USD".
    pub label: String,
    /// Data Streams id, where a stream exists.
    pub stream_id: Option<BytesN<32>>,
}

/// One asset as `assets()` returns it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetView {
    pub data_id: BytesN<32>,
    pub label: String,
    pub stream_id: Option<BytesN<32>>,
}

/// What the contract keeps per asset. Persistent, under `Meta(data_id)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetMeta {
    pub label: String,
    pub stream_id: Option<BytesN<32>>,
}

/// The push price: the latest proxy round the contract stored.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PushLeg {
    /// Price with 18 decimals.
    pub answer: i128,
    pub round_id: u64,
    /// Feed time, unix seconds.
    pub timestamp: u64,
    /// Ledger close time when the contract stored it, seconds.
    pub stored_at: u64,
}

/// The pull price: the latest verified report the contract stored.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PullLeg {
    /// Prices with 18 decimals.
    pub price: i128,
    pub bid: i128,
    pub ask: i128,
    pub valid_from: u64,
    pub observations_ts: u64,
    pub expires_at: u64,
    pub stream_id: BytesN<32>,
    /// Ledger close time when the contract stored it, seconds.
    pub stored_at: u64,
}

/// A decoded schema v3 report. The two legacy fee words are dropped.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReportV3 {
    pub stream_id: BytesN<32>,
    pub valid_from: u64,
    pub observations_ts: u64,
    pub expires_at: u64,
    pub price: i128,
    pub bid: i128,
    pub ask: i128,
}

/// Both legs of one asset. A leg is `None` until the first store.
#[cfg(target_family = "wasm")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pair {
    pub push: Option<PushLeg>,
    pub pull: Option<PullLeg>,
}

/// The same type for native builds. With `testutils` on, which every
/// native test or clippy build unifies in, `contracttype` also emits XDR
/// conversions, and those cannot hold an `Option` of a user type:
/// stellar-xdr wants `Into<ScVal>` for the inner type, while user types
/// only get `TryFrom`. The hand-written conversions in `pair_conversions`
/// build the same map as the macro: keys `pull` and `push`, a void for a
/// missing leg. The wasm build above carries the spec entry.
#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pair {
    pub push: Option<PushLeg>,
    pub pull: Option<PullLeg>,
}

#[cfg(not(target_family = "wasm"))]
mod pair_conversions {
    use soroban_sdk::{
        ConversionError, Env, EnvBase, MapObject, SpecShakingMarker, TryFromVal, TryIntoVal, Val,
    };

    use super::Pair;

    /// Sorted, as the macro sorts struct fields by name.
    const KEYS: [&str; 2] = ["pull", "push"];

    /// No spec to keep alive in a native build.
    impl SpecShakingMarker for Pair {}

    impl TryFromVal<Env, Val> for Pair {
        type Error = ConversionError;

        fn try_from_val(env: &Env, val: &Val) -> Result<Self, ConversionError> {
            let mut vals: [Val; 2] = [Val::VOID.to_val(); 2];
            let map: MapObject = val.try_into().map_err(|_| ConversionError)?;
            env.sparse_map_unpack_to_slice(map, &KEYS, &mut vals)
                .map_err(|_| ConversionError)?;
            Ok(Self {
                pull: vals[0].try_into_val(env).map_err(|_| ConversionError)?,
                push: vals[1].try_into_val(env).map_err(|_| ConversionError)?,
            })
        }
    }

    impl TryFromVal<Env, Pair> for Val {
        type Error = ConversionError;

        fn try_from_val(env: &Env, val: &Pair) -> Result<Self, ConversionError> {
            let vals: [Val; 2] = [
                val.pull.try_into_val(env).map_err(|_| ConversionError)?,
                val.push.try_into_val(env).map_err(|_| ConversionError)?,
            ];
            Ok(env
                .map_new_from_slices(&KEYS, &vals)
                .map_err(|_| ConversionError)?
                .into())
        }
    }

    impl TryFromVal<Env, &Pair> for Val {
        type Error = ConversionError;

        fn try_from_val(env: &Env, val: &&Pair) -> Result<Self, ConversionError> {
            <_ as TryFromVal<Env, Pair>>::try_from_val(env, *val)
        }
    }
}

/// Which leg `fresh_price` picked.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Source {
    Push,
    Pull,
}

/// The newest leg inside a max age.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FreshPrice {
    pub price: i128,
    pub source: Source,
    /// Feed time of the push leg, or observations time of the pull leg.
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// `Config`, instance storage.
    Config,
    /// `Vec<BytesN<32>>` of configured data ids, instance storage.
    Assets,
    /// `AssetMeta` per data id, persistent.
    Meta(BytesN<32>),
    /// Data id per stream id, persistent.
    StreamOf(BytesN<32>),
    /// `PushLeg` per data id, persistent.
    Push(BytesN<32>),
    /// `PullLeg` per data id, persistent.
    Pull(BytesN<32>),
}

pub fn set_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
}

pub fn get_config(env: &Env) -> Config {
    env.storage().instance().get(&DataKey::Config).unwrap()
}

pub fn get_assets(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .instance()
        .get(&DataKey::Assets)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_assets(env: &Env, assets: &Vec<BytesN<32>>) {
    env.storage().instance().set(&DataKey::Assets, assets);
}

pub fn get_meta(env: &Env, data_id: &BytesN<32>) -> Option<AssetMeta> {
    get_persistent(env, &DataKey::Meta(data_id.clone()))
}

pub fn set_meta(env: &Env, data_id: &BytesN<32>, meta: &AssetMeta) {
    set_persistent(env, &DataKey::Meta(data_id.clone()), meta);
}

pub fn get_stream_of(env: &Env, stream_id: &BytesN<32>) -> Option<BytesN<32>> {
    get_persistent(env, &DataKey::StreamOf(stream_id.clone()))
}

pub fn set_stream_of(env: &Env, stream_id: &BytesN<32>, data_id: &BytesN<32>) {
    set_persistent(env, &DataKey::StreamOf(stream_id.clone()), data_id);
}

pub fn remove_stream_of(env: &Env, stream_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::StreamOf(stream_id.clone()));
}

pub fn get_push(env: &Env, data_id: &BytesN<32>) -> Option<PushLeg> {
    get_persistent(env, &DataKey::Push(data_id.clone()))
}

pub fn set_push(env: &Env, data_id: &BytesN<32>, leg: &PushLeg) {
    set_persistent(env, &DataKey::Push(data_id.clone()), leg);
}

pub fn get_pull(env: &Env, data_id: &BytesN<32>) -> Option<PullLeg> {
    get_persistent(env, &DataKey::Pull(data_id.clone()))
}

pub fn set_pull(env: &Env, data_id: &BytesN<32>, leg: &PullLeg) {
    set_persistent(env, &DataKey::Pull(data_id.clone()), leg);
}

/// Read a persistent entry. Extend its TTL when it exists and is within
/// `TTL_THRESHOLD` of expiry.
fn get_persistent<V: TryFromVal<Env, Val>>(env: &Env, key: &DataKey) -> Option<V> {
    let storage = env.storage().persistent();
    let value: Option<V> = storage.get(key);
    if value.is_some() {
        storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
    value
}

/// Write a persistent entry and apply the same TTL rule.
fn set_persistent<V: IntoVal<Env, Val>>(env: &Env, key: &DataKey, value: &V) {
    let storage = env.storage().persistent();
    storage.set(key, value);
    storage.extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

/// Extend the TTL of the contract instance and of its wasm code when they
/// are within `TTL_THRESHOLD` of expiry. Every entry point calls this. A
/// simulated read persists nothing.
pub fn extend_contract_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}
