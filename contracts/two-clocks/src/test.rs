//! Unit tests. Two test-only contracts stand in for Chainlink's proxy and
//! verifier, so the tests control rounds, error codes and report bytes.
//! The fixture is the signed testnet report from Chainlink's tutorial. The
//! mock verifier cuts `report_data` out of it the way the real one does,
//! without checking the signatures.

extern crate alloc;

use alloc::vec::Vec as StdVec;

use hex_literal::hex;
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{
    Address as _, Deployer as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, symbol_short, vec, Address, Bytes,
    BytesN, Env, IntoVal, InvokeError, Map, String, Symbol, Val, Vec, I256,
};

use crate::clients::{ProxyReadError, Round, VerifierError};
use crate::report::decode_v3;
use crate::{
    AssetInit, AssetView, Config, DataKey, Error, FreshPrice, Pair, PullLeg, PushLeg, ReportV3,
    Source, TwoClocks, TwoClocksClient, MAX_ASSETS, TTL_EXTEND_TO, TTL_THRESHOLD,
};

/// Signed ETH/USD testnet report from Chainlink's tutorial, 736 bytes.
const FIXTURE_HEX: &str = include_str!("../fixtures/streams-eth-usd-testnet-sample.hex");
/// validFromTimestamp and observationsTimestamp of the fixture: 2026-04-03T12:55:38Z.
const FIXTURE_TS: u64 = 1_775_220_938;
/// expiresAt of the fixture: 2026-05-03T12:55:38Z.
const FIXTURE_EXPIRES_AT: u64 = 1_777_812_938;
/// Prices of the fixture, 18 decimals.
const FIXTURE_PRICE: i128 = 2_050_205_901_383_697_350_000;
const FIXTURE_BID: i128 = 2_050_188_807_755_923_400_000;
const FIXTURE_ASK: i128 = 2_050_293_175_000_000_000_000;
/// Byte offset of `report_data` inside the fixture, and of its length word.
const FIXTURE_DATA_START: usize = 256;
const FIXTURE_DATA_LEN_AT: usize = 224;
/// Ledger time of most tests: one second after the fixture.
const LEDGER_S: u64 = FIXTURE_TS + 1;
/// 2026-11-10T00:00:00Z.
const NOV_10_2026: u64 = 1_794_268_800;
const MAX_PUSH_AGE_S: u64 = 90_000;
const MAX_PULL_AGE_S: u64 = 120;
/// One unit with 18 decimals.
const E18: i128 = 1_000_000_000_000_000_000;

const XLM_ID: [u8; 32] = hex!("017be2f55a000332000000000000000000000000000000000000000000000000");
const BTC_ID: [u8; 32] = hex!("01a0b4d920000332000000000000000000000000000000000000000000000000");
const ETH_ID: [u8; 32] = hex!("01d585327c000332000000000000000000000000000000000000000000000000");
/// Testnet stream ids. ETH's is the fixture's.
const XLM_STREAM: [u8; 32] =
    hex!("00037dfe3b67b7552cf15e10ee5fb0c0ab6d658b20eb558effe2ae4579d24c58");
const BTC_STREAM: [u8; 32] =
    hex!("00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439");
const ETH_STREAM: [u8; 32] =
    hex!("000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782");
/// XLM/USD testnet round read on 9 November 2026: 0.1475 USD.
const XLM_ANSWER: i128 = 147_519_375_000_000_000;
const XLM_ROUND: u64 = 2338;

const ROUNDS: Symbol = symbol_short!("rounds");
const MODE: Symbol = symbol_short!("mode");
const SENDER: Symbol = symbol_short!("sender");

// ── Test-only Chainlink contracts ──

/// Stands in for the Data Feeds proxy. Rounds are set per data id. A mode
/// of 50, 51 or 52 returns that `ProxyReadError`. Mode 109 panics with the
/// cache error of a frozen feed, like the real proxy.
#[contract]
pub struct MockProxy;

#[contractimpl]
impl MockProxy {
    pub fn set_round(env: Env, data_id: BytesN<32>, answer: I256, round_id: u64, timestamp: u64) {
        let mut rounds = Self::rounds(&env);
        rounds.set(
            data_id,
            Round {
                answer,
                round_id,
                timestamp,
            },
        );
        env.storage().instance().set(&ROUNDS, &rounds);
    }

    pub fn set_mode(env: Env, code: u32) {
        env.storage().instance().set(&MODE, &code);
    }

    pub fn latest_round(
        env: Env,
        data_id: BytesN<32>,
        decimals: u32,
    ) -> Result<Round, ProxyReadError> {
        let mode: u32 = env.storage().instance().get(&MODE).unwrap_or(0);
        match mode {
            50 => return Err(ProxyReadError::NoDataPresent),
            51 => return Err(ProxyReadError::InvalidDecimals),
            52 => return Err(ProxyReadError::RoundsToZero),
            109 => panic_with_error!(&env, soroban_sdk::Error::from_contract_error(109)),
            _ => {}
        }
        // The contract must ask for all 18 decimals.
        if decimals != 18 {
            return Err(ProxyReadError::InvalidDecimals);
        }
        Self::rounds(&env)
            .get(data_id)
            .ok_or(ProxyReadError::NoDataPresent)
    }

    fn rounds(env: &Env) -> Map<BytesN<32>, Round> {
        env.storage()
            .instance()
            .get(&ROUNDS)
            .unwrap_or_else(|| Map::new(env))
    }
}

/// How the mock verifier answers.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerifyMode {
    /// Return `report_data` cut from the ABI envelope.
    Extract,
    /// Return the input as is, for hand-built report data.
    Echo,
    /// Return this verifier error code.
    Fail(u32),
}

