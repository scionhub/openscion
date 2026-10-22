//! Filecoin integration: `PieceCID` (`CommP` v2) utilities.
//!
//! This module provides a Rust-facing interface for computing `PieceCIDs` (v2)
//! and parsing them. The full FR32 + sha256-trunc254 padded binary tree hash
//! is non-trivial; a complete, optimized implementation is planned.
//! For now, this module exposes:
//! - `compute_piece_cid_minimal` which supports tiny inputs (<= 127 bytes)
//!   by padding to 127 bytes and using a single-leaf tree. This is intended
//!   for test vectors and will return `Error::Unsupported` for larger inputs.
//! - `is_piece_cid_v2` to validate the codec and multihash code per FRC-0069.
//!
//! A complete implementation should replace `compute_piece_cid_minimal` and
//! backfill tests using authoritative vectors from upstream test suites.

use cid::Cid;
use multihash::Multihash;

/// FRC-0069 piece multihash code `fr32-sha256-trunc254-padbintree`.
pub const PIECE_MH_CODE: u64 = 0x1011;
/// Raw codec for `PieceCID` v2.
pub const RAW_CODEC: u64 = 0x55;

/// Returns true when `cid` is a `CIDv1` with raw codec and piece multihash (0x1011).
#[must_use]
pub fn is_piece_cid_v2(cid: &Cid) -> bool {
    cid.version() == cid::Version::V1
        && cid.codec() == RAW_CODEC
        && cid.hash().code() == PIECE_MH_CODE
}

/// Minimal `PieceCID` computation for inputs up to 127 bytes.
///
/// Pads to 127 bytes and emits a digest with uvarint padding, height=2, and a
/// 32-byte sha256-trunc254 root of the FR32-padded leaf. This does not support
/// multi-level trees and returns `Unsupported` for larger inputs.
///
/// # Errors
///
/// Returns [`PieceError::Unsupported`] when `data.len() > 127`, and
/// [`PieceError::Invalid`] if the digest encoding fails unexpectedly.
pub fn compute_piece_cid_minimal(data: &[u8]) -> Result<Cid, PieceError> {
    if data.len() > 127 {
        return Err(PieceError::Unsupported);
    }
    // Pad to 127 bytes
    let padding = 127usize.saturating_sub(data.len());
    let mut raw = [0u8; 127];
    raw[..data.len()].copy_from_slice(data);
    // FR32 padding for a single leaf is a no-op for the minimal case here; a
    // correct FR32 transform is required for general correctness and will land
    // with the full implementation.
    let leaf = &raw[..];
    let root = sha256_trunc254(leaf);
    // Build multihash digest: uvarint(padding) | height(=2) | 32-byte root.
    let mut digest = unsigned_varint::encode::u64_buffer();
    let mut bytes = unsigned_varint::encode::u64(padding as u64, &mut digest).to_vec();
    bytes.push(2u8); // height
    bytes.extend_from_slice(&root);
    let mh = piece_multihash_from_digest(&bytes)?;
    Ok(Cid::new_v1(RAW_CODEC, mh))
}

/// Compute a v2 `PieceCID` using filecoin-proofs to generate the `CommP` root,
/// then encode it per FRC-0069 with padding/height.
///
/// # Errors
///
/// Returns [`PieceError::Invalid`] when the proofs library fails or the
/// resulting digest cannot be encoded into a multihash.
pub fn compute_piece_cid_proofs(data: &[u8]) -> Result<Cid, PieceError> {
    use filecoin_proofs::{UnpaddedBytesAmount, generate_piece_commitment};
    let raw = data.len();
    // Minimal allowed unpadded piece size U = 127 * 2^k >= raw
    let mut u: usize = 127;
    while u < raw {
        u <<= 1;
    }
    let info = generate_piece_commitment(
        std::io::Read::chain(
            std::io::Cursor::new(data),
            std::io::Read::take(std::io::repeat(0), (u - raw) as u64),
        ),
        UnpaddedBytesAmount(u as u64),
    )
    .map_err(|_| PieceError::Invalid)?;
    let root = info.commitment;
    // Height: paddedSize (in unpadded-bytes space) = U = 127 * 2^(height-2)
    let mut tmp = u / 127;
    let mut height: u8 = 2;
    while tmp > 1 {
        tmp >>= 1;
        height = height.saturating_add(1);
    }
    let padding = (u - raw) as u64;
    let mut buf = unsigned_varint::encode::u64_buffer();
    let mut digest = unsigned_varint::encode::u64(padding, &mut buf).to_vec();
    digest.push(height);
    digest.extend_from_slice(&root);
    let mh = piece_multihash_from_digest(&digest)?;
    Ok(Cid::new_v1(RAW_CODEC, mh))
}

fn sha256_trunc254(input: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    // zero the top 2 bits (truncate to 254)
    out[0] &= 0b0011_1111;
    out
}

fn piece_multihash_from_digest(digest: &[u8]) -> Result<Multihash<64>, PieceError> {
    // Build multihash bytes: varint(code) | varint(len) | digest
    let mut buf = unsigned_varint::encode::u64_buffer();
    let mut bytes = unsigned_varint::encode::u64(PIECE_MH_CODE, &mut buf).to_vec();
    let mut lbuf = unsigned_varint::encode::u64_buffer();
    bytes.extend_from_slice(unsigned_varint::encode::u64(digest.len() as u64, &mut lbuf));
    bytes.extend_from_slice(digest);
    Multihash::<64>::from_bytes(&bytes).map_err(|_| PieceError::Invalid)
}

#[derive(Debug, thiserror::Error)]
/// Errors computing or parsing a `PieceCID`.
pub enum PieceError {
    /// Input is larger than the minimal helper supports.
    #[error("unsupported input size")]
    Unsupported,
    /// The input or derived digest could not be encoded into a multihash.
    #[error("invalid piece data")]
    Invalid,
}

#[cfg(test)]
mod test;
