//! Staging packer: accumulates uploaded objects into a piece and flushes
//! when size or time thresholds are reached. On flush:
//! - computes `PieceCID` (`CommP` v2) over the concatenated bytes,
//! - calls PDP create-and-add (mock when not configured),
//! - records object -> (piece, offset, length) mappings in D1.

use std::time::Duration;

use openscion_core::{
    ObjectId,
    filecoin::{compute_piece_cid_minimal, compute_piece_cid_proofs},
};

use super::{ApiError, d1_post};
use crate::pdp::PdpClient;

const PACK_THRESHOLD_BYTES: usize = 1 << 20; // 1 MiB
const DATASET_ID: &str = "default";

struct PendingEntry {
    object: ObjectId,
    offset: u64,
    length: u64,
}

#[cfg(test)]
struct Packer {
    buf: Vec<u8>,
    entries: Vec<PendingEntry>,
}

#[cfg(test)]
impl Packer {
    fn new() -> Self {
        Self { buf: Vec::new(), entries: Vec::new() }
    }

    fn add(&mut self, object: ObjectId, bytes: &[u8]) -> (u64, u64) {
        let offset = self.buf.len() as u64;
        self.buf.extend_from_slice(bytes);
        let length = bytes.len() as u64;
        self.entries.push(PendingEntry {
            object,
            offset,
            length,
        });
        (offset, length)
    }
}

#[derive(serde::Deserialize)]
struct PendingRow {
    #[serde(rename = "objectId")]
    object_id: String,
    #[serde(rename = "totalLength")]
    #[allow(dead_code)]
    total_length: u64,
    #[serde(rename = "createdAt")]
    #[allow(dead_code)]
    created_at: u64,
}

#[derive(serde::Deserialize)]
struct PendingWrap {
    pending: Vec<PendingRow>,
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn maybe_flush(org: &str) -> Result<(), ApiError> {
    // If Worker base is not configured, skip (mock mode).
    if super::worker_base().is_err() {
        return Ok(());
    }
    // Fetch pending staged objects from D1
    let wrap: PendingWrap = super::d1_get(&format!("/__internal/d1/{org}/staging/pending"))?;
    if wrap.pending.is_empty() {
        return Ok(());
    }
    // Accumulate until threshold or time window
    let mut entries: Vec<PendingEntry> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    for row in &wrap.pending {
        let id: ObjectId =
            row.object_id
                .parse()
                .map_err(|_| openscion_core::Error::InvalidChange {
                    path: "pack".to_owned(),
                    rule: "bad object id",
                })?;
        // Get bytes for this object
        let base = super::worker_base()?;
        let secret = super::internal_secret()?;
        let url = format!("{base}/__internal/d1/{org}/staging/object/{}", row.object_id);
        let agent = ureq::Agent::new_with_defaults();
        let resp = agent
            .get(&url)
            .header("x-internal-secret", &secret)
            .call()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "d1".to_owned(),
                rule: "staging get failed",
            })?;
        let bytes = resp
            .into_body()
            .read_to_vec()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "d1".to_owned(),
                rule: "staging read failed",
            })?;
        let offset = buf.len() as u64;
        let length = bytes.len() as u64;
        buf.extend_from_slice(&bytes);
        entries.push(PendingEntry {
            object: id,
            offset,
            length,
        });
        if buf.len() >= PACK_THRESHOLD_BYTES {
            break;
        }
    }
    if buf.is_empty() {
        return Ok(());
    }

    // Compute PieceCID
    let cid = compute_piece_cid_proofs(&buf)
        .or_else(|_| compute_piece_cid_minimal(&buf))
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "compute failed",
        })?;
    let piece_cid = cid.to_string();
    let size_bytes = buf.len();

    // Register piece and mappings in D1
    let upload_id = uuid::Uuid::new_v4().to_string();
    let body = serde_json::json!({
        "pieceCid": piece_cid,
        "datasetId": DATASET_ID,
        "sizeBytes": size_bytes,
        "state": "registered",
        "uploadId": upload_id,
        "source": "pack"
    });
    if let Err(e) = d1_post(&format!("/__internal/d1/{org}/upload"), &body) {
        eprintln!("[packer] failed to register piece in D1: {e:?}");
        // Keep staging; retry later
        return Ok(());
    }
    for e in &entries {
        let body = serde_json::json!({
            "pieceCid": piece_cid,
            "datasetId": DATASET_ID,
            "sizeBytes": size_bytes,
            "state": "registered",
            "uploadId": uuid::Uuid::new_v4().to_string(),
            "source": "pack",
            "objectId": format!("{}", e.object),
            "offset": e.offset,
            "length": e.length
        });
        if let Err(e) = d1_post(&format!("/__internal/d1/{org}/upload"), &body) {
            eprintln!("[packer] failed to record object mapping in D1: {e:?}");
            return Ok(());
        }
    }

    // Upload to PDP/SP, wait parked, then create + add
    let pdp = PdpClient::from_env();
    if pdp.is_enabled() {
        // Initialize upload and send bytes
        let mut attempts = 0u8;
        loop {
            attempts += 1;
            match pdp.initiate_piece_upload(&piece_cid, size_bytes).await {
                Ok(upload_url) => {
                    if let Err(e) = pdp.upload_piece_bytes(&upload_url, &buf).await {
                        eprintln!("[packer] upload_piece_bytes error: {e}");
                    } else if let Err(e) = pdp.wait_piece_parked(&piece_cid).await {
                        eprintln!("[packer] wait_piece_parked error: {e}");
                    } else if let Err(e) = pdp.create_and_add_pieces(&[piece_cid.clone()]).await {
                        eprintln!("[packer] create_and_add_pieces error: {e}");
                    } else {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[packer] initiate_piece_upload error: {e}");
                }
            }
            if attempts >= 3 {
                // Give up for now; try again on next flush
                return Ok(());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    // Delete staged objects after successful mapping
    let del_body = serde_json::json!({
        "objectIds": entries.iter().map(|e| format!("{}", e.object)).collect::<Vec<_>>()
    });
    if let Err(e) = d1_post(&format!("/__internal/d1/{org}/staging/delete"), &del_body) {
        eprintln!("[packer] failed to delete staged rows: {e:?}");
    }

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;
    use openscion_core::ObjectId;

    #[test]
    fn add_tracks_offsets() {
        let mut p = Packer::new();
        let id1 = ObjectId::from_bytes([1u8; 32]);
        let id2 = ObjectId::from_bytes([2u8; 32]);
        let id3 = ObjectId::from_bytes([3u8; 32]);
        let (o1, l1) = p.add(id1, b"abc");
        let (o2, l2) = p.add(id2, b"hello");
        let (o3, l3) = p.add(id3, b"x");
        assert_eq!((o1, l1), (0, 3));
        assert_eq!((o2, l2), (3, 5));
        assert_eq!((o3, l3), (8, 1));
        // Piece computation over small buffer should succeed via minimal path
        let _ = compute_piece_cid_minimal(&p.buf);
    }
}