/// Stands in for the Data Streams verifier. It requires the sender's auth
/// like the real one, records the sender and never checks signatures.
#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn set_mode(env: Env, mode: VerifyMode) {
        env.storage().instance().set(&MODE, &mode);
    }

    pub fn last_sender(env: Env) -> Option<Address> {
        env.storage().instance().get(&SENDER)
    }

    pub fn verify(env: Env, signed_report: Bytes, sender: Address) -> Result<Bytes, VerifierError> {
        sender.require_auth();
        env.storage().instance().set(&SENDER, &sender);
        let mode: VerifyMode = env
            .storage()
            .instance()
            .get(&MODE)
            .unwrap_or(VerifyMode::Extract);
        match mode {
            VerifyMode::Extract => Ok(extract_report_data(&env, &signed_report)),
            VerifyMode::Echo => Ok(signed_report),
            VerifyMode::Fail(code) => Err(verifier_error(code)),
        }
    }
}

fn verifier_error(code: u32) -> VerifierError {
    VerifierError::try_from(soroban_sdk::Error::from_contract_error(code))
        .expect("a verifier error code")
}

/// Cut `report_data` out of
/// `abi.encode(bytes32[3] reportContext, bytes reportData, bytes32[] rs, bytes32[] ss, bytes32 rawVs)`.
/// Word 3 holds the byte offset of the length word. The data follows it.
fn extract_report_data(env: &Env, full: &Bytes) -> Bytes {
    let raw = full.to_alloc_vec();
    let offset = u32_at(&raw, 3 * 32);
    let len = u32_at(&raw, offset);
    let start = offset + 32;
    Bytes::from_slice(env, &raw[start..start + len])
}

/// The low four bytes of the 32-byte word at `pos`.
fn u32_at(raw: &[u8], pos: usize) -> usize {
    let mut tail = [0u8; 4];
    tail.copy_from_slice(&raw[pos + 28..pos + 32]);
    u32::from_be_bytes(tail) as usize
}

// ── Fixture and report builders ──

fn decode_hex(text: &str) -> StdVec<u8> {
    let digits: StdVec<u8> = text
        .trim()
        .bytes()
        .map(|c| match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("fixture holds a non-hex byte"),
        })
        .collect();
    assert_eq!(digits.len() % 2, 0, "fixture has an odd digit count");
    digits
        .chunks(2)
        .map(|pair| (pair[0] << 4) | pair[1])
        .collect()
}

fn fixture_raw() -> StdVec<u8> {
    decode_hex(FIXTURE_HEX)
}

fn fixture(env: &Env) -> Bytes {
    Bytes::from_slice(env, &fixture_raw())
}

/// The 288 `report_data` bytes of the fixture.
fn fixture_report_data(env: &Env) -> Bytes {
    Bytes::from_slice(
        env,
        &fixture_raw()[FIXTURE_DATA_START..FIXTURE_DATA_START + 288],
    )
}

/// A v3 report before encoding.
#[derive(Clone, Copy)]
struct RawReport {
    stream: [u8; 32],
    valid_from: u64,
    observations_ts: u64,
    expires_at: u64,
    price: i128,
    bid: i128,
    ask: i128,
}

/// A report observed at `observations_ts` that expires 30 days later.
fn raw_report(stream: [u8; 32], observations_ts: u64, price: i128) -> RawReport {
    RawReport {
        stream,
        valid_from: observations_ts,
        observations_ts,
        expires_at: observations_ts + 30 * 86_400,
        price,
        bid: price - E18 / 1_000,
        ask: price + E18 / 1_000,
    }
}

/// Nine ABI words: timestamps right-aligned, prices as 32-byte two's complement.
fn encode_words(r: &RawReport) -> [u8; 288] {
    let mut out = [0u8; 288];
    out[..32].copy_from_slice(&r.stream);
    put_u64(&mut out, 1, r.valid_from);
    put_u64(&mut out, 2, r.observations_ts);
    put_u64(&mut out, 5, r.expires_at);
    put_i128(&mut out, 6, r.price);
    put_i128(&mut out, 7, r.bid);
    put_i128(&mut out, 8, r.ask);
    out
}

fn encode(env: &Env, r: &RawReport) -> Bytes {
    Bytes::from_slice(env, &encode_words(r))
}

fn put_u64(buf: &mut [u8; 288], word: usize, v: u64) {
    buf[word * 32 + 24..word * 32 + 32].copy_from_slice(&v.to_be_bytes());
}

fn put_i128(buf: &mut [u8; 288], word: usize, v: i128) {
    let fill = if v < 0 { 0xFF } else { 0x00 };
    buf[word * 32..word * 32 + 16].fill(fill);
    buf[word * 32 + 16..word * 32 + 32].copy_from_slice(&v.to_be_bytes());
}

// ── Setup ──

struct Fx<'a> {
    env: Env,
    clocks: TwoClocksClient<'a>,
    proxy: MockProxyClient<'a>,
    verifier: MockVerifierClient<'a>,
    admin: Address,
}

fn id(env: &Env, raw: &[u8; 32]) -> BytesN<32> {
    BytesN::from_array(env, raw)
}

fn asset(env: &Env, data_id: &[u8; 32], label: &str, stream_id: Option<&[u8; 32]>) -> AssetInit {
    AssetInit {
        data_id: id(env, data_id),
        label: String::from_str(env, label),
        stream_id: stream_id.map(|s| id(env, s)),
    }
}

/// XLM and ETH with their testnet streams, BTC without one.
fn default_assets(env: &Env) -> Vec<AssetInit> {
    vec![
        env,
        asset(env, &XLM_ID, "XLM / USD", Some(&XLM_STREAM)),
        asset(env, &ETH_ID, "ETH / USD", Some(&ETH_STREAM)),
        asset(env, &BTC_ID, "BTC / USD", None),
    ]
}

/// `n` distinct assets without streams.
fn many_assets(env: &Env, n: u32) -> Vec<AssetInit> {
    let mut out = Vec::new(env);
    for i in 0..n {
        let mut raw = [0u8; 32];
        raw[0] = 0x01;
        raw[31] = u8::try_from(i).unwrap();
        out.push_back(asset(env, &raw, "X / USD", None));
    }
    out
}

fn setup() -> Fx<'static> {
    let env = Env::default();
    let assets = default_assets(&env);
    setup_with(env, assets)
}

