//! Unit tests for Curio piece listing and `SchedulePieceRemovals` typed data.

#![allow(clippy::unwrap_used)]

use ethers_core::types::transaction::eip712::Eip712;
use ethers_core::types::{Address, U256};
use serde_json::json;

use super::{parse_data_set_pieces, pdp_remove_pieces_path, schedule_piece_removals_typed_data};

#[test]
fn batch_delete_uses_first_piece_id_in_the_curio_path() {
    assert_eq!(
        pdp_remove_pieces_path("46121", 7),
        "/pdp/data-sets/46121/pieces/7"
    );
}

#[test]
fn parses_piece_id_and_cid_from_a_curio_data_set() {
    let v = json!({
        "id": 46121,
        "nextChallengeEpoch": 10,
        "pieces": [
            { "pieceCid": "bafk-a", "pieceId": 1, "subPieceCid": "bafk-a", "subPieceOffset": 0 },
            { "pieceCid": { "/": "bafk-b" }, "pieceId": "2" },
            { "pieceCid": "bafk-hex", "pieceId": "0xa" }
        ]
    });
    let parsed = parse_data_set_pieces(&v);
    assert_eq!(
        parsed,
        vec![
            (1, "bafk-a".to_owned()),
            (2, "bafk-b".to_owned()),
            (10, "bafk-hex".to_owned())
        ]
    );
}

#[test]
fn skips_incomplete_piece_rows() {
    let v = json!({
        "pieces": [
            { "pieceId": 1 },
            { "pieceCid": "bafk-only" },
            { "pieceCid": "bafk-ok", "pieceId": 3 }
        ]
    });
    assert_eq!(parse_data_set_pieces(&v), vec![(3, "bafk-ok".to_owned())]);
}

#[test]
fn schedule_piece_removals_digest_is_32_bytes_and_covers_piece_ids() {
    let verifying: Address = "0x02925630df557F957f70E112bA06e50965417CA0"
        .parse()
        .unwrap();
    let chain = U256::from(314_159u64);
    let client = U256::from(5u64);
    let one = schedule_piece_removals_typed_data(chain, verifying, client, &[1, 2]);
    let two = schedule_piece_removals_typed_data(chain, verifying, client, &[1, 3]);
    let d1 = one.encode_eip712().unwrap();
    let d2 = two.encode_eip712().unwrap();
    assert_eq!(d1.len(), 32);
    assert_ne!(d1, d2);
    assert_eq!(one.primary_type, "SchedulePieceRemovals");
    assert_eq!(
        one.domain.name.as_deref(),
        Some("FilecoinWarmStorageService")
    );
    assert_eq!(one.domain.version.as_deref(), Some("1"));
}

#[test]
fn extra_data_is_abi_encoded_signature_bytes() {
    let sig = vec![0xab_u8; 65];
    let encoded = ethers_core::abi::encode(&[ethers_core::abi::Token::Bytes(sig.clone())]);
    assert!(encoded.len() > sig.len());
    assert!(encoded.windows(2).any(|w| w == [0xab, 0xab]));
}
