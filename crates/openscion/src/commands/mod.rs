//! The working-copy commands: `import`, `commit`, `clone`, `merge`, `pull`,
//! `push`, `branch`, `status`, `stash`, and `cherry-pick`.
//!
//! Each command talks to the server through a [`ServerClient`] and to the
//! disk through the working-copy module, and returns a summary the CLI
//! prints.
//!
//! - **import** records a whole directory as the repository's first
//!   changeset and creates the ref. Every file is uploaded through the
//!   bundle path and recorded on the `RepoDO` tip `file-map` (`COMMP` `PieceCID`).
//! - **commit** records what changed since the base changeset, uploads only
//!   new or changed blobs through the same bundle path, and moves the ref
//!   from the base to the new changeset by compare-and-swap. The tip
//!   `file-map` is updated for changed and deleted paths — changeset
//!   metadata no longer copies a `pcid:` snapshot. If someone else moved
//!   the ref first the swap fails; there is no rebase yet, so the
//!   changeset stays in the log unreferenced and the error is reported.
//! - **clone** reads the ref, fetches the trees breadth first — one request
//!   per level — and then the blobs in batches, verifying every id. Blobs
//!   named in the tip `file-map` (or leftover `pcid:` metadata) are
//!   Range-GETs from the storage provider; any path without one falls back
//!   to the server objects endpoint. With a path it fetches only the trees
//!   on the way to that directory and the files under it.
//! - **sync** three-way-merges the working copy with a target ref (default
//!   `main`). The next commit's first parent is that target so a pull-request
//!   merge can fast-forward. Conflicting paths get git-style markers.
//!
//! [`ServerClient`]: crate::ServerClient

mod bisect;
mod branch;
mod cherry;
mod clone;
mod commit;
mod diff3;
mod history;
mod hook;
mod import;
mod remote;
mod stash;
mod submodule;
mod sync;
mod tag;
mod transfer;

pub(crate) use bisect::mark as bisect_mark;
pub(crate) use bisect::{
    Advance, Mark, reset as bisect_reset, run as bisect_run, start as bisect_start,
};
pub(crate) use branch::repo_client;
pub(crate) use branch::{create as create_branch, delete as delete_branch, list as list_branches};
pub(crate) use branch::{org_is_member, switch as switch_branch};
pub(crate) use cherry::cherry_pick;
pub(crate) use clone::checkout;
pub(crate) use clone::{clone, clone_at};
pub(crate) use commit::{PushOutcome, commit_ref, preview_changes, publish_ref, push};
pub(crate) use history::{LogFilter, blame, log, show};
pub(crate) use hook::{add as add_hook, list as list_hooks, remove as remove_hook};
pub(crate) use import::import;
pub(crate) use remote::{add as add_remote, list as list_remotes, remove as remove_remote};
pub(crate) use remote::{rename as rename_remote, set_url as set_remote_url};
pub(crate) use stash::{
    apply as stash_apply, drop as stash_drop, list as stash_list, push as stash_push,
};
pub(crate) use submodule::{
    add as add_submodule, pin_drift_lines, status as submodule_status, sync as sync_submodules,
    update as update_submodules,
};
pub(crate) use sync::{SyncSummary, sync};
pub(crate) use tag::{
    create as create_tag, delete as delete_tag, format_list as format_tag_list, list as list_tags,
};
pub(crate) use transfer::{CrossPush, fetch, pull, push_to};

use std::collections::HashSet;

#[cfg(test)]
use std::collections::BTreeMap;

use openscion_core::filecoin::{compute_piece_cid_minimal, compute_piece_cid_proofs};
use openscion_core::{FrameWriter, ObjectId};

use crate::{Error, RepoClient, Result};

fn write_fmt(out: &mut String, args: std::fmt::Arguments<'_>) {
    use std::fmt::Write as _;
    out.write_fmt(args).ok();
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write_fmt(&mut out, format_args!("{byte:02x}"));
    }
    out
}

/// Changeset metadata key prefix mapping a repo path to its `PieceCID`.
#[cfg(test)]
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
    let blobs = select_missing(client, blobs);
    let mut requests = 0;
    let mut frames = FrameWriter::new();
    for (id, bytes) in &blobs {
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

/// Blobs whose COMMP `PieceCID` the server does not already have.
///
/// `PieceCID` is the cross-server content identity. When that endpoint is
/// missing, fall back to blake3 object ids, then upload everything.
fn select_missing(client: &RepoClient, blobs: &[(ObjectId, Vec<u8>)]) -> Vec<(ObjectId, Vec<u8>)> {
    if blobs.is_empty() {
        return Vec::new();
    }
    let mut cids = Vec::with_capacity(blobs.len());
    let mut tagged = Vec::with_capacity(blobs.len());
    for (id, bytes) in blobs {
        let cid = piece_cid_of(bytes).ok();
        if let Some(cid) = &cid {
            cids.push(cid.clone());
        }
        tagged.push((*id, bytes.clone(), cid));
    }
    if !cids.is_empty()
        && let Ok(missing) = client.missing_pieces(&cids)
    {
        let missing: HashSet<String> = missing.into_iter().collect();
        return tagged
            .into_iter()
            .filter_map(|(id, bytes, cid)| match &cid {
                Some(cid) if !missing.contains(cid) => None,
                _ => Some((id, bytes)),
            })
            .collect();
    }
    let ids: Vec<ObjectId> = blobs.iter().map(|(id, _)| *id).collect();
    if let Ok(missing) = client.missing_objects(&ids) {
        let missing: HashSet<ObjectId> = missing.into_iter().collect();
        return blobs
            .iter()
            .filter(|(id, _)| missing.contains(id))
            .cloned()
            .collect();
    }
    blobs.to_vec()
}

/// Changeset metadata key `pcid:<path>` for a working-copy path.
#[cfg(test)]
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
#[cfg(test)]
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