/// Deploy the two mocks, then the contract with `assets`.
fn setup_with(env: Env, assets: Vec<AssetInit>) -> Fx<'static> {
    env.ledger().set_timestamp(LEDGER_S);
    let admin = Address::generate(&env);
    let proxy_id = env.register(MockProxy, ());
    let verifier_id = env.register(MockVerifier, ());
    let clocks_id = env.register(
        TwoClocks,
        (
            admin.clone(),
            proxy_id.clone(),
            verifier_id.clone(),
            MAX_PUSH_AGE_S,
            MAX_PULL_AGE_S,
            assets,
        ),
    );
    Fx {
        clocks: TwoClocksClient::new(&env, &clocks_id),
        proxy: MockProxyClient::new(&env, &proxy_id),
        verifier: MockVerifierClient::new(&env, &verifier_id),
        admin,
        env,
    }
}

fn xlm(fx: &Fx) -> BytesN<32> {
    id(&fx.env, &XLM_ID)
}

fn eth(fx: &Fx) -> BytesN<32> {
    id(&fx.env, &ETH_ID)
}

fn btc(fx: &Fx) -> BytesN<32> {
    id(&fx.env, &BTC_ID)
}

fn set_round(fx: &Fx, data_id: &[u8; 32], answer: i128, round_id: u64, timestamp: u64) {
    fx.proxy.set_round(
        &id(&fx.env, data_id),
        &I256::from_i128(&fx.env, answer),
        &round_id,
        &timestamp,
    );
}

fn push_event(fx: &Fx, data_id: &BytesN<32>, leg: &PushLeg) -> (Address, Vec<Val>, Val) {
    (
        fx.clocks.address.clone(),
        (symbol_short!("push"), data_id.clone()).into_val(&fx.env),
        leg.clone().into_val(&fx.env),
    )
}

fn pull_event(fx: &Fx, data_id: &BytesN<32>, leg: &PullLeg) -> (Address, Vec<Val>, Val) {
    (
        fx.clocks.address.clone(),
        (symbol_short!("pull"), data_id.clone()).into_val(&fx.env),
        leg.clone().into_val(&fx.env),
    )
}

/// `set_stream` with the admin's auth mocked for exactly this call.
fn admin_set_stream(fx: &Fx, data_id: &BytesN<32>, stream_id: &BytesN<32>) {
    fx.env.mock_auths(&[MockAuth {
        address: &fx.admin,
        invoke: &MockAuthInvoke {
            contract: &fx.clocks.address,
            fn_name: "set_stream",
            args: (data_id.clone(), stream_id.clone()).into_val(&fx.env),
            sub_invokes: &[],
        },
    }]);
    fx.clocks.set_stream(data_id, stream_id);
}

// ── Push leg ──

#[test]
fn refresh_one_stores_the_round_and_publishes_it() {
    let fx = setup();
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND, LEDGER_S - 10);

    let expected = PushLeg {
        answer: XLM_ANSWER,
        round_id: XLM_ROUND,
        timestamp: LEDGER_S - 10,
        stored_at: LEDGER_S,
    };
    assert_eq!(fx.clocks.refresh_one(&xlm(&fx)), expected);
    assert_eq!(
        fx.env.events().all(),
        vec![&fx.env, push_event(&fx, &xlm(&fx), &expected)]
    );
    assert_eq!(
        fx.clocks.latest(&xlm(&fx)),
        Pair {
            push: Some(expected.clone()),
            pull: None
        }
    );
    assert_eq!(
        fx.clocks.latest_many(&vec![&fx.env, xlm(&fx), eth(&fx)]),
        vec![
            &fx.env,
            Pair {
                push: Some(expected),
                pull: None
            },
            Pair {
                push: None,
                pull: None
            }
        ]
    );
}

#[test]
fn second_refresh_of_the_same_round_is_nothing_new() {
    let fx = setup();
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND, LEDGER_S - 10);
    fx.clocks.refresh_one(&xlm(&fx));

    assert_eq!(
        fx.clocks.try_refresh_one(&xlm(&fx)),
        Err(Ok(Error::NothingNew))
    );
    assert_eq!(
        fx.clocks.try_refresh(&vec![&fx.env, xlm(&fx)]),
        Err(Ok(Error::NothingNew))
    );
}

#[test]
fn an_older_round_never_overwrites() {
    let fx = setup();
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND, LEDGER_S - 10);
    fx.clocks.refresh_one(&xlm(&fx));

    // Same round id with another answer, then a lower round id.
    set_round(&fx, &XLM_ID, XLM_ANSWER + 1, XLM_ROUND, LEDGER_S - 5);
    assert_eq!(
        fx.clocks.try_refresh_one(&xlm(&fx)),
        Err(Ok(Error::NothingNew))
    );
    set_round(&fx, &XLM_ID, XLM_ANSWER + 1, XLM_ROUND - 1, LEDGER_S - 5);
    assert_eq!(
        fx.clocks.try_refresh_one(&xlm(&fx)),
        Err(Ok(Error::NothingNew))
    );
    assert_eq!(fx.clocks.latest(&xlm(&fx)).push.unwrap().answer, XLM_ANSWER);

    // A higher round id stores.
    set_round(&fx, &XLM_ID, XLM_ANSWER + 1, XLM_ROUND + 1, LEDGER_S - 5);
    assert_eq!(fx.clocks.refresh_one(&xlm(&fx)).round_id, XLM_ROUND + 1);
}

