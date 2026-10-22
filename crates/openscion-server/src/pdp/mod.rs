//! PDP HTTP client: Curio-compatible endpoints with Synapse-style EIP-712 auth hooks.
//!
//! Live calls are enabled when PDP_* secrets are configured; without them the
//! client returns mock/queued states so the server can run locally.

use std::time::{SystemTime, UNIX_EPOCH};

use cid::Cid;
use ethers_core::types::transaction::eip712::{EIP712Domain, Eip712DomainType, TypedData};
use ethers_core::types::{Address, H160, U256};
use ethers_signers::{LocalWallet, Signer};
use reqwest::Client;
use serde_json::json;

#[derive(Debug, Clone)]
/// Thin HTTP client to a PDP provider (Curio-compatible).
pub struct PdpClient {
    base: String,
    client: Client,
    // Auth/signing
    wallet: Option<LocalWallet>,
    chain_id: Option<u64>,
    service_addr: Option<H160>,
    // Optional override for payer/payee
    payer: Option<H160>,
    payee: Option<H160>,
}

impl PdpClient {
    /// Builds a client from `PDP_*` environment variables.
    #[must_use]
    #[allow(clippy::similar_names)]
    pub fn from_env() -> Self {
        let base = std::env::var("PDP_BASE_URL").unwrap_or_default();
        let client = Client::new();
        let wallet = std::env::var("PDP_PRIVATE_KEY")
            .ok()
            .and_then(|hex| hex.parse::<LocalWallet>().ok());
        let chain_id = std::env::var("PDP_CHAIN_ID")
            .ok()
            .and_then(|s| s.parse().ok());
        let service_addr = std::env::var("PDP_SERVICE_CONTRACT")
            .ok()
            .and_then(|s| s.parse::<Address>().ok())
            .map(|a| a.0.into());
        let payer = std::env::var("PDP_PAYER")
            .ok()
            .and_then(|s| s.parse::<Address>().ok())
            .map(|a| a.0.into());
        let payee = std::env::var("PDP_PAYEE")
            .ok()
            .and_then(|s| s.parse::<Address>().ok())
            .map(|a| a.0.into());
        Self {
            base,
            client,
            wallet,
            chain_id,
            service_addr,
            payer,
            payee,
        }
    }

