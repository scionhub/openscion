//! The working-copy commands: `import`, `commit`, and `clone`.
//!
//! Each command talks to the server through a [`ServerClient`] and to the
//! disk through the working-copy module, and returns a summary the CLI
//! prints.
//!
//! - **import** records a whole directory as the repository's first
//!   changeset and creates the ref. Every file is uploaded through the
//!   bundle path and recorded as `pcid:<path>` metadata.
//! - **commit** records what changed since the base changeset, uploads only
//!   new or changed blobs through the same bundle path, and moves the ref
//!   from the base to the new changeset by compare-and-swap. Changeset
//!   metadata carries `pcid:<path>` forward for unchanged files. If someone
//!   else moved the ref first the swap fails; there is no rebase yet, so the
//!   changeset stays in the log unreferenced and the error is reported.
//! - **clone** reads the ref, fetches the trees breadth first — one request
//!   per level — and then the blobs in batches, verifying every id. Blobs
//!   with a `pcid:` entry are Range-GETs from the storage provider; any path
//!   without one falls back to the server objects endpoint. With a path it
//!   fetches only the trees on the way to that directory and the files
//!   under it.
//!
//! [`ServerClient`]: crate::ServerClient

mod clone;
mod commit;
mod import;

pub(crate) use clone::clone;
pub(crate) use commit::{commit_ref, publish_ref};
pub(crate) use import::import;

use std::collections::{BTreeMap, HashSet};

use openscion_core::filecoin::{compute_piece_cid_minimal, compute_piece_cid_proofs};
use openscion_core::{FrameWriter, ObjectId};

use crate::{Error, RepoClient, Result};

/// Changeset metadata key prefix mapping a repo path to its `PieceCID`.
const PCID_META_PREFIX: &str = "pcid:";

/// Upload batches are cut at this many bytes of blob data.
const UPLOAD_BATCH_BYTES: usize = 4 << 20;
/// The bytes a frame adds before its body: the id and a `u64` length.
const FRAME_HEADER: usize = ObjectId::LEN + 8;
/// Fetch requests name at most this many objects.
const FETCH_BATCH: usize = 4096;

/// Uploads blobs in batches of at most [`UPLOAD_BATCH_BYTES`].
fn upload(client: &RepoClient, blobs: &[(ObjectId, Vec<u8>)]) -> Result<usize> {
    upload_in_batches(client, blobs, UPLOAD_BATCH_BYTES)
}

/// Uploads blobs, starting a new request whenever the next blob would push
/// the current one past `batch_bytes`. Returns the number of requests sent.
fn upload_in_batches(
    client: &RepoClient,
    blobs: &[(ObjectId, Vec<u8>)],
    batch_bytes: usize,
) -> Result<usize> {
    // Ask the server which ids are already present; skip them.
    if !blobs.is_empty() {
        let ids: Vec<ObjectId> = blobs.iter().map(|(id, _)| *id).collect();
        if let Ok(missing) = client.missing_objects(&ids) {
            if missing.len() < ids.len() {
                let set: std::collections::HashSet<ObjectId> = missing.into_iter().collect();
                let filtered: Vec<(ObjectId, Vec<u8>)> = blobs
                    .iter()
                    .filter(|(id, _)| set.contains(id))
                    .cloned()
                    .collect();
                return upload_in_batches(client, &filtered, batch_bytes);
            }
        }
    }
    let mut requests = 0;
    let mut frames = FrameWriter::new();
    for (id, bytes) in blobs {
        let frame = FRAME_HEADER + bytes.len();
        if !frames.is_empty() && frames.len() + frame > batch_bytes {
            requests += 1;
            client.upload_blobs(&std::mem::take(&mut frames).finish())?;
        }
        frames.push(*id, bytes);
    }
    if !frames.is_empty() {
        requests += 1;
        client.upload_blobs(&frames.finish())?;
    }
    Ok(requests)
}

/// Changeset metadata key `pcid:<path>` for a working-copy path.
fn pcid_meta_key(path: &str) -> String {
    format!("{PCID_META_PREFIX}{path}")
}

/// Client-side `PieceCID` of `bytes`, matching the import/commit upload path.
fn piece_cid_of(bytes: &[u8]) -> Result<String> {
    compute_piece_cid_proofs(bytes)
        .or_else(|_| compute_piece_cid_minimal(bytes))
        .map(|cid| cid.to_string())
        .map_err(|_| Error::Decode {
            url: "piece".to_owned(),
            message: "compute failed".to_owned(),
        })
}

/// Builds `pcid:<path>` metadata for a commit.
///
/// Parent `pcid:` entries are kept for unchanged paths, replaced for
/// `upserts` (path → `PieceCID`), and dropped for `deleted` paths. Other
/// parent metadata keys are not copied: they describe the parent changeset.
fn merge_pcid_metadata(
    parent: &BTreeMap<String, String>,
    upserts: &BTreeMap<String, String>,
    deleted: &HashSet<String>,
) -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::new();
    for (key, value) in parent {
        let Some(path) = key.strip_prefix(PCID_META_PREFIX) else {
            continue;
        };
        if deleted.contains(path) || upserts.contains_key(path) {
            continue;
        }
        metadata.insert(key.clone(), value.clone());
    }
    for (path, cid) in upserts {
        metadata.insert(pcid_meta_key(path), cid.clone());
    }
    metadata
}

#[cfg(test)]
mod test;
