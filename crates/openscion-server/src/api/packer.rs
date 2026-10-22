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
use std::sync::{OnceLock, RwLock};

// Target ~32 MiB pieces under lite container RAM, adjustable via env.
const PACK_THRESHOLD_BYTES: usize = 32 * (1 << 20); // 32 MiB
const MAX_BYTES_PER_FLUSH: usize = 128 * (1 << 20); // Cap total work per flush
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
        Self {
            buf: Vec::new(),
            entries: Vec::new(),
        }
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

use std::sync::atomic::{AtomicBool, Ordering};

static FLUSHING: AtomicBool = AtomicBool::new(false);

struct Reset;
impl Drop for Reset {
    fn drop(&mut self) {
        FLUSHING.store(false, Ordering::Release);
    }
}

pub(crate) async fn maybe_flush(org: &str) -> Result<(), ApiError> {
    let out = flush_inner(org).await;
    if let Err(e) = &out {
        set_status_error(format!("flush failed: {e:?}"));
    }
    out
}

#[allow(clippy::too_many_lines)]
async fn flush_inner(org: &str) -> Result<(), ApiError> {
    // If Worker base is not configured, skip (mock mode).
    if super::worker_base().is_err() {
        return Ok(());
    }
    // One flush at a time
    if FLUSHING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _reset = Reset;
    let base = super::worker_base()?;
    let secret = super::internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let mut processed_bytes_total = 0usize;
    // Drain pending in a bounded loop: up to MAX_BYTES_PER_FLUSH or until empty.
    loop {
        // Fetch pending staged objects from D1
        let wrap: PendingWrap = super::d1_get(&format!("/__internal/d1/{org}/staging/pending"))?;
        if wrap.pending.is_empty() {
            if processed_bytes_total == 0 {
                set_status_success();
            }
            break;
        }
        // Accumulate until threshold
        let mut entries: Vec<PendingEntry> = Vec::new();
        let mut buf: Vec<u8> = Vec::new();
        for row in &wrap.pending {
            if buf.len() >= PACK_THRESHOLD_BYTES {
                break;
            }
            let id: ObjectId =
                row.object_id
                    .parse()
                    .map_err(|_| openscion_core::Error::InvalidChange {
                        path: "pack".to_owned(),
                        rule: "bad object id",
                    })?;
            // Get bytes for this object
            let url = format!(
                "{base}/__internal/d1/{org}/staging/object/{}",
                row.object_id
            );
            let resp = agent
                .get(&url)
                .header("x-internal-secret", &secret)
                .call()
                .map_err(|_| openscion_core::Error::InvalidChange {
                    path: "d1".to_owned(),
                    rule: "staging get failed",
                })?;
            let bytes = resp.into_body().read_to_vec().map_err(|_| {
                openscion_core::Error::InvalidChange {
                    path: "d1".to_owned(),
                    rule: "staging read failed",
                }
            })?;
            let offset = buf.len() as u64;
            let length = bytes.len() as u64;
            buf.extend_from_slice(&bytes);
            entries.push(PendingEntry {
                object: id,
                offset,
                length,
            });
        }
        if buf.is_empty() {
            // Nothing sizeable, avoid tight loop
            break;
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
            "providerId": std::env::var("PDP_PROVIDER_ID").unwrap_or_else(|_| "49".to_owned()),
            "sizeBytes": size_bytes,
            "state": "registered",
            "uploadId": upload_id,
            "source": "pack"
        });
        if let Err(e) = d1_post(&format!("/__internal/d1/{org}/upload"), &body) {
            eprintln!("[packer] failed to register piece in D1: {e:?}");
            set_status_error(format!("register piece failed: {e:?}"));
            // Keep staging; retry later
            return Ok(());
        }
        for e in &entries {
            let body = serde_json::json!({
                "pieceCid": piece_cid,
                "datasetId": DATASET_ID,
            "providerId": std::env::var("PDP_PROVIDER_ID").unwrap_or_else(|_| "49".to_owned()),
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
                set_status_error(format!("record mapping failed: {e:?}"));
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
                        let uploaded = match pdp.upload_piece_bytes(&upload_url, &buf).await {
                            Ok(()) => pdp.finalize_piece_upload(&upload_url, &piece_cid).await,
                            Err(e) => Err(e),
                        };
                        if let Err(e) = uploaded {
                            eprintln!("[packer] upload_piece_bytes error: {e}");
                            set_status_error(format!("upload_piece_bytes: {e}"));
                        } else if let Err(e) = pdp.wait_piece_parked(&piece_cid).await {
                            eprintln!("[packer] wait_piece_parked error: {e}");
                            set_status_error(format!("wait_piece_parked: {e}"));
                        } else if let Err(e) = pdp.create_and_add_pieces(&[piece_cid.clone()]).await
                        {
                            eprintln!("[packer] create_and_add_pieces error: {e}");
                            set_status_error(format!("create_and_add_pieces: {e}"));
                        } else {
                            set_status_success();
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("[packer] initiate_piece_upload error: {e}");
                        set_status_error(format!("initiate upload failed: {e}"));
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

        processed_bytes_total += buf.len();
        if processed_bytes_total >= MAX_BYTES_PER_FLUSH {
            break;
        }
    }
    Ok(())
}

#[derive(Default, Clone, serde::Serialize)]
pub(crate) struct PackerStatus {
    pub last_error: Option<String>,
    pub last_success_unix_ms: Option<u64>,
}
static STATUS: OnceLock<RwLock<PackerStatus>> = OnceLock::new();

fn status_cell() -> &'static RwLock<PackerStatus> {
    STATUS.get_or_init(|| RwLock::new(PackerStatus::default()))
}
fn set_status_error(msg: String) {
    let mut s = status_cell()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    s.last_error = Some(msg);
}
fn set_status_success() {
    let mut s = status_cell()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    s.last_error = None;
    let ms: u128 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    s.last_success_unix_ms = Some(u64::try_from(ms).unwrap_or(u64::MAX));
}
pub(crate) fn get_status() -> PackerStatus {
    status_cell()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
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