#[test]
fn stale_and_future_rounds_are_stale() {
    let fx = setup();
    // Exactly max_push_age_s old is still fresh. One second more is stale.
    set_round(&fx, &XLM_ID, XLM_ANSWER, 1, LEDGER_S - MAX_PUSH_AGE_S);
    assert_eq!(fx.clocks.refresh_one(&xlm(&fx)).round_id, 1);
    set_round(&fx, &XLM_ID, XLM_ANSWER, 2, LEDGER_S - MAX_PUSH_AGE_S - 1);
    assert_eq!(fx.clocks.try_refresh_one(&xlm(&fx)), Err(Ok(Error::Stale)));

    // 60 s ahead of ledger time is tolerated. 61 s is stale.
    set_round(&fx, &XLM_ID, XLM_ANSWER, 3, LEDGER_S + 60);
    assert_eq!(fx.clocks.refresh_one(&xlm(&fx)).round_id, 3);
    set_round(&fx, &XLM_ID, XLM_ANSWER, 4, LEDGER_S + 61);
    assert_eq!(fx.clocks.try_refresh_one(&xlm(&fx)), Err(Ok(Error::Stale)));
    assert_eq!(fx.clocks.latest(&xlm(&fx)).push.unwrap().round_id, 3);

    // A stale round on an empty leg stores nothing.
    set_round(&fx, &ETH_ID, 2_000 * E18, 1, LEDGER_S - MAX_PUSH_AGE_S - 1);
    assert_eq!(fx.clocks.try_refresh_one(&eth(&fx)), Err(Ok(Error::Stale)));
    assert_eq!(fx.clocks.latest(&eth(&fx)).push, None);
}

#[test]
fn proxy_codes_pass_through_unchanged() {
    let fx = setup();
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND, LEDGER_S);
    let cases = [
        (50u32, Error::NoDataPresent),
        (51, Error::InvalidDecimals),
        (52, Error::RoundsToZero),
        (109, Error::FeedFrozen),
    ];
    for (mode, err) in cases {
        fx.proxy.set_mode(&mode);
        assert_eq!(fx.clocks.try_refresh_one(&xlm(&fx)), Err(Ok(err)));
        // The batch call fails as a whole too.
        assert_eq!(
            fx.clocks.try_refresh(&vec![&fx.env, xlm(&fx)]),
            Err(Ok(err))
        );
        assert_eq!(err as u32, mode);
    }
    fx.proxy.set_mode(&0);
    assert_eq!(fx.clocks.refresh_one(&xlm(&fx)).round_id, XLM_ROUND);

    // An id the proxy does not know is NoDataPresent, like the real proxy.
    assert_eq!(
        fx.clocks.try_refresh_one(&eth(&fx)),
        Err(Ok(Error::NoDataPresent))
    );
    for (err, code) in [
        (ProxyReadError::NoDataPresent, 50),
        (ProxyReadError::InvalidDecimals, 51),
        (ProxyReadError::RoundsToZero, 52),
    ] {
        assert_eq!(Error::from(err) as u32, code);
    }
}

#[test]
fn an_answer_beyond_i128_is_overflow() {
    let fx = setup();
    // 2^192 does not fit.
    fx.proxy.set_round(
        &xlm(&fx),
        &I256::from_parts(&fx.env, 1, 0, 0, 0),
        &1,
        &LEDGER_S,
    );
    assert_eq!(
        fx.clocks.try_refresh_one(&xlm(&fx)),
        Err(Ok(Error::Overflow))
    );
    // i128::MAX fits.
    fx.proxy.set_round(
        &xlm(&fx),
        &I256::from_i128(&fx.env, i128::MAX),
        &1,
        &LEDGER_S,
    );
    assert_eq!(fx.clocks.refresh_one(&xlm(&fx)).answer, i128::MAX);
}

#[test]
fn an_unknown_asset_is_rejected() {
    let fx = setup();
    let unknown = id(&fx.env, &[9u8; 32]);
    assert_eq!(
        fx.clocks.try_refresh_one(&unknown),
        Err(Ok(Error::UnknownAsset))
    );
    assert_eq!(fx.clocks.try_latest(&unknown), Err(Ok(Error::UnknownAsset)));
    assert_eq!(
        fx.clocks.try_fresh_price(&unknown, &u64::MAX),
        Err(Ok(Error::UnknownAsset))
    );
    assert_eq!(
        fx.clocks.try_spread_bps(&unknown),
        Err(Ok(Error::UnknownAsset))
    );
    assert_eq!(
        fx.clocks.latest_many(&vec![&fx.env, unknown]),
        vec![
            &fx.env,
            Pair {
                push: None,
                pull: None
            }
        ]
    );
}

#[test]
fn refresh_counts_stored_and_skips_stale_and_nothing_new() {
    let fx = setup();
    set_round(&fx, &ETH_ID, 2_000 * E18, 7, LEDGER_S);
    fx.clocks.refresh_one(&eth(&fx));
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND, LEDGER_S - 10);
    set_round(
        &fx,
        &BTC_ID,
        100_000 * E18,
        5,
        LEDGER_S - MAX_PUSH_AGE_S - 1,
    );

    // xlm is new, eth is nothing new, btc is stale.
    let ids = vec![&fx.env, xlm(&fx), eth(&fx), btc(&fx)];
    assert_eq!(fx.clocks.refresh(&ids), 1);
    let xlm_leg = PushLeg {
        answer: XLM_ANSWER,
        round_id: XLM_ROUND,
        timestamp: LEDGER_S - 10,
        stored_at: LEDGER_S,
    };
    assert_eq!(
        fx.env.events().all(),
        vec![&fx.env, push_event(&fx, &xlm(&fx), &xlm_leg)]
    );
    assert_eq!(fx.clocks.latest(&btc(&fx)).push, None);

    // Only skips: nothing new. An empty list too.
    assert_eq!(fx.clocks.try_refresh(&ids), Err(Ok(Error::NothingNew)));
    assert_eq!(
        fx.clocks.try_refresh(&vec![&fx.env]),
        Err(Ok(Error::NothingNew))
    );

    // Two new rounds: two stored, two events.
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND + 1, LEDGER_S);
    set_round(&fx, &ETH_ID, 2_001 * E18, 8, LEDGER_S);
    assert_eq!(fx.clocks.refresh(&ids), 2);
    assert_eq!(fx.env.events().all().events().len(), 2);

    // An unknown id fails the whole call and rolls back the stored round.
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND + 2, LEDGER_S);
    let mixed = vec![&fx.env, xlm(&fx), id(&fx.env, &[9u8; 32])];
    assert_eq!(fx.clocks.try_refresh(&mixed), Err(Ok(Error::UnknownAsset)));
    assert_eq!(
        fx.clocks.latest(&xlm(&fx)).push.unwrap().round_id,
        XLM_ROUND + 1
    );
}

// ── Pull leg ──

