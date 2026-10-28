//! Local git-like stash of uncommitted working-copy changes.
//!
//! Stashes live under `.scn/stash/` on disk. They are **not** uploaded to
//! the server CAS; only restoring a clean base tree fetches recorded blobs.

use std::path::{Path, PathBuf};

use openscion_core::EntryKind;
use serde::{Deserialize, Serialize};

use super::clone;
use crate::workcopy::{self, ChangeKind, FileState, STATE_DIR, ScanOptions};
use crate::{Error, Result, ServerClient};

const STASH_DIR: &str = "stash";
const INDEX_FILE: &str = "index.json";
const META_FILE: &str = "meta.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StashIndex {
    #[serde(default)]
    next_id: u64,
    #[serde(default)]
    entries: Vec<StashMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StashMeta {
    id: u64,
    message: String,
    created_at: u64,
    base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StashFileMeta {
    path: String,
    change: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kind: Option<EntryKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StashPayload {
    message: String,
    created_at: u64,
    base: String,
    files: Vec<StashFileMeta>,
}

/// One line of `scn stash list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StashListEntry {
    /// `stash@{n}` index, 0 = latest.
    pub index: usize,
    /// User or default message.
    pub message: String,
}

/// Result of `stash push`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StashPushSummary {
    /// `stash@{n}` after the push (always 0 for a new latest).
    pub index: usize,
    /// How many paths were saved.
    pub changes: usize,
    /// Message stored with the entry.
    pub message: String,
}

fn stash_root(root: &Path) -> PathBuf {
    root.join(STATE_DIR).join(STASH_DIR)
}

fn index_path(root: &Path) -> PathBuf {
    stash_root(root).join(INDEX_FILE)
}

fn entry_dir(root: &Path, id: u64) -> PathBuf {
    stash_root(root).join(id.to_string())
}

fn blob_path(root: &Path, id: u64, repo_path: &str) -> PathBuf {
    entry_dir(root, id).join("files").join(repo_path)
}

fn load_index(root: &Path) -> Result<StashIndex> {
    let path = index_path(root);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| Error::BadState {
            path,
            message: error.to_string(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StashIndex {
            next_id: 1,
            entries: Vec::new(),
        }),
        Err(source) => Err(Error::Io { path, source }),
    }
}

fn save_index(root: &Path, index: &StashIndex) -> Result<()> {
    let dir = stash_root(root);
    std::fs::create_dir_all(&dir).map_err(workcopy::io_error(&dir))?;
    let path = index_path(root);
    let bytes = serde_json::to_vec_pretty(index).map_err(|error| Error::BadState {
        path: path.clone(),
        message: error.to_string(),
    })?;
    std::fs::write(&path, bytes).map_err(workcopy::io_error(&path))
}

