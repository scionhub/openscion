//! `opnscn sync`: three-way merge of a working copy onto a target ref.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::Path;

use openscion_core::{EntryKind, ObjectId};

use super::clone::{self, SnapshotFile};
use super::diff3;
use crate::workcopy::{self, FileState};
use crate::{Error, RepoClient, Result, ServerClient};

/// Outcome of a sync, for the CLI to print.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SyncSummary {
    /// The `--from` ref.
    pub from: String,
    /// Paths taken from upstream.
    pub updated: Vec<String>,
    /// Paths whose local edits were kept.
    pub kept: Vec<String>,
    /// Paths written with conflict markers.
    pub conflicted: Vec<String>,
}

/// Brings the working copy at `root` up to date with `from` (a ref name).
///
/// Finds the common ancestor of the working copy's base changeset and `from`,
/// fetches both snapshots, and three-way-merges each path against the files
/// on disk (including uncommitted edits). The next commit uses `from` as its
/// first parent so a pull-request merge can fast-forward.
pub(crate) fn sync(root: &Path, from: &str, token: Option<String>) -> Result<SyncSummary> {
    let mut state = workcopy::load(root)?;
    let (org, repo) = state.repo.split_once('/').ok_or_else(|| Error::BadState {
        path: root.join(crate::workcopy::STATE_DIR).join("state.json"),
        message: "missing repo in state".to_owned(),
    })?;
    let client = ServerClient::new(&state.server)
        .with_token(token)
        .repo(org, repo);
    let upstream_id = resolve_ref(&client, from)?;
    let local_id = state.base;
    if upstream_id == local_id {
        return Ok(SyncSummary {
            from: from.to_owned(),
            ..SyncSummary::default()
        });
    }
    let ancestor = common_ancestor(&client, local_id, upstream_id)?;
    let filter: Vec<&str> = state
        .sparse
        .as_deref()
        .map(|p| p.split('/').collect())
        .unwrap_or_default();
    let ancestor_snap = if let Some(id) = ancestor {
        clone::fetch_snapshot(&client, id, &filter)?
    } else {
        clone::Snapshot {
            files: BTreeMap::new(),
        }
    };
    let upstream_snap = clone::fetch_snapshot(&client, upstream_id, &filter)?;
    let local_files = local_snapshot(root)?;

    let mut updated = Vec::new();
    let mut kept = Vec::new();
    let mut conflicted = Vec::new();
    let mut merged: BTreeMap<String, (EntryKind, Vec<u8>)> = BTreeMap::new();

    let mut paths = HashSet::new();
    paths.extend(ancestor_snap.files.keys().cloned());
    paths.extend(upstream_snap.files.keys().cloned());
    paths.extend(local_files.keys().cloned());

    for path in ordered(paths) {
        let base = ancestor_snap.files.get(&path);
        let ours = local_files.get(&path);
        let theirs = upstream_snap.files.get(&path);
        match merge_path(base, ours, theirs, from) {
            PathMerge::TakeUpstream(kind, bytes) => {
                updated.push(path.clone());
                merged.insert(path, (kind, bytes));
            }
            PathMerge::KeepLocal(kind, bytes) => {
                kept.push(path.clone());
                merged.insert(path, (kind, bytes));
            }
            PathMerge::Unchanged(kind, bytes) => {
                merged.insert(path, (kind, bytes));
            }
            PathMerge::Conflict(kind, bytes) => {
                conflicted.push(path.clone());
                merged.insert(path, (kind, bytes));
            }
            PathMerge::Deleted => {}
        }
    }

    apply_merged(root, &state.files, &merged)?;

    let mut files = BTreeMap::new();
    for (path, file) in &upstream_snap.files {
        let (size, mtime) = if merged
            .get(path)
            .is_some_and(|(k, b)| *k == file.kind && b == &file.bytes)
        {
            workcopy::stat(root, path).unwrap_or((file.bytes.len() as u64, 0))
        } else {
            (0, 0)
        };
        files.insert(
            path.clone(),
            FileState {
                kind: file.kind,
                blob: file.blob,
                size,
                mtime,
            },
        );
    }
    state.files = files;
    // Next commit's first parent is the upstream tip so `pr merge` can
    // fast-forward: it requires head's first parent == current base.
    state.sync_onto = Some(upstream_id);
    workcopy::save(root, &mut state)?;

    Ok(SyncSummary {
        from: from.to_owned(),
        updated,
        kept,
        conflicted,
    })
}

enum PathMerge {
    TakeUpstream(EntryKind, Vec<u8>),
    KeepLocal(EntryKind, Vec<u8>),
    Unchanged(EntryKind, Vec<u8>),
    Conflict(EntryKind, Vec<u8>),
    Deleted,
}

fn blob(file: &SnapshotFile) -> &[u8] {
    &file.bytes
}