#[test]
fn submit_report_stores_the_fixture() {
    let fx = setup();
    let expected = PullLeg {
        price: FIXTURE_PRICE,
        bid: FIXTURE_BID,
        ask: FIXTURE_ASK,
        valid_from: FIXTURE_TS,
        observations_ts: FIXTURE_TS,
        expires_at: FIXTURE_EXPIRES_AT,
        stream_id: id(&fx.env, &ETH_STREAM),
        stored_at: LEDGER_S,
    };
    assert_eq!(fx.clocks.submit_report(&fixture(&fx.env)), expected);
    assert_eq!(
        fx.env.events().all(),
        vec![&fx.env, pull_event(&fx, &eth(&fx), &expected)]
    );
    assert_eq!(
        fx.clocks.latest(&eth(&fx)),
        Pair {
            push: None,
            pull: Some(expected)
        }
    );
    // The verifier saw this contract as the sender, and its require_auth
    // passed without any mocked auth.
    assert_eq!(fx.verifier.last_sender(), Some(fx.clocks.address.clone()));
}

#[test]
fn the_same_report_again_is_nothing_new() {
    let fx = setup();
    fx.clocks.submit_report(&fixture(&fx.env));
    assert_eq!(
        fx.clocks.try_submit_report(&fixture(&fx.env)),
        Err(Ok(Error::NothingNew))
    );

    // A later observations time for the same stream stores.
    fx.verifier.set_mode(&VerifyMode::Echo);
    let newer = raw_report(ETH_STREAM, FIXTURE_TS + 1, FIXTURE_PRICE + E18);
    assert_eq!(
        fx.clocks
            .submit_report(&encode(&fx.env, &newer))
            .observations_ts,
        FIXTURE_TS + 1
    );

    // The fixture is now older than the stored leg.
    fx.verifier.set_mode(&VerifyMode::Extract);
    assert_eq!(
        fx.clocks.try_submit_report(&fixture(&fx.env)),
        Err(Ok(Error::NothingNew))
    );
    assert_eq!(
        fx.clocks.latest(&eth(&fx)).pull.unwrap().price,
        FIXTURE_PRICE + E18
    );
}

#[test]
fn the_fixture_is_expired_on_10_november_2026() {
    let fx = setup();
    fx.env.ledger().set_timestamp(NOV_10_2026);
    assert_eq!(
        fx.clocks.try_submit_report(&fixture(&fx.env)),
        Err(Ok(Error::Expired))
    );
    // verify_report still decodes it. Nothing is stored.
    let report = fx.clocks.verify_report(&fixture(&fx.env));
    assert_eq!(report.expires_at, FIXTURE_EXPIRES_AT);
    assert_eq!(fx.clocks.latest(&eth(&fx)).pull, None);

    // Expiry is exact: at expires_at the report is expired, one second before it is not.
    fx.env.ledger().set_timestamp(FIXTURE_EXPIRES_AT);
    assert_eq!(
        fx.clocks.try_submit_report(&fixture(&fx.env)),
        Err(Ok(Error::Expired))
    );
    fx.env.ledger().set_timestamp(FIXTURE_EXPIRES_AT - 1);
    assert_eq!(
        fx.clocks.try_submit_report(&fixture(&fx.env)),
        Err(Ok(Error::Stale))
    );
}

#[test]
fn verify_report_decodes_the_fixture_and_writes_nothing() {
    let fx = setup();
    let report = fx.clocks.verify_report(&fixture(&fx.env));
    assert_eq!(
        report,
        ReportV3 {
            stream_id: id(&fx.env, &ETH_STREAM),
            valid_from: FIXTURE_TS,
            observations_ts: FIXTURE_TS,
            expires_at: FIXTURE_EXPIRES_AT,
            price: FIXTURE_PRICE,
            bid: FIXTURE_BID,
            ask: FIXTURE_ASK,
        }
    );
    assert!(fx.env.events().all().events().is_empty());
    assert_eq!(
        fx.clocks.latest(&eth(&fx)),
        Pair {
            push: None,
            pull: None
        }
    );
    assert_eq!(
        fx.clocks.try_spread_bps(&eth(&fx)),
        Err(Ok(Error::NotFound))
    );
    assert_eq!(fx.verifier.last_sender(), Some(fx.clocks.address.clone()));
}

#[test]
fn byte_479_is_the_low_byte_of_the_price() {
    let fx = setup();
    let mut raw = fixture_raw();
    raw[479] ^= 0x01;
    let report = fx.clocks.verify_report(&Bytes::from_slice(&fx.env, &raw));
    assert_eq!(report.price, FIXTURE_PRICE + 1);
    assert_eq!(report.bid, FIXTURE_BID);
    assert_eq!(report.ask, FIXTURE_ASK);
}

#[test]
fn pull_freshness_rules() {
    let fx = setup();
    fx.verifier.set_mode(&VerifyMode::Echo);
    let price = 2_000 * E18;

    // 61 s ahead of ledger time is not yet valid. 60 s is.
    let ahead = raw_report(ETH_STREAM, LEDGER_S + 61, price);
    assert_eq!(
        fx.clocks.try_submit_report(&encode(&fx.env, &ahead)),
        Err(Ok(Error::NotYetValid))
    );
    // max_pull_age_s plus one second old is stale. Exactly max_pull_age_s is not.
    let old = raw_report(ETH_STREAM, LEDGER_S - MAX_PULL_AGE_S - 1, price);
    assert_eq!(
        fx.clocks.try_submit_report(&encode(&fx.env, &old)),
        Err(Ok(Error::Stale))
    );
    let edge = raw_report(ETH_STREAM, LEDGER_S - MAX_PULL_AGE_S, price);
    assert_eq!(
        fx.clocks
            .submit_report(&encode(&fx.env, &edge))
            .observations_ts,
        LEDGER_S - MAX_PULL_AGE_S
    );
    let edge_ahead = raw_report(ETH_STREAM, LEDGER_S + 60, price);
    assert_eq!(
        fx.clocks
            .submit_report(&encode(&fx.env, &edge_ahead))
            .observations_ts,
        LEDGER_S + 60
    );

    // Expired is checked before every other rule.
    let mut expired = raw_report(ETH_STREAM, LEDGER_S + 61, price);
    expired.expires_at = LEDGER_S;
    assert_eq!(
        fx.clocks.try_submit_report(&encode(&fx.env, &expired)),
        Err(Ok(Error::Expired))
    );
}

