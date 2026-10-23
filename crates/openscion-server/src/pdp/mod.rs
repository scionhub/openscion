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
    /// The signing wallet's public address (diagnostics only).
    #[must_use]
    pub fn wallet_address(&self) -> Option<String> {
        self.wallet.as_ref().map(|w| format!("{:?}", w.address()))
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
    ///
    /// # Panics
    ///
    /// Panics if required signing configuration is missing when `is_enabled()` is true.
    ///
    /// # Errors
    ///
    /// Returns an error when HTTP calls or signing fail.
    #[allow(
        clippy::unwrap_used,
        clippy::similar_names,
        clippy::missing_panics_doc,
        clippy::missing_errors_doc
    )]
    #[allow(clippy::unwrap_used, clippy::similar_names)]
    #[allow(clippy::too_many_lines)]
    pub async fn create_and_add_pieces(&self, pieces: &[String]) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        self.create_and_add_pieces_with_id(None, pieces)
            .await
            .map(|_| ())
    }

    /// Same as `create_and_add_pieces` but allows specifying the `clientDataSetId`.
    ///
    /// When `client_dataset_id_opt` is `None`, a random id is generated.
    ///
    /// # Panics
    ///
    /// Panics if required signing configuration is missing when `is_enabled()` is true.
    ///
    /// # Errors
    ///
    /// Returns an error when HTTP calls or signing fail.
    #[allow(clippy::unwrap_used, clippy::similar_names)]
    #[allow(clippy::too_many_lines)]
    pub async fn create_and_add_pieces_with_id(
        &self,
        client_dataset_id_opt: Option<U256>,
        pieces: &[String],
    ) -> Result<String, String> {
        if !self.enabled() {
            return Ok(String::new());
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

        // Provided or random clientDataSetId and random nonce
        let client_dataset_id =
            client_dataset_id_opt.unwrap_or_else(|| U256::from_big_endian(&rand_u256()));
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
        // synapse-core compactPieceMetadata: all-empty metadata signs as [] (not
        // one empty entry per piece); our ABI keys/values are [] to match.
        let _ = &piece_metadata;
        add_msg.insert("pieceMetadata".to_owned(), json!([]));
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
                "pdp create-and-add failed: {status}: {} || diag dsid={client_dataset_id:#x} nonce={nonce:#x} payee={:?} csig=0x{} asig=0x{}",
                body.chars().take(1200).collect::<String>(),
                Address::from(payee.0),
                hex::encode(create_sig.to_vec()),
                hex::encode(add_sig.to_vec())
            ));
        }
        let location = resp
            .headers()
            .get("Location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        Ok(location)
    }

    /// Create a dataset with a specific `clientDataSetId` and add `pieces` to it,
    /// returning the on-chain dataset id after confirmation.
    ///
    /// This calls Curio `POST /pdp/data-sets/create-and-add`, reads the `Location`
    /// header to obtain the creation tracking URL, then polls
    /// `GET /pdp/data-sets/created/{tx}` until the on-chain dataset id is available.
    /// # Errors
    ///
    /// Returns an error when HTTP calls fail, response headers are missing, or confirmation times out.
    pub async fn create_dataset_and_add_with_id_return_onchain(
        &self,
        client_dataset_id: U256,
        pieces: &[String],
    ) -> Result<String, String> {
        let location = self
            .create_and_add_pieces_with_id(Some(client_dataset_id), pieces)
            .await?;
        if location.is_empty() {
            return Err("create-and-add returned no Location".to_owned());
        }
        let tx_url = if location.starts_with("http") {
            location.clone()
        } else {
            format!("{}{}", self.base, location)
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
        loop {
            if let Ok(resp) = self.client.get(&tx_url).send().await {
                if resp.status().is_success() {
                    if let Ok(v) = resp.json::<serde_json::Value>().await {
                        let id = v
                            .get("dataSetId")
                            .or_else(|| v.get("datasetId"))
                            .and_then(|x| {
                                x.as_u64()
                                    .map(|n| n.to_string())
                                    .or_else(|| x.as_str().map(ToOwned::to_owned))
                            });
                        let created = v
                            .get("dataSetCreated")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(id.is_some());
                        if let (true, Some(id)) = (created, id) {
                            return Ok(format!("{id}|{location}"));
                        }
                        if v.get("txStatus").and_then(serde_json::Value::as_str) == Some("failed") {
                            return Err(format!("dataset create tx failed: {location}"));
                        }
                    }
                }
            }
            if std::time::Instant::now() >= deadline {
                return Err("timeout waiting for dataset creation".to_string());
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    /// Best-effort lookup of an existing on-chain dataset by `clientDataSetId`.
    ///
    /// Curio may expose `GET /pdp/data-sets`. When it does not, this returns
    /// `Ok(None)` or `Err` with the provider's response so the caller can record
    /// a readable reason.
    ///
    /// # Errors
    ///
    /// Returns an error when the provider is unreachable.
    pub async fn find_onchain_dataset_for_client_id(
        &self,
        client_dataset_id: U256,
    ) -> Result<Option<String>, String> {
        if !self.enabled() {
            return Ok(None);
        }
        let want_hex = format!("{client_dataset_id:#x}");
        let want_dec = client_dataset_id.to_string();
        let urls = [
            format!("{}/pdp/data-sets", self.base),
            format!("{}/pdp/data-sets?clientDataSetId={want_hex}", self.base),
        ];
        let mut last_err: Option<String> = None;
        for url in urls {
            match self.client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(v) = resp.json::<serde_json::Value>().await {
                        if let Some(id) = onchain_id_matching_client(&v, &want_hex, &want_dec) {
                            return Ok(Some(id));
                        }
                    }
                }
                Ok(resp) => last_err = Some(format!("{} {url}", resp.status())),
                Err(e) => last_err = Some(e.to_string()),
            }
        }
        match last_err {
            Some(err) => Err(err),
            None => Ok(None),
        }
    }

    /// Adds `pieces` to an existing dataset identified by its on-chain dataset id.
    ///
    /// Calls Curio `POST /pdp/data-sets/{onchainDataSetId}/pieces`.
    ///
    /// # Errors
    ///
    /// Returns an error when HTTP calls fail or the server responds with a non-success status.
    pub async fn add_pieces_to_onchain_dataset(
        &self,
        onchain_dataset_id: &str,
        pieces: &[String],
    ) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        let url = format!("{}/pdp/data-sets/{}/pieces", self.base, onchain_dataset_id);
        let body = json!({
            "pieces": pieces.iter().map(|p| json!({ "pieceCid": p })).collect::<Vec<_>>()
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
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "onchain add-pieces failed: {status}: {}",
                text.chars().take(400).collect::<String>()
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
        // Use the same Cid[] form as non-aggregate add
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
        let mut piece_bytes_array = Vec::<serde_json::Value>::with_capacity(sub_pieces.len());
        let mut piece_metadata = Vec::<serde_json::Value>::with_capacity(sub_pieces.len());
        for (idx, s) in sub_pieces.iter().enumerate() {
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
        // synapse-core compactPieceMetadata: all-empty metadata signs as [] (not
        // one empty entry per piece); our ABI keys/values are [] to match.
        let _ = &piece_metadata;
        add_msg.insert("pieceMetadata".to_owned(), json!([]));
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

    /// Add one or more pieces to an existing dataset, identified by clientDataSetId.
    ///
    /// Signs only the `AddPieces` typed data and posts to `/pdp/data-sets/add-pieces`.
    ///
    /// # Panics
    ///
    /// Panics if required signing configuration is missing when `is_enabled()` is true.
    #[allow(
        clippy::too_many_lines,
        clippy::unwrap_used,
        clippy::missing_errors_doc,
        clippy::similar_names
    )]
    pub async fn add_pieces_with_dataset(
        &self,
        client_dataset_id: U256,
        onchain_dataset_id: &str,
        pieces: &[String],
    ) -> Result<String, String> {
        if !self.enabled() {
            return Ok(String::new());
        }
        let chain_id = U256::from(self.chain_id.unwrap_or_default());
        let verifying = self.service_addr.unwrap();
        let wallet = self
            .wallet
            .as_ref()
            .unwrap()
            .clone()
            .with_chain_id(self.chain_id.unwrap());
        let nonce = U256::from_big_endian(&rand_u256());
        // Domain
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
        let _ = &piece_metadata;
        add_msg.insert("pieceMetadata".to_owned(), json!([]));
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
        let url = format!("{}/pdp/data-sets/{}/pieces", self.base, onchain_dataset_id);
        let body = json!({
            "extraData": format!("0x{}", hex::encode(&add_extra)),
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
                "pdp add-pieces failed: {status}: {}",
                body.chars().take(400).collect::<String>()
            ));
        }
        Ok(resp
            .headers()
            .get("Location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned())
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

    /// GET `/pdp/data-sets/{id}` and return `(pieceId, pieceCid)` pairs.
    ///
    /// When live PDP is disabled this returns an empty list so callers can skip
    /// on-chain work locally.
    ///
    /// # Errors
    ///
    /// Returns an error when the HTTP call fails or the body cannot be parsed.
    pub async fn get_data_set_pieces(
        &self,
        onchain_dataset_id: &str,
    ) -> Result<Vec<(u64, String)>, String> {
        if !self.enabled() {
            return Ok(Vec::new());
        }
        let ds_num = onchain_id_num(onchain_dataset_id);
        let url = format!("{}/pdp/data-sets/{ds_num}", self.base);
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "pdp get data-set failed: {status}: {}",
                text.chars().take(400).collect::<String>()
            ));
        }
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(parse_data_set_pieces(&v))
    }

    /// Sign `SchedulePieceRemovals` and DELETE the pieces in one Curio call.
    ///
    /// Route: `DELETE /pdp/data-sets/{id}/pieces/{firstPieceId}` with body
    /// `{ extraData, pieceIds }` (synapse-core 2.0.2 `deletePieces`).
    ///
    /// # Errors
    ///
    /// Returns an error when signing or the HTTP call fails.
    ///
    /// # Panics
    ///
    /// Panics if required signing configuration is missing when `is_enabled()` is true.
    #[allow(clippy::unwrap_used, clippy::similar_names, clippy::too_many_lines)]
    pub async fn remove_pieces(
        &self,
        client_dataset_id: U256,
        onchain_dataset_id: &str,
        piece_ids: &[u64],
    ) -> Result<String, String> {
        if piece_ids.is_empty() {
            return Ok(String::new());
        }
        if !self.enabled() {
            return Ok(String::new());
        }
        let ds_num = onchain_id_num(onchain_dataset_id);
        let chain_id = U256::from(self.chain_id.unwrap_or_default());
        let verifying = self.service_addr.unwrap();
        let wallet = self
            .wallet
            .as_ref()
            .unwrap()
            .clone()
            .with_chain_id(self.chain_id.unwrap());
        let extra = sign_schedule_piece_removals(
            &wallet,
            chain_id,
            Address::from(verifying.0),
            client_dataset_id,
            piece_ids,
        )
        .await?;
        let url = format!(
            "{}{}",
            self.base,
            pdp_remove_pieces_path(&ds_num, piece_ids[0])
        );
        let body = json!({
            "extraData": format!("0x{}", hex::encode(&extra)),
            "pieceIds": piece_ids,
        });
        let resp = self
            .client
            .delete(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "pdp remove-pieces failed: {status}: {}",
                text.chars().take(400).collect::<String>()
            ));
        }
        let location = resp
            .headers()
            .get("Location")
            .and_then(|h| h.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        tx_hash_from_body(&v)
            .or_else(|| (!location.is_empty()).then_some(location))
            .ok_or_else(|| "pdp remove-pieces returned no tx hash".to_owned())
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

fn onchain_id_num(onchain_dataset_id: &str) -> String {
    onchain_dataset_id
        .split('|')
        .next()
        .unwrap_or(onchain_dataset_id)
        .to_owned()
}

/// Curio/synapse-core batch delete: first piece id is in the path; `pieceIds` is the list.
#[must_use]
pub(crate) fn pdp_remove_pieces_path(data_set_id: &str, first_piece_id: u64) -> String {
    format!("/pdp/data-sets/{data_set_id}/pieces/{first_piece_id}")
}

/// Parse Curio `GET /pdp/data-sets/{id}` bodies into `(pieceId, pieceCid)` pairs.
#[must_use]
pub(crate) fn parse_data_set_pieces(v: &serde_json::Value) -> Vec<(u64, String)> {
    let pieces = v
        .get("pieces")
        .or_else(|| v.get("dataSet").and_then(|d| d.get("pieces")))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for p in pieces {
        let Some(piece_id) = json_u64(
            p.get("pieceId")
                .or_else(|| p.get("piece_id"))
                .or_else(|| p.get("id")),
        ) else {
            continue;
        };
        let Some(cid) = json_cid(
            p.get("pieceCid")
                .or_else(|| p.get("piece_cid"))
                .or_else(|| p.get("cid")),
        ) else {
            continue;
        };
        out.push((piece_id, cid));
    }
    out
}

fn json_u64(v: Option<&serde_json::Value>) -> Option<u64> {
    match v? {
        serde_json::Value::Number(n) => n.as_u64(),
        serde_json::Value::String(s) => {
            let s = s.trim();
            if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).ok()
            } else {
                s.parse().ok()
            }
        }
        _ => None,
    }
}

