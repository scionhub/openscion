//! Staging packer: accumulates uploaded objects into a piece and flushes
//! when size or time thresholds are reached. On flush:
//! - computes PieceCID (CommP v2) over the concatenated bytes,
//! - calls PDP create-and-add (mock when not configured),
//! - records object -> (piece, offset, length) mappings in D1.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use openscion_core::{filecoin::{compute_piece_cid_minimal, compute_piece_cid_proofs}, ObjectId};

use super::{d1_post, ApiError};
use crate::pdp::PdpClient;

const PACK_THRESHOLD_BYTES: usize = 1 << 20; // 1 MiB
const PACK_TIME_THRESHOLD: Duration = Duration::from_secs(5);
const DATASET_ID: &str = "default";

struct PendingEntry {
    object: ObjectId,
    offset: u64,
    length: u64,
}

struct Packer {
    buf: Vec<u8>,
    entries: Vec<PendingEntry>,
    started: Instant,
}

impl Packer {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            entries: Vec::new(),
            started: Instant::now(),
        }
    }

    fn add(&mut self, object: ObjectId, bytes: &[u8]) -> (u64, u64) {
        let offset = self.buf.len() as u64;
        self.buf.extend_from_slice(bytes);
        let length = bytes.len() as u64;
        self.entries.push(PendingEntry { object, offset, length });
        (offset, length)
    }

    fn should_flush(&self) -> bool {
        self.buf.len() >= PACK_THRESHOLD_BYTES || self.started.elapsed() >= PACK_TIME_THRESHOLD
    }
}

static PACKERS: OnceLock<RwLock<HashMap<String, Packer>>> = OnceLock::new();

fn get_packers() -> &'static RwLock<HashMap<String, Packer>> {
    PACKERS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn packer_for(_org: &str) -> std::sync::RwLockWriteGuard<'static, HashMap<String, Packer>> {
    get_packers().write().unwrap()
}

pub fn add_object(org: &str, object: ObjectId, bytes: &[u8]) -> Result<(), ApiError> {
    let mut map = packer_for(org);
    let packer = map.entry(org.to_owned()).or_insert_with(Packer::new);
    let _ = packer.add(object, bytes);
    Ok(())
}

pub async fn maybe_flush(org: &str) -> Result<(), ApiError> {
    // Take the current packer buffer if thresholds met
    let (buf, entries) = {
        let mut map = packer_for(org);
        let packer = map.entry(org.to_owned()).or_insert_with(Packer::new);
        if !packer.should_flush() || packer.buf.is_empty() {
            return Ok(());
        }
        let taken_buf = std::mem::take(&mut packer.buf);
        let taken_entries = std::mem::take(&mut packer.entries);
        packer.started = Instant::now();
        (taken_buf, taken_entries)
    };

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
    let _ = d1_post(&format!("/__internal/d1/{org}/upload"), &body);
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
        let _ = d1_post(&format!("/__internal/d1/{org}/upload"), &body);
    }

    // Kick PDP add for the new piece
    let pdp = PdpClient::from_env();
    if pdp.is_enabled() {
        let _ = pdp.create_and_add_pieces(&[piece_cid]).await;
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
        let _ = compute_piece_cid_minimal(&p.buf).expect("minimal commP");
    }
}

