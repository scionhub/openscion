//! Fetch, pull, and cross-server push.
//!
//! File bytes are COMMP `PieceCIDs`. A push to another server uploads a blob
//! only when that server reports the `PieceCID` missing, then replays the
//! changeset (with its original `created_at`, so the id matches) and moves
//! the ref.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use openscion_core::{Change, Changeset, ObjectId, ObjectKind, UpdateRef};

use super::clone::verified;
use super::sync::{self, SyncSummary};
use super::{commit_ref, publish_ref, upload};
use crate::workcopy::{self, State};
use crate::{Error, RepoClient, Result, ServerClient};

/// What `scn fetch` learned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FetchSummary {
    /// Remote name.
    pub remote: String,
    /// Ref that was read.
    pub from: String,
    /// Tip changeset.
    pub tip: ObjectId,
}

/// Reads a remote ref and records its tip. Does not change files.
///
/// # Errors
///
/// Returns [`Error::UnknownRemote`] when the name is not configured,
/// [`Error::NotAWorkingCopy`] when `root` is not a working copy, and
/// [`Error::Server`] when the ref cannot be read.
pub(crate) fn fetch(
    root: &Path,
    remote_name: Option<&str>,
    branch: Option<&str>,
    token_for: &dyn Fn(&str) -> Option<String>,
) -> Result<FetchSummary> {
    let mut state = workcopy::load(root)?;
    let remote_name =
        remote_name.map_or_else(|| state.tracking_remote_name().to_owned(), str::to_owned);
    let remote = state
        .remote(&remote_name)
        .cloned()
        .ok_or(Error::UnknownRemote(remote_name))?;
    let from = branch.map_or_else(|| state.upstream_ref(), str::to_owned);
    let client = remote_client(&remote, token_for)?;
    let tip = sync::resolve_ref(&client, &from)?;
    state.note_tip(&remote.name, &openscion_core::short_ref(&from), tip);
    workcopy::save(root, &mut state)?;
    super::tag::sync_down(root, &client)?;
    Ok(FetchSummary {
        remote: remote.name,
        from,
        tip,
    })
}

/// Fetches a remote ref and three-way-merges it into the working copy.
///
/// # Errors
///
/// As for [`fetch`] and [`sync::sync`].
pub(crate) fn pull(
    root: &Path,
    remote_name: Option<&str>,
    branch: Option<&str>,
    token_for: &dyn Fn(&str) -> Option<String>,
) -> Result<SyncSummary> {
    let fetched = fetch(root, remote_name, branch, token_for)?;
    let state = workcopy::load(root)?;
    let remote = state
        .remote(&fetched.remote)
        .cloned()
        .ok_or_else(|| Error::UnknownRemote(fetched.remote.clone()))?;
    let client = remote_client(&remote, token_for)?;
    sync::sync_with(root, &client, &fetched.from)
}

/// Copies `tip` from `source` onto `dest`, uploading only missing pieces,
/// and points `ref_name` at it.
///
/// # Errors
///
/// Returns [`Error::RemoteRepoMissing`] when the destination repository does
/// not exist and `create` is false, and [`Error::Server`] when a transfer
/// call fails.
pub(crate) fn replicate(
    source: &RepoClient,
    dest: &RepoClient,
    tip: ObjectId,
    ref_name: &str,
    create: bool,
) -> Result<usize> {
    if !dest.repo_exists()? {
        if !create {
            return Err(Error::RemoteRepoMissing {
                server: dest.base().to_owned(),
                repo: format!("{}/{}", dest.org(), dest.repo()),
            });
        }
        dest.create_this_repo()?;
    }
    let uploads = transfer_changesets(source, dest, tip)?;
    if let Ok(map) = source.file_map()
        && !map.is_empty()
    {
        let _ = dest.update_file_map(&map, &[]);
    }
    match dest.get_ref(ref_name) {
        Ok(value) if value.target == tip => {}
        Ok(value) => {
            dest.update_ref(ref_name, UpdateRef::new(Some(value.target), tip))?;
        }
        Err(error) if is_missing(&error) => {
            dest.update_ref(ref_name, UpdateRef::new(None, tip))?;
        }
        Err(error) => return Err(error),
    }
    Ok(uploads)
}

const ANCESTOR_PAGE: u32 = 2_000;
const TRANSFER_CHUNK: usize = 200;