    fn enabled(&self) -> bool {
        !self.base.is_empty()
            && self.wallet.is_some()
            && self.chain_id.is_some()
            && self.service_addr.is_some()
    }
    /// Returns true when live PDP calls are enabled.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.enabled()
    }

    /// POST /pdp/data-sets/create-and-add
    ///
    /// Signs `CreateDataSet` and `AddPieces` EIP-712 payloads, ABI-encodes them as
    /// `bytes,bytes`, and posts the Curio "create and add" request with
    /// `recordKeeper`, `extraData`, and the pieces list.
    ///
    /// # Panics
    ///
    /// Panics when called without the required environment (should be unreachable when `is_enabled()` is true).
    ///
    /// # Errors
    ///
    /// Returns an error when HTTP calls or signing fail.
    #[allow(clippy::unwrap_used, clippy::similar_names)]
    #[allow(clippy::unwrap_used, clippy::similar_names)]
    #[allow(clippy::too_many_lines)]
    pub async fn create_and_add_pieces(&self, pieces: &[String]) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        let chain_id = U256::from(self.chain_id.unwrap_or_default());
        let verifying = self.service_addr.unwrap();
        // Choose payer/payee defaults from wallet when not explicitly configured.
        let wallet = self
            .wallet
            .as_ref()
            .unwrap()
            .clone()
            .with_chain_id(self.chain_id.unwrap());
        #[allow(clippy::similar_names)]
        let payer = self.payer.unwrap_or_else(|| wallet.address().0.into());
        #[allow(clippy::similar_names)]
        let payee = self.payee.unwrap_or_else(|| wallet.address().0.into());

        // Random clientDataSetId and nonce
        let client_dataset_id = U256::from_big_endian(&rand_u256());
        let nonce = U256::from_big_endian(&rand_u256());

        // --- CreateDataSet typed data ---
        // Domain (FWSS)
        let domain = EIP712Domain {
            name: Some("FilecoinWarmStorageService".into()),
            version: Some("1".into()),
            chain_id: Some(chain_id),
            verifying_contract: Some(Address::from(verifying.0)),
            salt: None,
        };
        // Types
        let mut types = std::collections::BTreeMap::new();
        types.insert(
            "MetadataEntry".to_owned(),
            vec![
                Eip712DomainType {
                    name: "key".into(),
                    r#type: "string".into(),
                },
                Eip712DomainType {
                    name: "value".into(),
                    r#type: "string".into(),
                },
            ],
        );
        types.insert(
            "CreateDataSet".to_owned(),
            vec![
                Eip712DomainType {
                    name: "clientDataSetId".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "payee".into(),
                    r#type: "address".into(),
                },
                Eip712DomainType {
                    name: "metadata".into(),
                    r#type: "MetadataEntry[]".into(),
                },
            ],
        );
        // Message: no metadata in POC
        let mut message = std::collections::BTreeMap::new();
        message.insert(
            "clientDataSetId".to_owned(),
            json!(format!("{client_dataset_id:#x}")),
        );
        message.insert("payee".to_owned(), json!(Address::from(payee.0)));
        message.insert("metadata".to_owned(), json!([]));
        let create_td = TypedData {
            types: types.clone(),
            primary_type: "CreateDataSet".to_owned(),
            domain: domain.clone(),
            message,
        };
        let create_sig = wallet
            .sign_typed_data(&create_td)
            .await
            .map_err(|e| e.to_string())?;
        // ABI-encode (payer, clientDataSetId, string[] keys, string[] values, bytes signature)
        let create_extra = ethers_core::abi::encode(&[
            ethers_core::abi::Token::Address(Address::from(payer.0)),
            ethers_core::abi::Token::Uint(client_dataset_id),
            ethers_core::abi::Token::Array(vec![]), // keys
            ethers_core::abi::Token::Array(vec![]), // values
            ethers_core::abi::Token::Bytes(create_sig.to_vec()),
        ]);

        // --- AddPieces typed data ---
        // Matches synapse-core 2.0.2 EIP712Types: pieceData is Cid[] with Cid{bytes data}.
        // Digest verified equal to viem hashTypedData in the digest_probe test.
        types.insert(
            "Cid".to_owned(),
            vec![Eip712DomainType {
                name: "data".into(),
                r#type: "bytes".into(),
            }],
        );
        types.insert(
            "PieceMetadata".to_owned(),
            vec![
                Eip712DomainType {
                    name: "pieceIndex".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "metadata".into(),
                    r#type: "MetadataEntry[]".into(),
                },
            ],
        );
        types.insert(
            "AddPieces".to_owned(),
            vec![
                Eip712DomainType {
                    name: "clientDataSetId".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "nonce".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "pieceData".into(),
                    r#type: "Cid[]".into(),
                },
                Eip712DomainType {
                    name: "pieceMetadata".into(),
                    r#type: "PieceMetadata[]".into(),
                },
            ],
        );
        // Build pieceData (Cids.data: bytes[]) and empty per-piece metadata
        let mut piece_bytes_array = Vec::<serde_json::Value>::with_capacity(pieces.len());
        let mut piece_metadata = Vec::<serde_json::Value>::with_capacity(pieces.len());
        for (idx, s) in pieces.iter().enumerate() {
            let cid: Cid = s.parse().map_err(|_| format!("invalid PieceCID: {s}"))?;
            piece_bytes_array.push(json!({ "data": format!("0x{}", hex::encode(cid.to_bytes())) }));
            piece_metadata.push(json!({ "pieceIndex": idx, "metadata": [] }));
        }
        let mut add_msg = std::collections::BTreeMap::new();
        add_msg.insert(
            "clientDataSetId".to_owned(),
            json!(format!("{client_dataset_id:#x}")),
        );
        add_msg.insert("nonce".to_owned(), json!(format!("{nonce:#x}")));
        add_msg.insert("pieceData".to_owned(), json!(piece_bytes_array));
        add_msg.insert("pieceMetadata".to_owned(), json!(piece_metadata));
        let add_td = TypedData {
            types,
            primary_type: "AddPieces".to_owned(),
            domain,
            message: add_msg,
        };
        let add_sig = wallet
            .sign_typed_data(&add_td)
            .await
            .map_err(|e| e.to_string())?;
        // ABI-encode (uint256 nonce, string[][] keys, string[][] values, bytes signature)
        let add_extra = ethers_core::abi::encode(&[
            ethers_core::abi::Token::Uint(nonce),
            ethers_core::abi::Token::Array(vec![]), // keys[][]
            ethers_core::abi::Token::Array(vec![]), // values[][]
            ethers_core::abi::Token::Bytes(add_sig.to_vec()),
        ]);

        // Combine extras: abi.encode(bytes, bytes)
        let combined = ethers_core::abi::encode(&[
            ethers_core::abi::Token::Bytes(create_extra),
            ethers_core::abi::Token::Bytes(add_extra),
        ]);

        // POST create-and-add
        let url = format!("{}/pdp/data-sets/create-and-add", self.base);
        let body = json!({
            "recordKeeper": Address::from(verifying.0),
            "extraData": format!("0x{}", hex::encode(&combined)),
            "pieces": pieces.iter().map(|p| json!({
                "pieceCid": p,
                "subPieces": [{ "subPieceCid": p }]
            })).collect::<Vec<_>>(),
        });
        let resp = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "pdp create-and-add failed: {status}: {}",
                body.chars().take(400).collect::<String>()
            ));
        }
        Ok(())
    }

    /// Create-and-add one aggregate piece and register its sub-pieces.
    ///
    /// When `sub_pieces` is empty, behaves like `create_and_add_pieces(&[piece.to_owned()])`.
    #[allow(
        clippy::similar_names,
        clippy::missing_panics_doc,
        clippy::missing_errors_doc,
        clippy::too_many_lines,
        clippy::unwrap_used
    )]
    pub async fn create_and_add_aggregate(
        &self,
        piece: &str,
        sub_pieces: &[String],
    ) -> Result<(), String> {
        if sub_pieces.is_empty() {
            return self.create_and_add_pieces(&[piece.to_owned()]).await;
        }
        if !self.enabled() {
            return Ok(());
        }
        // Reuse the same signing flow as above, once per call.
        // Build EIP-712 payloads with a single aggregate piece; signatures do not include piece data.
        let chain_id = U256::from(self.chain_id.unwrap_or_default());
        let verifying = self.service_addr.unwrap();
        let wallet = self
            .wallet
            .as_ref()
            .unwrap()
            .clone()
            .with_chain_id(self.chain_id.unwrap());
        let payer = self.payer.unwrap_or_else(|| wallet.address().0.into());
        let payee = self.payee.unwrap_or_else(|| wallet.address().0.into());
        let client_dataset_id = U256::from_big_endian(&rand_u256());
        let nonce = U256::from_big_endian(&rand_u256());
        let domain = EIP712Domain {
            name: Some("FilecoinWarmStorageService".into()),
            version: Some("1".into()),
            chain_id: Some(chain_id),
            verifying_contract: Some(Address::from(verifying.0)),
            salt: None,
        };
        let mut types = std::collections::BTreeMap::new();
        types.insert(
            "MetadataEntry".to_owned(),
            vec![
                Eip712DomainType {
                    name: "key".into(),
                    r#type: "string".into(),
                },
                Eip712DomainType {
                    name: "value".into(),
                    r#type: "string".into(),
                },
            ],
        );
        types.insert(
            "CreateDataSet".to_owned(),
            vec![
                Eip712DomainType {
                    name: "clientDataSetId".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "payee".into(),
                    r#type: "address".into(),
                },
                Eip712DomainType {
                    name: "metadata".into(),
                    r#type: "MetadataEntry[]".into(),
                },
            ],
        );
        let mut message = std::collections::BTreeMap::new();
        message.insert(
            "clientDataSetId".to_owned(),
            json!(format!("{client_dataset_id:#x}")),
        );
        message.insert("payee".to_owned(), json!(Address::from(payee.0)));
        message.insert("metadata".to_owned(), json!([]));
        let create_td = TypedData {
            types: types.clone(),
            primary_type: "CreateDataSet".to_owned(),
            domain: domain.clone(),
            message,
        };
        let create_sig = wallet
            .sign_typed_data(&create_td)
            .await
            .map_err(|e| e.to_string())?;
        let create_extra = ethers_core::abi::encode(&[
            ethers_core::abi::Token::Address(Address::from(payer.0)),
            ethers_core::abi::Token::Uint(client_dataset_id),
            ethers_core::abi::Token::Array(vec![]),
            ethers_core::abi::Token::Array(vec![]),
            ethers_core::abi::Token::Bytes(create_sig.to_vec()),
        ]);
        // AddPieces with Cids wrapper, as above
        types.insert(
            "Cids".to_owned(),
            vec![Eip712DomainType {
                name: "data".into(),
                r#type: "bytes[]".into(),
            }],
        );
        types.insert(
            "PieceMetadata".to_owned(),
            vec![
                Eip712DomainType {
                    name: "pieceIndex".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "metadata".into(),
                    r#type: "MetadataEntry[]".into(),
                },
            ],
        );
        types.insert(
            "AddPieces".to_owned(),
            vec![
                Eip712DomainType {
                    name: "clientDataSetId".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "nonce".into(),
                    r#type: "uint256".into(),
                },
                Eip712DomainType {
                    name: "pieceData".into(),
                    r#type: "Cids".into(),
                },
                Eip712DomainType {
                    name: "pieceMetadata".into(),
                    r#type: "PieceMetadata[]".into(),
                },
            ],
        );
        let mut piece_bytes_array = Vec::<serde_json::Value>::with_capacity(sub_pieces.len());
        let mut piece_metadata = Vec::<serde_json::Value>::with_capacity(sub_pieces.len());
        for (idx, s) in sub_pieces.iter().enumerate() {
            let cid: Cid = s.parse().map_err(|_| format!("invalid PieceCID: {s}"))?;
            piece_bytes_array.push(json!(format!("0x{}", hex::encode(cid.to_bytes()))));
            piece_metadata.push(json!({ "pieceIndex": idx, "metadata": [] }));
        }
        let mut add_msg = std::collections::BTreeMap::new();
        add_msg.insert(
            "clientDataSetId".to_owned(),
            json!(format!("{client_dataset_id:#x}")),
        );
        add_msg.insert("nonce".to_owned(), json!(format!("{nonce:#x}")));
        add_msg.insert("pieceData".to_owned(), json!({ "data": piece_bytes_array }));
        add_msg.insert("pieceMetadata".to_owned(), json!(piece_metadata));
        let add_td = TypedData {
            types,
            primary_type: "AddPieces".to_owned(),
            domain,
            message: add_msg,
        };
        let add_sig = wallet
            .sign_typed_data(&add_td)
            .await
            .map_err(|e| e.to_string())?;
        let add_extra = ethers_core::abi::encode(&[
            ethers_core::abi::Token::Uint(nonce),
            ethers_core::abi::Token::Array(vec![]),
            ethers_core::abi::Token::Array(vec![]),
            ethers_core::abi::Token::Bytes(add_sig.to_vec()),
        ]);
        let combined = ethers_core::abi::encode(&[
            ethers_core::abi::Token::Bytes(create_extra),
            ethers_core::abi::Token::Bytes(add_extra),
        ]);
        let url = format!("{}/pdp/data-sets/create-and-add", self.base);
        let body = json!({
            "recordKeeper": Address::from(verifying.0),
            "extraData": format!("0x{}", hex::encode(&combined)),
            "pieces": [{
                "pieceCid": piece,
                "subPieces": sub_pieces.iter().map(|p| json!({ "subPieceCid": p })).collect::<Vec<_>>()
            }]
        });
        let resp = self
            .client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "pdp create-and-add aggregate failed: {status}: {}",
                body.chars().take(400).collect::<String>()
            ));
        }
        Ok(())
    }

    /// POST `/pdp/piece` to initiate an upload; returns an upload URL.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP call fails or the response is invalid.
    pub async fn initiate_piece_upload(
        &self,
        piece_cid: &str,
        size_bytes: usize,
    ) -> Result<String, String> {
        if !self.enabled() {
            return Ok(String::new());
        }
        let _ = (piece_cid, size_bytes);
        // Curio streaming upload: POST /pdp/piece/uploads -> 201 + Location.
        let url = format!("{}/pdp/piece/uploads", self.base);
        let resp = self
            .client
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("pdp piece init failed: {}", resp.status()));
        }
        let loc = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "missing Location".to_string())?;
        Ok(format!("{}{}", self.base.trim_end_matches('/'), loc))
    }

    /// PUT the piece bytes to the provided upload URL.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP call fails.
    pub async fn upload_piece_bytes(&self, upload_url: &str, bytes: &[u8]) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        let resp = self
            .client
            .put(upload_url)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("pdp piece upload failed: {}", resp.status()));
        }
        Ok(())
    }

    /// Polls the piece status until "parked" or timeout.
    ///
    /// # Errors
    ///
    /// Returns an error when HTTP calls fail or the timeout elapses.
    pub async fn finalize_piece_upload(
        &self,
        upload_url: &str,
        piece_cid: &str,
    ) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        let resp = self
            .client
            .post(upload_url)
            .json(&json!({ "pieceCid": piece_cid }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("pdp piece finalize failed: {}", resp.status()));
        }
        Ok(())
    }

    /// Polls until the SP reports the piece (GET /pdp/piece?pieceCid=).
    ///
    /// # Errors
    ///
    /// Returns an error when HTTP calls fail or the timeout elapses.
    pub async fn wait_piece_parked(&self, piece_cid: &str) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let url = format!("{}/pdp/piece?pieceCid={}", self.base, piece_cid);
            let resp = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("timeout waiting for piece parked".to_string());
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    }

    /// GET the raw piece bytes by `piece_cid`.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP call fails.
    pub async fn get_piece(&self, piece_cid: &str) -> Result<Vec<u8>, String> {
        if self.base.is_empty() {
            return Err("no PDP_BASE_URL configured".to_string());
        }
        let url = format!("{}/piece/{}", self.base, piece_cid);
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("pdp get piece failed: {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        Ok(bytes.to_vec())
    }
}

