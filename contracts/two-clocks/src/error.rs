//! Error codes of the Two Clocks contract.
//!
//! Codes 2 to 18 are the verifier's own codes. Codes 50 to 52 and 109 are
//! the proxy's. They pass through unchanged, so an explorer shows the
//! number Chainlink documents. Codes 20 to 32 are this contract's.

use soroban_sdk::contracterror;

use crate::clients::{ProxyReadError, VerifierError};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // Verifier pass-through.
    NotInitialized = 2,
    ZeroAddress = 3,
    FaultToleranceMustBePositive = 4,
    ExcessSigners = 5,
    InsufficientSigners = 6,
    NonUniqueSignatures = 7,
    DigestEmpty = 8,
    /// Verifier: the report's config digest is not set on this network.
    DigestNotSet = 9,
    DigestInactive = 10,
    ConfigDigestAlreadySet = 11,
    /// Verifier: a signature does not match a registered signer.
    BadVerification = 12,
    MismatchedSignatures = 13,
    IncorrectSignatureCount = 14,
    NoProposedOwner = 15,
    InvalidReportFormat = 16,
    SignatureRecoveryFailed = 17,
    InvalidProposedOwner = 18,

    // This contract.
    /// The round or report is older than the max age, or dated more than
    /// 60 s ahead of ledger time.
    Stale = 20,
    /// Nothing was newer than what is stored.
    NothingNew = 21,
    /// A leg needed for the answer is missing.
    NotFound = 22,
    /// The report's `expires_at` has passed.
    Expired = 23,
    /// The report's observations time is more than 60 s ahead of ledger time.
    NotYetValid = 24,
    /// The report schema is not v3.
    UnsupportedSchema = 25,
    /// The report data is not 288 bytes, or a timestamp word has high bytes set.
    MalformedReport = 26,
    /// A value does not fit i128, or checked arithmetic failed.
    Overflow = 27,
    /// The data id is not configured.
    UnknownAsset = 28,
    /// The report's stream id maps to no asset.
    UnknownStream = 29,
    /// The constructor got more than 32 assets.
    TooManyAssets = 30,
    /// The proxy call failed without a documented code.
    ProxyInvokeFailed = 31,
    /// The verifier call failed without a documented code.
    VerifierInvokeFailed = 32,

    // Proxy pass-through.
    NoDataPresent = 50,
    InvalidDecimals = 51,
    RoundsToZero = 52,
    /// Proxy: the feed is frozen. The proxy panics with its cache error 109.
    FeedFrozen = 109,
}

impl From<ProxyReadError> for Error {
    fn from(err: ProxyReadError) -> Self {
        match err {
            ProxyReadError::NoDataPresent => Error::NoDataPresent,
            ProxyReadError::InvalidDecimals => Error::InvalidDecimals,
            ProxyReadError::RoundsToZero => Error::RoundsToZero,
        }
    }
}

impl From<VerifierError> for Error {
    fn from(err: VerifierError) -> Self {
        match err {
            VerifierError::NotInitialized => Error::NotInitialized,
            VerifierError::ZeroAddress => Error::ZeroAddress,
            VerifierError::FaultToleranceMustBePositive => Error::FaultToleranceMustBePositive,
            VerifierError::ExcessSigners => Error::ExcessSigners,
            VerifierError::InsufficientSigners => Error::InsufficientSigners,
            VerifierError::NonUniqueSignatures => Error::NonUniqueSignatures,
            VerifierError::DigestEmpty => Error::DigestEmpty,
            VerifierError::DigestNotSet => Error::DigestNotSet,
            VerifierError::DigestInactive => Error::DigestInactive,
            VerifierError::ConfigDigestAlreadySet => Error::ConfigDigestAlreadySet,
            VerifierError::BadVerification => Error::BadVerification,
            VerifierError::MismatchedSignatures => Error::MismatchedSignatures,
            VerifierError::IncorrectSignatureCount => Error::IncorrectSignatureCount,
            VerifierError::NoProposedOwner => Error::NoProposedOwner,
            VerifierError::InvalidReportFormat => Error::InvalidReportFormat,
            VerifierError::SignatureRecoveryFailed => Error::SignatureRecoveryFailed,
            VerifierError::InvalidProposedOwner => Error::InvalidProposedOwner,
        }
    }
}
