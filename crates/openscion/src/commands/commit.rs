//! `opnscn commit`: record what changed since the base changeset.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use openscion_core::{Change, ChangesetInfo, CreateChangeset, RepoPath, UpdateRef};

use super::{merge_pcid_metadata, piece_cid_of, upload};
use crate::workcopy::{self, FileState};
use crate::{Error, Result, ServerClient};

/// Commits every change in the working copy at `root` and moves its ref.
/// Returns the new changeset and the number of changes. `ref_override`, when
/// `Some`, is CAS-moved instead of the working copy's current ref; a missing
/// ref is created (`expected = None`).
pub(crate) fn commit_ref(
    root: &Path,
    author: &str,
    message: &str,
    ref_override: Option<&str>,
    token: Option<String>,
) -> Result<(ChangesetInfo, usize)> {
    let mut state = workcopy::load(root)?;
    let (org, repo) = state.repo.split_once('/').ok_or_else(|| Error::BadState {
        path: root.join(crate::workcopy::STATE_DIR).join("state.json"),
        message: "missing repo in state".to_owned(),
    })?;
    let client = ServerClient::new(&state.server)
        .with_token(token)
        .repo(org, repo);
    let scanned = workcopy::scan(root)?;
    let conflicted = super::sync::conflicted_paths(root)?;
    if !conflicted.is_empty() {
        return Err(Error::UnresolvedConflicts {
            count: conflicted.len(),
        });
    }

    let mut changes = Vec::new();
    let mut blobs = Vec::new();
    let mut seen = HashSet::new();
    let mut present = HashSet::with_capacity(scanned.len());
    let mut upsert_pcids = BTreeMap::new();
    for file in &scanned {
        present.insert(file.path.as_str());
        let known = state.files.get(&file.path);
        if known.is_some_and(|known| workcopy::unchanged(file, known, state.written_at)) {
            continue;
        }
        let bytes = workcopy::read_content(root, file)?;
        let blob = workcopy::blob_id(&bytes);
        let fresh = FileState {
            kind: file.kind,
            blob,
            size: file.size,
            mtime: file.mtime,
        };
        // Touched but identical: refresh the stat data, record no change.
        if known.is_some_and(|known| known.kind == file.kind && known.blob == blob) {
            state.files.insert(file.path.clone(), fresh);
            continue;
        }
        changes.push(Change::Upsert {
            path: RepoPath::new(file.path.as_str())?,
            kind: file.kind,
            blob,
        });
        upsert_pcids.insert(file.path.clone(), piece_cid_of(&bytes)?);
        state.files.insert(file.path.clone(), fresh);
        if seen.insert(blob) {
            blobs.push((blob, bytes));
        }
    }
    let deleted: HashSet<String> = state
        .files
        .keys()
        .filter(|path| !present.contains(path.as_str()))
        .cloned()
        .collect();
    for path in &deleted {
        changes.push(Change::Delete {
            path: RepoPath::new(path.as_str())?,
        });
        state.files.remove(path);
    }
    let onto = state.sync_onto.filter(|id| *id != state.base);
    if changes.is_empty() && onto.is_none() {
        return Err(Error::NothingToCommit);
    }

    let first_parent = onto.unwrap_or(state.base);
    let parent_meta = client.changeset(first_parent)?.changeset.metadata;
    let metadata = merge_pcid_metadata(&parent_meta, &upsert_pcids, &deleted);
    // Same bundle/upload path as import: durable SP push, bundle-map
    // registration, and pending_adds for the org dataset.
    upload(&client, &blobs)?;
    let count = changes.len();
    let parents = match onto {
        Some(id) => vec![id, state.base],
        None => vec![state.base],
    };
    let mut request = CreateChangeset::new(parents, changes, author, message);
    request.metadata = metadata;
    let info = client.create_changeset(&request)?;
    let ref_name = ref_override.unwrap_or(&state.ref_name).to_owned();
    let expected = match client.get_ref(&ref_name) {
        Ok(_) => Some(state.base),
        Err(error) if ref_is_missing(&error) => None,
        Err(error) => return Err(error),
    };
    client.update_ref(&ref_name, UpdateRef::new(expected, info.id))?;
    state.base = info.id;
    state.ref_name = ref_name;
    state.sync_onto = None;
    workcopy::save(root, &mut state)?;
    Ok((info, count))
}

fn ref_is_missing(error: &Error) -> bool {
    matches!(error, Error::Server { status: 404, .. })
        || matches!(error, Error::Request { message, .. } if message.contains("404"))
}

/// Outcome of [`push`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PushOutcome {
    /// A new changeset was recorded and the upstream ref moved.
    Committed {
        /// New changeset id, as hex.
        id: String,
        /// How many path changes were recorded.
        changes: usize,
        /// Upstream ref that was moved.
        upstream: String,
    },
    /// The tree was clean; the upstream ref was created or already matched.
    Published {
        /// Changeset the ref points at, as hex.
        id: String,
        /// Upstream ref that was published.
        upstream: String,
    },
}

/// Commits local changes if any, then publishes the current branch to its
/// upstream ref. `message` is required when there are local changes.
pub(crate) fn push(
    root: &Path,
    author: &str,
    message: Option<&str>,
    token: Option<String>,
) -> Result<PushOutcome> {
    let state = workcopy::load(root)?;
    let upstream = state.upstream_ref();
    let conflicted = super::sync::conflicted_paths(root)?;
    if !conflicted.is_empty() {
        return Err(Error::UnresolvedConflicts {
            count: conflicted.len(),
        });
    }
    let dirty = workcopy::is_dirty(root)?;
    let needs_commit = dirty || state.sync_onto.is_some_and(|id| id != state.base);
    if needs_commit {
        let message = message.ok_or(Error::CommitMessageRequired)?;
        let (info, changes) = commit_ref(root, author, message, Some(&upstream), token)?;
        return Ok(PushOutcome::Committed {
            id: info.id.to_string(),
            changes,
            upstream,
        });
    }
    let id = publish_ref(root, &upstream, token)?;
    Ok(PushOutcome::Published {
        id: id.to_string(),
        upstream,
    })
}

/// Points `ref_name` at the working copy's current base without creating a
/// changeset. Used by `opnscn push` when the tree is clean.
pub(crate) fn publish_ref(
    root: &Path,
    ref_name: &str,
    token: Option<String>,
) -> Result<openscion_core::ObjectId> {
    let mut state = workcopy::load(root)?;
    let (org, repo) = state.repo.split_once('/').ok_or_else(|| Error::BadState {
        path: root.join(crate::workcopy::STATE_DIR).join("state.json"),
        message: "missing repo in state".to_owned(),
    })?;
    let client = ServerClient::new(&state.server)
        .with_token(token)
        .repo(org, repo);
    match client.get_ref(ref_name) {
        Ok(value) if value.target == state.base => {}
        Ok(_) => {
            return Err(Error::Engine(openscion_core::Error::InvalidChange {
                path: "cli".to_owned(),
                rule: "branch exists at a different changeset",
            }));
        }
        Err(error) if ref_is_missing(&error) => {
            client.update_ref(ref_name, UpdateRef::new(None, state.base))?;
        }
        Err(error) => return Err(error),
    }
    ref_name.clone_into(&mut state.ref_name);
    workcopy::save(root, &mut state)?;
    Ok(state.base)
}