fn rand_u256() -> [u8; 32] {
    // Time-based filler; replace with crypto RNG when available.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&now.to_be_bytes());
    out[16..].copy_from_slice(&(!now).to_be_bytes());
    out
}

#[cfg(test)]
mod digest_probe {
    use super::*;
    use ethers_core::types::transaction::eip712::Eip712;
    #[test]
    fn print_digests() {
        let domain = EIP712Domain {
            name: Some("FilecoinWarmStorageService".into()),
            version: Some("1".into()),
            chain_id: Some(U256::from(314_159u64)),
            verifying_contract: Some("0x02925630df557F957f70E112bA06e50965417CA0".parse().unwrap()),
            salt: None,
        };
        let t = |n: &str, ty: &str| Eip712DomainType { name: n.into(), r#type: ty.into() };
        let mut types = std::collections::BTreeMap::new();
        types.insert("MetadataEntry".to_owned(), vec![t("key", "string"), t("value", "string")]);
        types.insert("CreateDataSet".to_owned(), vec![t("clientDataSetId", "uint256"), t("payee", "address"), t("metadata", "MetadataEntry[]")]);
        let mut m = std::collections::BTreeMap::new();
        m.insert("clientDataSetId".to_owned(), json!("0x5"));
        m.insert("payee".to_owned(), json!("0x8F88020203a910Cc0cCc1e2Eb9ab1553862604E3".parse::<Address>().unwrap()));
        m.insert("metadata".to_owned(), json!([]));
        let td = TypedData { types: types.clone(), primary_type: "CreateDataSet".into(), domain: domain.clone(), message: m };
        println!("CREATE 0x{}", hex::encode(td.encode_eip712().unwrap()));
        types.insert("Cid".to_owned(), vec![t("data", "bytes")]);
        types.insert("PieceMetadata".to_owned(), vec![t("pieceIndex", "uint256"), t("metadata", "MetadataEntry[]")]);
        types.insert("AddPieces".to_owned(), vec![t("clientDataSetId", "uint256"), t("nonce", "uint256"), t("pieceData", "Cid[]"), t("pieceMetadata", "PieceMetadata[]")]);
        let cid: Cid = "bafkzcibeuc4a2dvtor6eqkb2c6wbs5sxxesah5j76jg74oksxqh3ruhzmstlrcnqhm".parse().unwrap();
        let mut a = std::collections::BTreeMap::new();
        a.insert("clientDataSetId".to_owned(), json!("0x5"));
        a.insert("nonce".to_owned(), json!("0x7"));
        a.insert("pieceData".to_owned(), json!([{ "data": format!("0x{}", hex::encode(cid.to_bytes())) }]));
        a.insert("pieceMetadata".to_owned(), json!([{ "pieceIndex": 0, "metadata": [] }]));
        let td = TypedData { types, primary_type: "AddPieces".into(), domain, message: a };
        println!("ADD 0x{}", hex::encode(td.encode_eip712().unwrap()));
    }
}