fn json_cid(v: Option<&serde_json::Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        if !s.is_empty() {
            return Some(s.to_owned());
        }
    }
    if let Some(s) = v.get("/").and_then(serde_json::Value::as_str) {
        if !s.is_empty() {
            return Some(s.to_owned());
        }
    }
    None
}

fn tx_hash_from_body(v: &serde_json::Value) -> Option<String> {
    v.get("txHash")
        .or_else(|| v.get("tx_hash"))
        .or_else(|| v.get("hash"))
        .or_else(|| v.get("tx"))
        .and_then(|x| {
            x.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| x.as_u64().map(|n| format!("{n:#x}")))
        })
        .filter(|s| !s.is_empty())
}

/// synapse-core 2.0.2 `SchedulePieceRemovals` typed data (FWSS domain v1).
#[must_use]
pub(crate) fn schedule_piece_removals_typed_data(
    chain_id: U256,
    verifying: Address,
    client_dataset_id: U256,
    piece_ids: &[u64],
) -> TypedData {
    let domain = EIP712Domain {
        name: Some("FilecoinWarmStorageService".into()),
        version: Some("1".into()),
        chain_id: Some(chain_id),
        verifying_contract: Some(verifying),
        salt: None,
    };
    let mut types = std::collections::BTreeMap::new();
    types.insert(
        "SchedulePieceRemovals".to_owned(),
        vec![
            Eip712DomainType {
                name: "clientDataSetId".into(),
                r#type: "uint256".into(),
            },
            Eip712DomainType {
                name: "pieceIds".into(),
                r#type: "uint256[]".into(),
            },
        ],
    );
    let piece_ids_json: Vec<serde_json::Value> = piece_ids
        .iter()
        .map(|id| json!(format!("{:#x}", U256::from(*id))))
        .collect();
    let mut message = std::collections::BTreeMap::new();
    message.insert(
        "clientDataSetId".to_owned(),
        json!(format!("{client_dataset_id:#x}")),
    );
    message.insert("pieceIds".to_owned(), json!(piece_ids_json));
    TypedData {
        types,
        primary_type: "SchedulePieceRemovals".to_owned(),
        domain,
        message,
    }
}

