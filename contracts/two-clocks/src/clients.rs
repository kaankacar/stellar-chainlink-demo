//! Clients for the two Chainlink contracts this contract calls.
//!
//! Chainlink ships no crate for either interface. Its docs say to copy the
//! trait, so these are hand copies of the functions this contract may use.
//! The typed errors make `try_latest_round` and `try_verify` return the
//! code the other contract set, instead of a bare host error.

use soroban_sdk::{
    contractclient, contracterror, contracttype, Address, Bytes, BytesN, Env, String, I256,
};

/// One round of a Data Feed, as the proxy returns it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Round {
    /// The price, scaled by the `decimals` the caller asked for.
    pub answer: I256,
    pub round_id: u64,
    /// Unix seconds.
    pub timestamp: u64,
}

/// The read errors of the Data Feeds proxy. A frozen feed is not one of
/// them: the proxy panics with its cache error 109 instead.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ProxyReadError {
    /// Unknown data id, or no round yet.
    NoDataPresent = 50,
    /// `decimals` is 0 or above 18.
    InvalidDecimals = 51,
    /// A non-zero answer truncates to zero at the requested decimals.
    RoundsToZero = 52,
}

/// The read side of the Data Feeds proxy. One proxy per network serves
/// every feed, selected by its 32-byte data id.
#[contractclient(name = "DataFeedsProxyClient")]
pub trait DataFeedsProxy {
    /// The latest round, with the answer scaled to `decimals` (1 to 18).
    fn latest_round(env: Env, data_id: BytesN<32>, decimals: u32) -> Result<Round, ProxyReadError>;
    /// One past round by id.
    fn get_round(
        env: Env,
        data_id: BytesN<32>,
        round_id: u64,
        decimals: u32,
    ) -> Result<Round, ProxyReadError>;
    /// Stored decimals of the feed. 18 for every feed today.
    fn decimals(env: Env, data_id: BytesN<32>) -> Result<u32, ProxyReadError>;
    /// Feed name, such as "XLM/USD".
    fn description(env: Env, data_id: BytesN<32>) -> Result<String, ProxyReadError>;
    /// Smallest `decimals` a read may ask for. 8 today.
    fn get_min_decimals(env: Env, data_id: BytesN<32>) -> u32;
    fn version(env: Env) -> u32;
    fn type_and_version(env: Env) -> String;
}

/// The errors of the Data Streams verifier. Same codes and names as
/// Chainlink's `ContractError`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    NotInitialized = 2,
    ZeroAddress = 3,
    FaultToleranceMustBePositive = 4,
    ExcessSigners = 5,
    InsufficientSigners = 6,
    NonUniqueSignatures = 7,
    DigestEmpty = 8,
    /// The report's config digest is not set on this verifier. The testnet
    /// sample gives this on mainnet.
    DigestNotSet = 9,
    DigestInactive = 10,
    ConfigDigestAlreadySet = 11,
    /// A signature does not recover to a registered signer. A tampered
    /// report gives this.
    BadVerification = 12,
    MismatchedSignatures = 13,
    IncorrectSignatureCount = 14,
    NoProposedOwner = 15,
    InvalidReportFormat = 16,
    SignatureRecoveryFailed = 17,
    InvalidProposedOwner = 18,
}

/// The Data Streams verifier. `verify` checks f + 1 signatures, calls
/// `sender.require_auth()` and returns `report_data`. It does not check
/// freshness.
#[contractclient(name = "VerifierClient")]
pub trait Verifier {
    fn verify(env: Env, signed_report: Bytes, sender: Address) -> Result<Bytes, VerifierError>;
}