fn load_payload(root: &Path, id: u64) -> Result<StashPayload> {
    let path = entry_dir(root, id).join(META_FILE);
    let bytes = std::fs::read(&path).map_err(|source| Error::Io {
        path: path.clone(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|error| Error::BadState {
        path,
        message: error.to_string(),
    })
}

fn save_payload(root: &Path, id: u64, payload: &StashPayload) -> Result<()> {
    let dir = entry_dir(root, id);
    std::fs::create_dir_all(&dir).map_err(workcopy::io_error(&dir))?;
    let path = dir.join(META_FILE);
    let bytes = serde_json::to_vec_pretty(payload).map_err(|error| Error::BadState {
        path: path.clone(),
        message: error.to_string(),
    })?;
    std::fs::write(&path, bytes).map_err(workcopy::io_error(&path))
}

fn write_stashed_bytes(root: &Path, id: u64, repo_path: &str, bytes: &[u8]) -> Result<()> {
    let path = blob_path(root, id, repo_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(workcopy::io_error(parent))?;
    }
    std::fs::write(&path, bytes).map_err(workcopy::io_error(&path))
}

fn read_stashed_bytes(root: &Path, id: u64, repo_path: &str) -> Result<Vec<u8>> {
    let path = blob_path(root, id, repo_path);
    std::fs::read(&path).map_err(|source| Error::Io { path, source })
}

fn remove_entry_dir(root: &Path, id: u64) {
    let _ = std::fs::remove_dir_all(entry_dir(root, id));
}

fn parse_stash_ref(spec: Option<&str>, len: usize) -> Result<usize> {
    if len == 0 {
        return Err(Error::StashEmpty);
    }
    let raw = spec.unwrap_or("0").trim();
    let raw = raw
        .strip_prefix("stash@{")
        .and_then(|s| s.strip_suffix('}'))
        .unwrap_or(raw);
    let index: usize = raw
        .parse()
        .map_err(|_| Error::StashNotFound(raw.to_owned()))?;
    if index >= len {
        return Err(Error::StashNotFound(format!("stash@{{{index}}}")));
    }
    Ok(index)
}

fn default_message(branch: &str) -> String {
    format!("WIP on {branch}")
}

fn repo_client(root: &Path, token: Option<String>) -> Result<(workcopy::State, crate::RepoClient)> {
    let state = workcopy::load(root)?;
    let (org, repo) = state.repo.split_once('/').ok_or_else(|| Error::BadState {
        path: root.join(STATE_DIR).join("state.json"),
        message: "missing repo in state".to_owned(),
    })?;
    let client = ServerClient::new(&state.server)
        .with_token(token)
        .repo(org, repo);
    Ok((state, client))
}

fn restore_recorded_base(
    root: &Path,
    state: &workcopy::State,
    client: &crate::RepoClient,
    pending: &workcopy::PendingChanges,
) -> Result<()> {
    let mut restore_ids = Vec::new();
    let mut restore_paths: Vec<(&str, &FileState)> = Vec::new();
    for path in pending.report.modified.iter().chain(&pending.deleted) {
        if let Some(known) = state.files.get(path) {
            restore_ids.push(known.blob);
            restore_paths.push((path.as_str(), known));
        }
    }
    let blobs = clone::fetch_blobs(client, &restore_ids)?;
    for (path, known) in restore_paths {
        let bytes = blobs.get(&known.blob).ok_or_else(|| Error::Decode {
            url: "stash".to_owned(),
            message: format!("missing blob for {path}"),
        })?;
        workcopy::write_file(root, path, known.kind, bytes)?;
    }
    for path in &pending.report.added {
        workcopy::remove_file(root, path)?;
    }
    Ok(())
}

fn apply_payload(root: &Path, id: u64, payload: &StashPayload) -> Result<()> {
    for file in &payload.files {
        if file.change == ChangeKind::Deleted.as_str() {
            workcopy::remove_file(root, &file.path)?;
            continue;
        }
        let kind = file.kind.unwrap_or(EntryKind::File);
        let bytes = read_stashed_bytes(root, id, &file.path)?;
        workcopy::write_file(root, &file.path, kind, &bytes)?;
    }
    Ok(())
}

/// Saves dirty working-copy changes and restores the recorded base tree.
///
/// The stash payload is local under `.scn/stash/`. Restoring the clean tree
/// fetches recorded blobs from the server (the stash itself is not uploaded).
///
/// # Errors
///
/// Returns [`Error::NothingToStash`] when the tree is clean,
/// [`Error::NotAWorkingCopy`] / [`Error::Io`] for disk problems, and
/// [`Error::Server`] when recorded blobs cannot be fetched.
pub(crate) fn push(
    root: &Path,
    message: Option<&str>,
    token: Option<String>,
    allow_vcs: bool,
) -> Result<StashPushSummary> {
    let pending = workcopy::collect_pending(root, ScanOptions { allow_vcs })?;
    if pending.report.is_clean() {
        return Err(Error::NothingToStash);
    }
    let (state, client) = repo_client(root, token)?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let message = message
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or_else(|| default_message(&pending.report.branch), str::to_owned);

    let mut index = load_index(root)?;
    let id = index.next_id;
    index.next_id += 1;
    let mut files = Vec::new();
    for file in &pending.upserts {
        write_stashed_bytes(root, id, &file.path, &file.bytes)?;
        files.push(StashFileMeta {
            path: file.path.clone(),
            change: file.change.as_str().to_owned(),
            kind: Some(file.kind),
        });
    }
    for path in &pending.deleted {
        files.push(StashFileMeta {
            path: path.clone(),
            change: ChangeKind::Deleted.as_str().to_owned(),
            kind: None,
        });
    }
    let payload = StashPayload {
        message: message.clone(),
        created_at,
        base: state.base.to_string(),
        files,
    };
    save_payload(root, id, &payload)?;
    index.entries.push(StashMeta {
        id,
        message: message.clone(),
        created_at,
        base: state.base.to_string(),
    });
    save_index(root, &index)?;
    restore_recorded_base(root, &state, &client, &pending)?;
    Ok(StashPushSummary {
        index: 0,
        changes: pending.report.change_count(),
        message,
    })
}

/// Lists stashes, newest first (`stash@{0}` is the latest).
///
/// # Errors
///
/// Returns [`Error::NotAWorkingCopy`] or [`Error::BadState`] when the
/// working copy or stash index cannot be read.
pub(crate) fn list(root: &Path) -> Result<Vec<StashListEntry>> {
    workcopy::load(root)?;
    let index = load_index(root)?;
    Ok(index
        .entries
        .iter()
        .rev()
        .enumerate()
        .map(|(n, meta)| StashListEntry {
            index: n,
            message: meta.message.clone(),
        })
        .collect())
}

fn select_meta(root: &Path, spec: Option<&str>) -> Result<(usize, StashMeta, StashIndex)> {
    let index = load_index(root)?;
    let at = parse_stash_ref(spec, index.entries.len())?;
    let meta = index.entries[index.entries.len() - 1 - at].clone();
    Ok((at, meta, index))
}

/// Applies a stash onto the working copy. `pop` is true to then drop it.
///
/// # Errors
///
/// Returns [`Error::WouldClobberWorkingCopy`] when the tree is dirty and
/// `force` is false, [`Error::StashEmpty`] / [`Error::StashNotFound`] for a
/// missing entry, and [`Error::Io`] when files cannot be written.
pub(crate) fn apply(
    root: &Path,
    spec: Option<&str>,
    force: bool,
    pop: bool,
    allow_vcs: bool,
) -> Result<StashListEntry> {
    workcopy::load(root)?;
    if !force {
        let pending = workcopy::collect_pending(root, ScanOptions { allow_vcs })?;
        if !pending.report.is_clean() {
            return Err(Error::WouldClobberWorkingCopy);
        }
    }
    let (at, meta, mut index) = select_meta(root, spec)?;
    let payload = load_payload(root, meta.id)?;
    apply_payload(root, meta.id, &payload)?;
    if pop {
        let pos = index.entries.len() - 1 - at;
        index.entries.remove(pos);
        save_index(root, &index)?;
        remove_entry_dir(root, meta.id);
    }
    Ok(StashListEntry {
        index: at,
        message: meta.message,
    })
}

/// Drops a stash entry without applying it.
///
/// # Errors
///
/// Returns [`Error::StashEmpty`] or [`Error::StashNotFound`].
pub(crate) fn drop(root: &Path, spec: Option<&str>) -> Result<StashListEntry> {
    workcopy::load(root)?;
    let (at, meta, mut index) = select_meta(root, spec)?;
    let pos = index.entries.len() - 1 - at;
    index.entries.remove(pos);
    save_index(root, &index)?;
    remove_entry_dir(root, meta.id);
    Ok(StashListEntry {
        index: at,
        message: meta.message,
    })
}

#[cfg(test)]
mod test;