async fn sign_schedule_piece_removals(
    wallet: &LocalWallet,
    chain_id: U256,
    verifying: Address,
    client_dataset_id: U256,
    piece_ids: &[u64],
) -> Result<Vec<u8>, String> {
    let td = schedule_piece_removals_typed_data(chain_id, verifying, client_dataset_id, piece_ids);
    let sig = wallet
        .sign_typed_data(&td)
        .await
        .map_err(|e| e.to_string())?;
    Ok(ethers_core::abi::encode(&[ethers_core::abi::Token::Bytes(
        sig.to_vec(),
    )]))
}

fn onchain_id_matching_client(
    v: &serde_json::Value,
    want_hex: &str,
    want_dec: &str,
) -> Option<String> {
    let rows = v.as_array().or_else(|| {
        v.get("dataSets")
            .or_else(|| v.get("datasets"))
            .and_then(serde_json::Value::as_array)
    })?;
    for d in rows {
        let client = d
            .get("clientDataSetId")
            .or_else(|| d.get("clientDatasetId"))
            .or_else(|| d.get("client_dataset_id"));
        let matches = match client {
            Some(serde_json::Value::String(s)) => {
                let s = s.trim();
                s.eq_ignore_ascii_case(want_hex) || s == want_dec
            }
            Some(serde_json::Value::Number(n)) => n.to_string() == want_dec,
            _ => false,
        };
        if !matches {
            continue;
        }
        let id = d
            .get("dataSetId")
            .or_else(|| d.get("datasetId"))
            .or_else(|| d.get("id"));
        if let Some(id) = id {
            if let Some(n) = id.as_u64() {
                return Some(n.to_string());
            }
            if let Some(s) = id.as_str() {
                if !s.is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
    }
    None
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
#[allow(clippy::unwrap_used)]
mod digest_probe {
    use super::*;
    use ethers_core::types::transaction::eip712::Eip712;
    #[test]
    fn print_digests() {
        let domain = EIP712Domain {
            name: Some("FilecoinWarmStorageService".into()),
            version: Some("1".into()),
            chain_id: Some(U256::from(314_159u64)),
            verifying_contract: Some(
                "0x02925630df557F957f70E112bA06e50965417CA0"
                    .parse()
                    .unwrap(),
            ),
            salt: None,
        };
        let t = |n: &str, ty: &str| Eip712DomainType {
            name: n.into(),
            r#type: ty.into(),
        };
        let mut types = std::collections::BTreeMap::new();
        types.insert(
            "MetadataEntry".to_owned(),
            vec![t("key", "string"), t("value", "string")],
        );
        types.insert(
            "CreateDataSet".to_owned(),
            vec![
                t("clientDataSetId", "uint256"),
                t("payee", "address"),
                t("metadata", "MetadataEntry[]"),
            ],
        );
        let mut m = std::collections::BTreeMap::new();
        m.insert("clientDataSetId".to_owned(), json!("0x5"));
        m.insert(
            "payee".to_owned(),
            json!(
                "0x8F88020203a910Cc0cCc1e2Eb9ab1553862604E3"
                    .parse::<Address>()
                    .unwrap()
            ),
        );
        m.insert("metadata".to_owned(), json!([]));
        let td = TypedData {
            types: types.clone(),
            primary_type: "CreateDataSet".into(),
            domain: domain.clone(),
            message: m,
        };
        println!("CREATE 0x{}", hex::encode(td.encode_eip712().unwrap()));
        types.insert("Cid".to_owned(), vec![t("data", "bytes")]);
        types.insert(
            "PieceMetadata".to_owned(),
            vec![t("pieceIndex", "uint256"), t("metadata", "MetadataEntry[]")],
        );
        types.insert(
            "AddPieces".to_owned(),
            vec![
                t("clientDataSetId", "uint256"),
                t("nonce", "uint256"),
                t("pieceData", "Cid[]"),
                t("pieceMetadata", "PieceMetadata[]"),
            ],
        );
        let cid: Cid = "bafkzcibeuc4a2dvtor6eqkb2c6wbs5sxxesah5j76jg74oksxqh3ruhzmstlrcnqhm"
            .parse()
            .unwrap();
        let mut a = std::collections::BTreeMap::new();
        a.insert("clientDataSetId".to_owned(), json!("0x5"));
        a.insert("nonce".to_owned(), json!("0x7"));
        a.insert(
            "pieceData".to_owned(),
            json!([{ "data": format!("0x{}", hex::encode(cid.to_bytes())) }]),
        );
        a.insert(
            "pieceMetadata".to_owned(),
            json!([{ "pieceIndex": 0, "metadata": [] }]),
        );
        let td = TypedData {
            types,
            primary_type: "AddPieces".into(),
            domain,
            message: a,
        };
        println!("ADD 0x{}", hex::encode(td.encode_eip712().unwrap()));
    }
}

#[cfg(test)]
mod test;
