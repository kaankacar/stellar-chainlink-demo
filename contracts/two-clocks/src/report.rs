//! Decoder for the `report_data` bytes the verifier returns.
//!
//! Schema v3 is nine 32-byte words: stream id, validFromTimestamp,
//! observationsTimestamp, nativeFee, linkFee, expiresAt, price, bid, ask.
//! The timestamps are uint32 and the prices int192, each right-aligned in
//! its word. The two fee words are legacy and ignored. The decoder reads
//! bytes only. It does no I256 arithmetic.

use soroban_sdk::{Bytes, BytesN, Env};

use crate::error::Error;
use crate::state::ReportV3;

/// Size of one ABI word.
const WORD: usize = 32;
/// Nine words.
pub const REPORT_V3_LEN: usize = 9 * WORD;
/// The first two bytes of the stream id carry the schema version.
const SCHEMA_V3: [u8; 2] = [0x00, 0x03];

/// Decode a v3 report. `MalformedReport` if the length is not 288 or a
/// timestamp word has high bytes set, `UnsupportedSchema` if the stream id
/// does not start with `0x0003`, `Overflow` if a price does not fit i128.
pub fn decode_v3(env: &Env, data: &Bytes) -> Result<ReportV3, Error> {
    if data.len() as usize != REPORT_V3_LEN {
        return Err(Error::MalformedReport);
    }
    let mut buf = [0u8; REPORT_V3_LEN];
    data.copy_into_slice(&mut buf);

    let id_word = word(&buf, 0);
    if id_word[..2] != SCHEMA_V3 {
        return Err(Error::UnsupportedSchema);
    }
    let mut id = [0u8; WORD];
    id.copy_from_slice(id_word);

    Ok(ReportV3 {
        stream_id: BytesN::from_array(env, &id),
        valid_from: u32_word(&buf, 1)?,
        observations_ts: u32_word(&buf, 2)?,
        expires_at: u32_word(&buf, 5)?,
        price: i128_word(&buf, 6)?,
        bid: i128_word(&buf, 7)?,
        ask: i128_word(&buf, 8)?,
    })
}

fn word(buf: &[u8; REPORT_V3_LEN], index: usize) -> &[u8] {
    &buf[index * WORD..(index + 1) * WORD]
}

/// A uint32 right-aligned in a word. The 28 leading bytes must be zero.
fn u32_word(buf: &[u8; REPORT_V3_LEN], index: usize) -> Result<u64, Error> {
    let w = word(buf, index);
    if w[..WORD - 4].iter().any(|b| *b != 0) {
        return Err(Error::MalformedReport);
    }
    let mut tail = [0u8; 4];
    tail.copy_from_slice(&w[WORD - 4..]);
    Ok(u64::from(u32::from_be_bytes(tail)))
}

/// An int192 stored as 32-byte two's complement. The 16 leading bytes
/// must all be `0x00` or all be `0xFF`, and the sign of the low 16 bytes
/// must agree with them. Then the value fits i128.
fn i128_word(buf: &[u8; REPORT_V3_LEN], index: usize) -> Result<i128, Error> {
    let w = word(buf, index);
    let head = &w[..WORD / 2];
    let negative = if head.iter().all(|b| *b == 0x00) {
        false
    } else if head.iter().all(|b| *b == 0xFF) {
        true
    } else {
        return Err(Error::Overflow);
    };
    let mut tail = [0u8; WORD / 2];
    tail.copy_from_slice(&w[WORD / 2..]);
    let value = i128::from_be_bytes(tail);
    if (value < 0) != negative {
        return Err(Error::Overflow);
    }
    Ok(value)
}
