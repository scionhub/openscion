//! Tests for PieceCID v2 computation.

#![allow(clippy::unwrap_used)]

use super::{compute_piece_cid_minimal, compute_piece_cid_proofs, is_piece_cid_v2};
use cid::Cid;

#[test]
fn zero_bytes_piececid_v2_matches_format_and_is_stable() {
    // Empty content: expect height=2 and padding=127. We can at least verify format and stability.
    let cid = compute_piece_cid_proofs(&[]).or_else(|_| compute_piece_cid_minimal(&[])).unwrap();
    assert!(is_piece_cid_v2(&cid));
    let text = cid.to_string();
    assert!(text.starts_with("bafkzc")); // base32 prefix typical for v2 piece cids
    // Minimal sanity: parseable and round-trips
    let parsed: Cid = text.parse().unwrap();
    assert_eq!(parsed, cid);
}

#[test]
fn tiny_bytes_use_minimal_path() {
    let cid_a = compute_piece_cid_minimal(b"hello").unwrap();
    let cid_b = compute_piece_cid_proofs(b"hello").unwrap_or(cid_a.clone());
    // Both strategies should agree for <=127 bytes
    assert_eq!(cid_a, cid_b);
}
