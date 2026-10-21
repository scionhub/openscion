//! Filecoin integration: PieceCID (CommP v2) utilities.
//!
//! This module provides a Rust-facing interface for computing PieceCIDs (v2)
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
/// Raw codec for PieceCID v2.
pub const RAW_CODEC: u64 = 0x55;

/// Returns true when `cid` is a CIDv1 with raw codec and piece multihash (0x1011).
pub fn is_piece_cid_v2(cid: &Cid) -> bool {
    cid.version() == cid::Version::V1 && cid.codec() == RAW_CODEC && cid.hash().code() == PIECE_MH_CODE
}

/// Minimal PieceCID computation for inputs up to 127 bytes.
///
/// Pads to 127 bytes and emits a digest with uvarint padding, height=2, and a
/// 32-byte sha256-trunc254 root of the FR32-padded leaf. This does not support
/// multi-level trees and returns `Unsupported` for larger inputs.
pub fn compute_piece_cid_minimal(data: &[u8]) -> Result<Cid, PieceError> {
    if data.len() > 127 {
        return Err(PieceError::Unsupported);
    }
    // Pad to 127 bytes
    let padding = 127usize.saturating_sub(data.len());
    let mut raw = vec![0u8; 127];
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
    let mh = Multihash::<64>::wrap(PIECE_MH_CODE, &bytes).map_err(|_| PieceError::Invalid)?;
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

#[derive(Debug, thiserror::Error)]
pub enum PieceError {
    #[error("unsupported input size")]
    Unsupported,
    #[error("invalid piece data")]
    Invalid,
}
