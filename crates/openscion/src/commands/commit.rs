//! `opnscn commit`: record what changed since the base changeset.

use std::collections::HashSet;
use std::path::Path;

use openscion_core::{Change, ChangesetInfo, CreateChangeset, RepoPath, UpdateRef};

use super::upload;
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

    let mut changes = Vec::new();
    let mut blobs = Vec::new();
    let mut seen = HashSet::new();
    let mut present = HashSet::with_capacity(scanned.len());
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
        state.files.insert(file.path.clone(), fresh);
        if seen.insert(blob) {
            blobs.push((blob, bytes));
        }
    }
    let deleted: Vec<String> = state
        .files
        .keys()
        .filter(|path| !present.contains(path.as_str()))
        .cloned()
        .collect();
    for path in deleted {
        changes.push(Change::Delete {
            path: RepoPath::new(path.as_str())?,
        });
        state.files.remove(&path);
    }
    if changes.is_empty() {
        return Err(Error::NothingToCommit);
    }

    upload(&client, &blobs)?;
    let count = changes.len();
    let request = CreateChangeset::new(vec![state.base], changes, author, message);
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
    workcopy::save(root, &mut state)?;
    Ok((info, count))
}

fn ref_is_missing(error: &Error) -> bool {
    matches!(error, Error::Server { status: 404, .. })
        || matches!(error, Error::Request { message, .. } if message.contains("404"))
}

/// Points `ref_name` at the working copy's current base without creating a
/// changeset. Used by `opnscn branch push` when the tree is clean.
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