#[test]
fn broken_report_data_is_rejected() {
    let fx = setup();
    fx.verifier.set_mode(&VerifyMode::Echo);
    let price = 2_000 * E18;

    // 287 and 289 bytes.
    let short = Bytes::from_slice(&fx.env, &[0u8; 287]);
    assert_eq!(
        fx.clocks.try_submit_report(&short),
        Err(Ok(Error::MalformedReport))
    );
    assert_eq!(
        fx.clocks.try_verify_report(&short),
        Err(Ok(Error::MalformedReport))
    );
    let long = Bytes::from_slice(&fx.env, &[0u8; 289]);
    assert_eq!(
        fx.clocks.try_verify_report(&long),
        Err(Ok(Error::MalformedReport))
    );

    // Schema 0x0006.
    let mut v6 = ETH_STREAM;
    v6[1] = 0x06;
    assert_eq!(
        fx.clocks
            .try_submit_report(&encode(&fx.env, &raw_report(v6, LEDGER_S, price))),
        Err(Ok(Error::UnsupportedSchema))
    );

    // A timestamp word with high bytes set.
    let mut wide = raw_report(ETH_STREAM, LEDGER_S, price);
    wide.valid_from = 1 << 32;
    assert_eq!(
        fx.clocks.try_verify_report(&encode(&fx.env, &wide)),
        Err(Ok(Error::MalformedReport))
    );

    // A v3 stream no asset maps to. verify_report does not need the mapping.
    let mut other = [0u8; 32];
    other[1] = 0x03;
    other[31] = 0x77;
    let unmapped = encode(&fx.env, &raw_report(other, LEDGER_S, price));
    assert_eq!(
        fx.clocks.try_submit_report(&unmapped),
        Err(Ok(Error::UnknownStream))
    );
    assert_eq!(
        fx.clocks.verify_report(&unmapped).stream_id,
        id(&fx.env, &other)
    );
}

#[test]
fn verifier_codes_pass_through_unchanged() {
    let fx = setup();
    let cases = [
        (9u32, Error::DigestNotSet),
        (12, Error::BadVerification),
        (16, Error::InvalidReportFormat),
    ];
    for (code, err) in cases {
        fx.verifier.set_mode(&VerifyMode::Fail(code));
        assert_eq!(fx.clocks.try_submit_report(&fixture(&fx.env)), Err(Ok(err)));
        assert_eq!(fx.clocks.try_verify_report(&fixture(&fx.env)), Err(Ok(err)));
        assert_eq!(err as u32, code);
    }
    assert_eq!(fx.clocks.latest(&eth(&fx)).pull, None);

    // Every verifier code keeps its number.
    for code in 2..=18u32 {
        assert_eq!(Error::from(verifier_error(code)) as u32, code);
    }
    assert_eq!(Error::FeedFrozen as u32, 109);
}

// ── Reading both legs ──

#[test]
fn spread_bps_has_the_sign_and_size_of_the_gap() {
    let fx = setup();
    assert_eq!(
        fx.clocks.try_spread_bps(&eth(&fx)),
        Err(Ok(Error::NotFound))
    );
    set_round(&fx, &ETH_ID, 2_000 * E18, 1, LEDGER_S);
    fx.clocks.refresh_one(&eth(&fx));
    assert_eq!(
        fx.clocks.try_spread_bps(&eth(&fx)),
        Err(Ok(Error::NotFound))
    );
    fx.clocks.submit_report(&fixture(&fx.env));

    // 2050.2059 against 2000: plus 2.51 percent.
    assert_eq!(fx.clocks.spread_bps(&eth(&fx)), 251);

    // 2050.2059 against 2100: minus 2.37 percent, truncated toward zero.
    set_round(&fx, &ETH_ID, 2_100 * E18, 2, LEDGER_S);
    fx.clocks.refresh_one(&eth(&fx));
    assert_eq!(fx.clocks.spread_bps(&eth(&fx)), -237);

    // Equal prices give zero.
    set_round(&fx, &ETH_ID, FIXTURE_PRICE, 3, LEDGER_S);
    fx.clocks.refresh_one(&eth(&fx));
    assert_eq!(fx.clocks.spread_bps(&eth(&fx)), 0);

    // A zero push answer cannot divide.
    set_round(&fx, &ETH_ID, 0, 4, LEDGER_S);
    fx.clocks.refresh_one(&eth(&fx));
    assert_eq!(
        fx.clocks.try_spread_bps(&eth(&fx)),
        Err(Ok(Error::Overflow))
    );
}

#[test]
fn fresh_price_picks_the_newest_leg_inside_the_window() {
    let fx = setup();
    assert_eq!(
        fx.clocks.try_fresh_price(&eth(&fx), &u64::MAX),
        Err(Ok(Error::Stale))
    );

    // Push leg 10 s old.
    set_round(&fx, &ETH_ID, 2_000 * E18, 1, LEDGER_S - 10);
    fx.clocks.refresh_one(&eth(&fx));
    assert_eq!(
        fx.clocks.fresh_price(&eth(&fx), &10),
        FreshPrice {
            price: 2_000 * E18,
            source: Source::Push,
            timestamp: LEDGER_S - 10,
        }
    );
    assert_eq!(
        fx.clocks.try_fresh_price(&eth(&fx), &9),
        Err(Ok(Error::Stale))
    );

    // Pull leg 1 s old: newer than the push leg.
    fx.clocks.submit_report(&fixture(&fx.env));
    assert_eq!(
        fx.clocks.fresh_price(&eth(&fx), &10),
        FreshPrice {
            price: FIXTURE_PRICE,
            source: Source::Pull,
            timestamp: FIXTURE_TS,
        }
    );
    assert_eq!(fx.clocks.fresh_price(&eth(&fx), &1).source, Source::Pull);
    assert_eq!(
        fx.clocks.try_fresh_price(&eth(&fx), &0),
        Err(Ok(Error::Stale))
    );

    // A newer push leg wins again.
    set_round(&fx, &ETH_ID, 2_010 * E18, 2, LEDGER_S);
    fx.clocks.refresh_one(&eth(&fx));
    assert_eq!(
        fx.clocks.fresh_price(&eth(&fx), &0),
        FreshPrice {
            price: 2_010 * E18,
            source: Source::Push,
            timestamp: LEDGER_S,
        }
    );

    // Once the report expires only the push leg counts, however wide the window.
    fx.env.ledger().set_timestamp(FIXTURE_EXPIRES_AT);
    assert_eq!(
        fx.clocks.fresh_price(&eth(&fx), &u64::MAX).source,
        Source::Push
    );
    assert_eq!(
        fx.clocks.try_fresh_price(&eth(&fx), &1),
        Err(Ok(Error::Stale))
    );
}