/// Copies `tip` and its ancestors onto `dest` without recursing per parent.
///
/// One `have` request names every id. Missing changesets are exported and
/// imported in parent-before-child chunks. A server without those routes
/// falls back to one request per commit, still with an explicit stack.
///
/// # Errors
///
/// Returns [`Error::Server`] when a transfer call fails.
pub(crate) fn transfer_changesets(
    source: &RepoClient,
    dest: &RepoClient,
    tip: ObjectId,
) -> Result<usize> {
    let ids = collect_ancestor_ids(source, tip)?;
    let present = match dest.have_changesets(&ids) {
        Ok(present) => present.into_iter().collect::<HashSet<_>>(),
        Err(error) if is_missing(&error) => present_by_lookup(dest, &ids)?,
        Err(error) => return Err(error),
    };
    let missing: Vec<ObjectId> = ids.into_iter().filter(|id| !present.contains(id)).collect();
    let mut uploads = 0;
    for chunk in missing.chunks(TRANSFER_CHUNK) {
        uploads += send_chunk(source, dest, chunk)?;
    }
    Ok(uploads)
}

fn collect_ancestor_ids(source: &RepoClient, tip: ObjectId) -> Result<Vec<ObjectId>> {
    match source.ancestor_page(tip, ANCESTOR_PAGE, 0) {
        Ok((mut ids, mut cursor)) => {
            while let Some(next) = cursor {
                let (page, more) = source.ancestor_page(tip, ANCESTOR_PAGE, next)?;
                if page.is_empty() {
                    break;
                }
                ids.extend(page);
                cursor = more;
            }
            Ok(ids)
        }
        Err(error) if is_missing(&error) => iterative_ancestors(source, tip),
        Err(error) => Err(error),
    }
}