fn merge_path(
    base: Option<&SnapshotFile>,
    ours: Option<&SnapshotFile>,
    theirs: Option<&SnapshotFile>,
    from: &str,
) -> PathMerge {
    match (base, ours, theirs) {
        (None, Some(o), None) => PathMerge::KeepLocal(o.kind, o.bytes.clone()),
        (None, None, Some(t)) => PathMerge::TakeUpstream(t.kind, t.bytes.clone()),
        (None, Some(o), Some(t)) if o.bytes == t.bytes && o.kind == t.kind => {
            PathMerge::Unchanged(o.kind, o.bytes.clone())
        }
        (None, Some(o), Some(t)) => {
            let merged = diff3::merge3(&[], blob(o), blob(t), from);
            PathMerge::Conflict(o.kind, merged.bytes)
        }
        (None | Some(_), None, None) => PathMerge::Deleted,
        (Some(b), Some(o), None) if blob(o) == blob(b) && o.kind == b.kind => PathMerge::Deleted,
        (Some(b), Some(o), None) => {
            let merged = diff3::merge3(blob(b), blob(o), &[], from);
            PathMerge::Conflict(o.kind, merged.bytes)
        }
        (Some(b), None, Some(t)) if blob(t) == blob(b) && t.kind == b.kind => PathMerge::Deleted,
        (Some(b), None, Some(t)) => {
            let merged = diff3::merge3(blob(b), &[], blob(t), from);
            PathMerge::Conflict(t.kind, merged.bytes)
        }
        (Some(b), Some(o), Some(t)) => {
            if blob(o) == blob(t) && o.kind == t.kind {
                if blob(o) == blob(b) {
                    PathMerge::Unchanged(o.kind, o.bytes.clone())
                } else {
                    PathMerge::KeepLocal(o.kind, o.bytes.clone())
                }
            } else if blob(o) == blob(b) && o.kind == b.kind {
                PathMerge::TakeUpstream(t.kind, t.bytes.clone())
            } else if blob(t) == blob(b) && t.kind == b.kind {
                PathMerge::KeepLocal(o.kind, o.bytes.clone())
            } else {
                let merged = diff3::merge3(blob(b), blob(o), blob(t), from);
                if merged.conflict {
                    PathMerge::Conflict(o.kind, merged.bytes)
                } else if merged.bytes == t.bytes {
                    PathMerge::TakeUpstream(t.kind, merged.bytes)
                } else if merged.bytes == o.bytes {
                    PathMerge::KeepLocal(o.kind, merged.bytes)
                } else {
                    PathMerge::Unchanged(o.kind, merged.bytes)
                }
            }
        }
    }
}

fn apply_merged(
    root: &Path,
    previous: &BTreeMap<String, FileState>,
    merged: &BTreeMap<String, (EntryKind, Vec<u8>)>,
) -> Result<()> {
    for path in previous.keys() {
        if !merged.contains_key(path) {
            workcopy::remove_file(root, path)?;
        }
    }
    for (path, (kind, bytes)) in merged {
        workcopy::write_file(root, path, *kind, bytes)?;
    }
    Ok(())
}

fn local_snapshot(root: &Path) -> Result<BTreeMap<String, SnapshotFile>> {
    let mut files = BTreeMap::new();
    for file in workcopy::scan(root)? {
        let bytes = workcopy::read_content(root, &file)?;
        let blob = workcopy::blob_id(&bytes);
        files.insert(
            file.path,
            SnapshotFile {
                kind: file.kind,
                blob,
                bytes,
            },
        );
    }
    Ok(files)
}

fn ordered(paths: HashSet<String>) -> Vec<String> {
    let mut v: Vec<String> = paths.into_iter().collect();
    v.sort();
    v
}

fn resolve_ref(client: &RepoClient, name: &str) -> Result<ObjectId> {
    match client.get_ref(name) {
        Ok(value) => Ok(value.target),
        Err(error) if ref_missing(&error) && !name.starts_with("refs/") => {
            match client.get_ref(&format!("refs/heads/{name}")) {
                Ok(value) => Ok(value.target),
                Err(_) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

fn ref_missing(error: &Error) -> bool {
    matches!(error, Error::Server { status: 404, .. })
        || matches!(error, Error::Request { message, .. } if message.contains("404"))
}

/// Walks both parent chains until they meet. `None` means unrelated histories
/// (empty ancestor tree).
fn common_ancestor(client: &RepoClient, a: ObjectId, b: ObjectId) -> Result<Option<ObjectId>> {
    if a == b {
        return Ok(Some(a));
    }
    let mut seen_a = HashSet::from([a]);
    let mut seen_b = HashSet::from([b]);
    let mut qa = VecDeque::from([a]);
    let mut qb = VecDeque::from([b]);
    while !qa.is_empty() || !qb.is_empty() {
        if let Some(id) = qa.pop_front() {
            for parent in client.changeset(id)?.changeset.parents {
                if seen_b.contains(&parent) {
                    return Ok(Some(parent));
                }
                if seen_a.insert(parent) {
                    qa.push_back(parent);
                }
            }
        }
        if let Some(id) = qb.pop_front() {
            for parent in client.changeset(id)?.changeset.parents {
                if seen_a.contains(&parent) {
                    return Ok(Some(parent));
                }
                if seen_b.insert(parent) {
                    qb.push_back(parent);
                }
            }
        }
    }
    Ok(None)
}

/// Paths in a working copy whose contents still contain conflict markers.
pub(crate) fn conflicted_paths(root: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for file in workcopy::scan(root)? {
        let bytes = workcopy::read_content(root, &file)?;
        if diff3::contains_conflict_markers(&bytes) {
            out.push(file.path);
        }
    }
    Ok(out)
}