#[test]
fn assets_and_config_reflect_the_constructor() {
    let fx = setup();
    assert_eq!(
        fx.clocks.config(),
        Config {
            admin: fx.admin.clone(),
            proxy: fx.proxy.address.clone(),
            verifier: fx.verifier.address.clone(),
            max_push_age_s: MAX_PUSH_AGE_S,
            max_pull_age_s: MAX_PULL_AGE_S,
        }
    );
    assert_eq!(
        fx.clocks.assets(),
        vec![
            &fx.env,
            AssetView {
                data_id: xlm(&fx),
                label: String::from_str(&fx.env, "XLM / USD"),
                stream_id: Some(id(&fx.env, &XLM_STREAM)),
            },
            AssetView {
                data_id: eth(&fx),
                label: String::from_str(&fx.env, "ETH / USD"),
                stream_id: Some(id(&fx.env, &ETH_STREAM)),
            },
            AssetView {
                data_id: btc(&fx),
                label: String::from_str(&fx.env, "BTC / USD"),
                stream_id: None,
            },
        ]
    );
}

#[test]
fn thirty_two_assets_fit() {
    let env = Env::default();
    let assets = many_assets(&env, MAX_ASSETS);
    let fx = setup_with(env, assets);
    assert_eq!(fx.clocks.assets().len(), MAX_ASSETS);
}

#[test]
#[should_panic(expected = "Error(Contract, #30)")]
fn thirty_three_assets_are_too_many() {
    let env = Env::default();
    let assets = many_assets(&env, MAX_ASSETS + 1);
    setup_with(env, assets);
}

#[test]
fn a_duplicate_data_id_is_listed_once() {
    let env = Env::default();
    let assets = vec![
        &env,
        asset(&env, &XLM_ID, "XLM / USD", None),
        asset(&env, &XLM_ID, "XLM again", Some(&XLM_STREAM)),
    ];
    let fx = setup_with(env, assets);
    let listed = fx.clocks.assets();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed.get(0).unwrap().label,
        String::from_str(&fx.env, "XLM / USD")
    );
}

// ── Streams ──