fn iterative_ancestors(source: &RepoClient, tip: ObjectId) -> Result<Vec<ObjectId>> {
    let mut failure = None;
    let ordered = postorder_ids(&tip.to_string(), |id| {
        if failure.is_some() {
            return Vec::new();
        }
        let Ok(parsed) = id.parse::<ObjectId>() else {
            failure = Some(Error::Decode {
                url: id.to_owned(),
                message: "ancestor id is not an object id".to_owned(),
            });
            return Vec::new();
        };
        match source.changeset(parsed) {
            Ok(record) => record
                .changeset
                .parents
                .iter()
                .map(ToString::to_string)
                .collect(),
            Err(error) => {
                failure = Some(error);
                Vec::new()
            }
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }
    ordered
        .into_iter()
        .map(|text| {
            text.parse()
                .map_err(|error: openscion_core::ParseIdError| Error::Decode {
                    url: text,
                    message: error.to_string(),
                })
        })
        .collect()
}

fn present_by_lookup(dest: &RepoClient, ids: &[ObjectId]) -> Result<HashSet<ObjectId>> {
    let mut present = HashSet::new();
    for id in ids {
        match dest.changeset(*id) {
            Ok(_) => {
                present.insert(*id);
            }
            Err(error) if is_missing(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(present)
}

fn send_chunk(source: &RepoClient, dest: &RepoClient, chunk: &[ObjectId]) -> Result<usize> {
    if chunk.is_empty() {
        return Ok(0);
    }
    let records = match source.export_changesets(chunk) {
        Ok(records) => records,
        Err(error) if is_missing(&error) => {
            let mut records = Vec::with_capacity(chunk.len());
            for id in chunk {
                records.push(source.changeset(*id)?);
            }
            records
        }
        Err(error) => return Err(error),
    };
    let mut by_id = HashMap::new();
    for record in records {
        by_id.insert(record.info.id, record);
    }
    let mut changesets = Vec::with_capacity(chunk.len());
    let mut blobs = Vec::new();
    for id in chunk {
        let record = by_id
            .remove(id)
            .ok_or(Error::Engine(openscion_core::Error::NotFound(*id)))?;
        blobs.extend(blob_ids(&record.changeset));
        changesets.push(record.changeset);
    }
    let mut uploads = 0;
    if !blobs.is_empty() {
        let bytes = source.fetch_objects(blobs.clone())?;
        let decoded = verified(&bytes, ObjectKind::Blob, &blobs)?;
        let owned: Vec<(ObjectId, Vec<u8>)> = decoded
            .iter()
            .map(|(id, body)| (*id, body.to_vec()))
            .collect();
        uploads += upload(dest, &owned)?;
    }
    dest.import_changesets(&changesets)?;
    Ok(uploads)
}

/// Parent-before-child order. The walk is a stack, so a long chain does not
/// grow the process stack with the history.
pub(crate) fn postorder_ids(
    tip: &str,
    mut parents_of: impl FnMut(&str) -> Vec<String>,
) -> Vec<String> {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![(tip.to_owned(), false)];
    while let Some((id, expanded)) = stack.pop() {
        if expanded {
            if seen.insert(id.clone()) {
                ordered.push(id);
            }
            continue;
        }
        if seen.contains(&id) {
            continue;
        }
        let parents = parents_of(&id);
        stack.push((id, true));
        for parent in parents.into_iter().rev() {
            stack.push((parent, false));
        }
    }
    ordered
}

fn blob_ids(changeset: &Changeset) -> Vec<ObjectId> {
    changeset
        .changes
        .iter()
        .filter_map(|change| match change {
            Change::Upsert { blob, .. } => Some(*blob),
            Change::Delete { .. } => None,
        })
        .collect()
}

pub(super) fn remote_client(
    remote: &crate::workcopy::Remote,
    token_for: &dyn Fn(&str) -> Option<String>,
) -> Result<RepoClient> {
    let (org, repo) = remote.repo.split_once('/').ok_or_else(|| {
        Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "remote repo must be <org>/<repo>",
        })
    })?;
    Ok(ServerClient::new(&remote.server)
        .with_token(token_for(&remote.server))
        .repo(org, repo))
}

pub(super) fn home_remote(state: &State) -> crate::workcopy::Remote {
    state
        .remote("origin")
        .cloned()
        .unwrap_or_else(|| crate::workcopy::Remote::new("origin", &state.server, &state.repo))
}

fn is_missing(error: &Error) -> bool {
    matches!(error, Error::Server { status: 404, .. })
        || matches!(error, Error::Request { message, .. } if message.contains("404"))
}

/// Arguments for [`push_to`].
pub(crate) struct CrossPush<'a> {
    /// Author recorded when a local commit is required.
    pub author: &'a str,
    /// Commit message, required when the working copy is dirty.
    pub message: Option<&'a str>,
    /// Remote name. Defaults to the branch upstream.
    pub remote: Option<&'a str>,
    /// Ref to publish. Defaults to the current upstream.
    pub branch: Option<&'a str>,
    /// Create the repository on the remote when it is missing.
    pub create: bool,
    /// Include VCS metadata and nested checkouts in the scan.
    pub allow_vcs: bool,
}

/// Publishes the working copy to `remote` (default: the branch upstream).
///
/// A different server receives only pieces it does not already store.
pub(crate) fn push_to(
    root: &Path,
    push: &CrossPush<'_>,
    token_for: &dyn Fn(&str) -> Option<String>,
) -> Result<(super::PushOutcome, usize)> {
    let state = workcopy::load(root)?;
    let remote_name = push
        .remote
        .map_or_else(|| state.tracking_remote_name().to_owned(), str::to_owned);
    let remote = state
        .remote(&remote_name)
        .cloned()
        .ok_or(Error::UnknownRemote(remote_name))?;
    let ref_name = push
        .branch
        .map_or_else(|| state.upstream_ref(), str::to_owned);
    let home = home_remote(&state);
    let same = remote.server == home.server && remote.repo == home.repo;
    if same {
        let token = token_for(&home.server);
        let outcome = super::push(root, push.author, push.message, token, push.allow_vcs)?;
        let mut state = workcopy::load(root)?;
        let tip = state.base;
        state.note_tip(&remote.name, &openscion_core::short_ref(&ref_name), tip);
        workcopy::save(root, &mut state)?;
        if openscion_core::short_ref(&ref_name) != openscion_core::short_ref(&state.upstream_ref())
        {
            publish_named(root, &ref_name, token_for(&remote.server))?;
        }
        let client = remote_client(&remote, token_for)?;
        super::tag::sync_up(root, &client)?;
        return Ok((outcome, 0));
    }
    let dest = remote_client(&remote, token_for)?;
    if !dest.repo_exists()? {
        if !push.create {
            return Err(Error::RemoteRepoMissing {
                server: dest.base().to_owned(),
                repo: format!("{}/{}", dest.org(), dest.repo()),
            });
        }
        dest.create_this_repo()?;
    }
    let token = token_for(&home.server);
    let outcome = if workcopy::is_dirty_with(
        root,
        crate::workcopy::ScanOptions {
            allow_vcs: push.allow_vcs,
        },
    )? || workcopy::load(root)?.sync_onto.is_some()
    {
        let message = push.message.ok_or(Error::CommitMessageRequired)?;
        let upstream = workcopy::load(root)?.upstream_ref();
        let (info, changes) = commit_ref(
            root,
            push.author,
            message,
            Some(&upstream),
            token,
            push.allow_vcs,
        )?;
        super::PushOutcome::Committed {
            id: info.id.to_string(),
            changes,
            upstream: ref_name.clone(),
        }
    } else {
        let state = workcopy::load(root)?;
        super::PushOutcome::Published {
            id: state.base.to_string(),
            upstream: ref_name.clone(),
        }
    };
    let state = workcopy::load(root)?;
    let source = remote_client(&home, token_for)?;
    let uploads = replicate(&source, &dest, state.base, &ref_name, true)?;
    let mut state = state;
    state.note_tip(
        &remote.name,
        &openscion_core::short_ref(&ref_name),
        state.base,
    );
    workcopy::save(root, &mut state)?;
    super::tag::sync_up(root, &dest)?;
    Ok((outcome, uploads))
}

fn publish_named(root: &Path, ref_name: &str, token: Option<String>) -> Result<()> {
    let _ = publish_ref(root, ref_name, token)?;
    Ok(())
}
