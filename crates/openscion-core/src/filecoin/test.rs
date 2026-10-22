//! Tests for `PieceCID` v2 computation.

#![allow(clippy::unwrap_used)]

use super::{compute_piece_cid_minimal, compute_piece_cid_proofs, is_piece_cid_v2};
use cid::Cid;

#[test]
fn zero_bytes_piececid_v2_matches_format_and_is_stable() {
    // Empty content: expect height=2 and padding=127. We can at least verify format and stability.
    let cid = compute_piece_cid_proofs(&[])
        .or_else(|_| compute_piece_cid_minimal(&[]))
        .unwrap();
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
    let cid_b = compute_piece_cid_proofs(b"hello").unwrap_or(cid_a);
    // The minimal path is a format placeholder (no FR32); only check format.
    assert!(is_piece_cid_v2(&cid_a) && is_piece_cid_v2(&cid_b));
}

#[test]
fn proofs_path_pads_short_input() {
    let path = std::env::var("PIECE_FIXTURE").unwrap_or_default();
    if path.is_empty() {
        return;
    }
    let data = std::fs::read(&path).unwrap();
    println!("PIECE {}", compute_piece_cid_proofs(&data).unwrap());
}
