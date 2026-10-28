//! `scn cherry-pick`: apply one commit's tree onto the current working copy.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use openscion_core::ObjectId;

use super::clone::{self, Snapshot};
use super::sync::{self, PathMerge, SyncSummary};
use crate::workcopy::{self, STATE_DIR};
use crate::{Error, Result, ServerClient};

/// Applies the tree of `spec` (a 64-hex changeset id or a named ref's tip)
/// onto the working copy using the same three-way merge as `scn merge`.
///
/// The recorded base is left unchanged so the next `scn commit` / `scn push`
/// records the cherry-pick as ordinary working-copy changes. Conflict
/// markers use `<<<<<<< local` and `>>>>>>> {spec}`.
///
/// # Errors
///
/// Returns [`Error::NotAWorkingCopy`] / [`Error::BadState`] for a missing
/// working copy, [`Error::Server`] when the commit cannot be read, and
/// [`Error::Io`] when merged files cannot be written.
pub(crate) fn cherry_pick(root: &Path, spec: &str, token: Option<String>) -> Result<SyncSummary> {
    let state = workcopy::load(root)?;
    let (org, repo) = state.repo.split_once('/').ok_or_else(|| Error::BadState {
        path: root.join(STATE_DIR).join("state.json"),
        message: "missing repo in state".to_owned(),
    })?;
    let client = ServerClient::new(&state.server)
        .with_token(token)
        .repo(org, repo);
    let picked = resolve_commit(&client, spec)?;
    let record = client.changeset(picked)?;
    let parent = record.changeset.parents.first().copied();
    let filter: Vec<&str> = state
        .sparse
        .as_deref()
        .map(|p| p.split('/').collect())
        .unwrap_or_default();
    let ancestor = if let Some(id) = parent {
        clone::fetch_snapshot(&client, id, &filter)?
    } else {
        Snapshot {
            files: BTreeMap::new(),
        }
    };
    let theirs = clone::fetch_snapshot(&client, picked, &filter)?;
    let ours = sync::local_snapshot(root)?;

    let mut updated = Vec::new();
    let mut kept = Vec::new();
    let mut conflicted = Vec::new();
    let mut merged = BTreeMap::new();
    let mut paths = HashSet::new();
    paths.extend(ancestor.files.keys().cloned());
    paths.extend(theirs.files.keys().cloned());
    paths.extend(ours.keys().cloned());
    let mut ordered: Vec<String> = paths.into_iter().collect();
    ordered.sort();

    for path in ordered {
        let base = ancestor.files.get(&path);
        let local = ours.get(&path);
        let other = theirs.files.get(&path);
        match sync::merge_path(base, local, other, spec) {
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

    sync::apply_merged(root, &state.files, &merged)?;

    Ok(SyncSummary {
        from: spec.to_owned(),
        updated,
        kept,
        conflicted,
    })
}

fn resolve_commit(client: &crate::RepoClient, spec: &str) -> Result<ObjectId> {
    if spec.len() == 64 {
        if let Ok(id) = spec.parse::<ObjectId>() {
            match client.changeset(id) {
                Ok(_) => return Ok(id),
                Err(error) => {
                    if !matches!(&error, Error::Server { status: 404, .. }) {
                        return Err(error);
                    }
                }
            }
        }
    }
    sync::resolve_ref(client, spec)
}