#[test]
fn set_stream_needs_the_admin() {
    let fx = setup();
    let stream = id(&fx.env, &BTC_STREAM);

    // No auth at all.
    assert_eq!(
        fx.clocks.try_set_stream(&btc(&fx), &stream),
        Err(Err(InvokeError::Abort))
    );
    // Someone else's auth.
    let intruder = Address::generate(&fx.env);
    fx.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &fx.clocks.address,
            fn_name: "set_stream",
            args: (btc(&fx), stream.clone()).into_val(&fx.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(
        fx.clocks.try_set_stream(&btc(&fx), &stream),
        Err(Err(InvokeError::Abort))
    );
    assert_eq!(fx.clocks.assets().get(2).unwrap().stream_id, None);

    // The admin maps the stream. A report for it now lands on btc.
    admin_set_stream(&fx, &btc(&fx), &stream);
    assert_eq!(
        fx.clocks.assets().get(2).unwrap().stream_id,
        Some(stream.clone())
    );
    fx.verifier.set_mode(&VerifyMode::Echo);
    let report = raw_report(BTC_STREAM, LEDGER_S, 100_000 * E18);
    fx.clocks.submit_report(&encode(&fx.env, &report));
    assert_eq!(
        fx.clocks.latest(&btc(&fx)).pull.unwrap().price,
        100_000 * E18
    );

    // An unknown asset, with the admin's auth.
    let unknown = id(&fx.env, &[9u8; 32]);
    fx.env.mock_auths(&[MockAuth {
        address: &fx.admin,
        invoke: &MockAuthInvoke {
            contract: &fx.clocks.address,
            fn_name: "set_stream",
            args: (unknown.clone(), stream.clone()).into_val(&fx.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(
        fx.clocks.try_set_stream(&unknown, &stream),
        Err(Ok(Error::UnknownAsset))
    );
}

#[test]
fn set_stream_replaces_the_old_mapping() {
    let fx = setup();
    let mut other = [0u8; 32];
    other[1] = 0x03;
    other[31] = 0x42;
    let new_stream = id(&fx.env, &other);

    admin_set_stream(&fx, &eth(&fx), &new_stream);
    // The fixture's stream no longer maps to eth.
    assert_eq!(
        fx.clocks.try_submit_report(&fixture(&fx.env)),
        Err(Ok(Error::UnknownStream))
    );
    // The new one does.
    fx.verifier.set_mode(&VerifyMode::Echo);
    let report = raw_report(other, LEDGER_S, 2_000 * E18);
    fx.clocks.submit_report(&encode(&fx.env, &report));
    assert_eq!(
        fx.clocks.latest(&eth(&fx)).pull.unwrap().stream_id,
        new_stream
    );
}

// ── TTL ──

fn instance_ttl(fx: &Fx) -> u32 {
    fx.env
        .deployer()
        .get_contract_instance_ttl(&fx.clocks.address)
}

fn code_ttl(fx: &Fx) -> u32 {
    fx.env.deployer().get_contract_code_ttl(&fx.clocks.address)
}

fn entry_ttl(fx: &Fx, key: &DataKey) -> u32 {
    fx.env.as_contract(&fx.clocks.address, || {
        fx.env.storage().persistent().get_ttl(key)
    })
}

#[test]
fn ttl_constants_match_the_verifier() {
    assert_eq!(TTL_THRESHOLD, 518_400);
    assert_eq!(TTL_EXTEND_TO, 1_555_200);
}

#[test]
fn ttls_extend_only_at_or_below_the_threshold() {
    let fx = setup();
    let push_key = DataKey::Push(xlm(&fx));
    let meta_key = DataKey::Meta(xlm(&fx));

    // The constructor extends the instance, the code and the meta entries.
    assert_eq!(instance_ttl(&fx), TTL_EXTEND_TO);
    assert_eq!(code_ttl(&fx), TTL_EXTEND_TO);
    assert_eq!(entry_ttl(&fx, &meta_key), TTL_EXTEND_TO);
    set_round(&fx, &XLM_ID, XLM_ANSWER, XLM_ROUND, LEDGER_S);
    fx.clocks.refresh_one(&xlm(&fx));
    assert_eq!(entry_ttl(&fx, &push_key), TTL_EXTEND_TO);

    // 1000 ledgers later every TTL is above the threshold. Calls change nothing.
    fx.env.ledger().with_mut(|li| li.sequence_number += 1_000);
    fx.clocks.latest(&xlm(&fx));
    fx.clocks.config();
    assert_eq!(instance_ttl(&fx), TTL_EXTEND_TO - 1_000);
    assert_eq!(code_ttl(&fx), TTL_EXTEND_TO - 1_000);
    assert_eq!(entry_ttl(&fx, &push_key), TTL_EXTEND_TO - 1_000);
    assert_eq!(entry_ttl(&fx, &meta_key), TTL_EXTEND_TO - 1_000);

    // Just below the threshold, a call extends what it touches to the target.
    let below = TTL_EXTEND_TO - 1_000 - TTL_THRESHOLD + 1;
    fx.env.ledger().with_mut(|li| li.sequence_number += below);
    assert_eq!(entry_ttl(&fx, &push_key), TTL_THRESHOLD - 1);
    fx.clocks.config();
    assert_eq!(instance_ttl(&fx), TTL_EXTEND_TO);
    assert_eq!(code_ttl(&fx), TTL_EXTEND_TO);
    // config() reads no persistent entry.
    assert_eq!(entry_ttl(&fx, &push_key), TTL_THRESHOLD - 1);
    assert_eq!(entry_ttl(&fx, &meta_key), TTL_THRESHOLD - 1);
    // latest() reads the meta and the push leg.
    fx.clocks.latest(&xlm(&fx));
    assert_eq!(entry_ttl(&fx, &push_key), TTL_EXTEND_TO);
    assert_eq!(entry_ttl(&fx, &meta_key), TTL_EXTEND_TO);
}

// ── Decoder ──

#[test]
fn decode_v3_reads_the_fixture_report_data() {
    let env = Env::default();
    let report = decode_v3(&env, &fixture_report_data(&env)).unwrap();
    assert_eq!(report.stream_id, id(&env, &ETH_STREAM));
    assert_eq!(report.valid_from, FIXTURE_TS);
    assert_eq!(report.observations_ts, FIXTURE_TS);
    assert_eq!(report.expires_at, FIXTURE_EXPIRES_AT);
    assert_eq!(report.price, FIXTURE_PRICE);
    assert_eq!(report.bid, FIXTURE_BID);
    assert_eq!(report.ask, FIXTURE_ASK);

    // The envelope: 736 bytes, the length word at 224 says 288, two signatures.
    let raw = fixture_raw();
    assert_eq!(raw.len(), 736);
    assert_eq!(u32_at(&raw, 3 * 32), FIXTURE_DATA_LEN_AT);
    assert_eq!(u32_at(&raw, FIXTURE_DATA_LEN_AT), 288);
    assert_eq!(FIXTURE_DATA_LEN_AT + 32, FIXTURE_DATA_START);
    assert_eq!(u32_at(&raw, u32_at(&raw, 4 * 32)), 2);
    assert_eq!(u32_at(&raw, u32_at(&raw, 5 * 32)), 2);
}

#[test]
fn decode_v3_checks_the_price_words() {
    let env = Env::default();
    let mut r = raw_report(ETH_STREAM, LEDGER_S, -5 * E18);
    r.bid = i128::MIN;
    r.ask = i128::MAX;
    let report = decode_v3(&env, &encode(&env, &r)).unwrap();
    assert_eq!(report.price, -5 * E18);
    assert_eq!(report.bid, i128::MIN);
    assert_eq!(report.ask, i128::MAX);

    // Head bytes that are neither all zero nor all 0xFF.
    let mut words = encode_words(&raw_report(ETH_STREAM, LEDGER_S, E18));
    words[6 * 32 + 15] = 0x01;
    assert_eq!(
        decode_v3(&env, &Bytes::from_slice(&env, &words)),
        Err(Error::Overflow)
    );
    // A positive int192 above i128::MAX: zero head, sign bit of the low half set.
    let mut words = encode_words(&raw_report(ETH_STREAM, LEDGER_S, E18));
    words[7 * 32 + 16] = 0x80;
    assert_eq!(
        decode_v3(&env, &Bytes::from_slice(&env, &words)),
        Err(Error::Overflow)
    );
    // Its negative mirror: 0xFF head, sign bit clear.
    let mut words = encode_words(&raw_report(ETH_STREAM, LEDGER_S, -E18));
    words[8 * 32 + 16] = 0x00;
    assert_eq!(
        decode_v3(&env, &Bytes::from_slice(&env, &words)),
        Err(Error::Overflow)
    );
    // The legacy fee words are ignored, whatever they hold.
    let mut words = encode_words(&raw_report(ETH_STREAM, LEDGER_S, E18));
    words[3 * 32..5 * 32].fill(0xAB);
    assert_eq!(
        decode_v3(&env, &Bytes::from_slice(&env, &words))
            .unwrap()
            .price,
        E18
    );
}
