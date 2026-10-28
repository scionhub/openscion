//! `scn import`: record a directory as the first changeset.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use openscion_core::{Change, ChangesetInfo, CreateChangeset, RepoPath, UpdateRef};

use super::{piece_cid_of, upload};
use crate::workcopy::{self, FileState, ScanOptions, State};
use crate::{Error, RepoClient, Result};

/// Imports every file under `root` as a parentless changeset, points
/// `ref_name` at it, and makes `root` a working copy. Paths matching
/// `.gitignore` are omitted. VCS metadata and nested git checkouts are
/// skipped unless `allow_vcs` is set.
pub(crate) fn import(
    client: &RepoClient,
    root: &Path,
    ref_name: &str,
    author: &str,
    message: &str,
    allow_vcs: bool,
) -> Result<(ChangesetInfo, usize)> {
    if workcopy::is_working_copy(root) {
        return Err(Error::AlreadyExists(root.to_path_buf()));
    }
    let scanned = workcopy::scan_with(root, ScanOptions { allow_vcs })?;
    let mut blobs = Vec::new();
    let mut seen = HashSet::new();
    let mut changes = Vec::with_capacity(scanned.len());
    let mut files = BTreeMap::new();
    let mut file_map = BTreeMap::<String, String>::new();
    for file in &scanned {
        let bytes = workcopy::read_content(root, file)?;
        let blob = workcopy::blob_id(&bytes);
        changes.push(Change::Upsert {
            path: RepoPath::new(file.path.as_str())?,
            kind: file.kind,
            blob,
        });
        file_map.insert(file.path.clone(), piece_cid_of(&bytes)?);
        files.insert(
            file.path.clone(),
            FileState {
                kind: file.kind,
                blob,
                size: file.size,
                mtime: file.mtime,
            },
        );
        if seen.insert(blob) {
            blobs.push((blob, bytes));
        }
    }
    upload(client, &blobs)?;
    client.update_file_map(&file_map, &[])?;
    let req = CreateChangeset::new(vec![], changes, author, message);
    let info = client.create_changeset(&req)?;
    client.update_ref(ref_name, UpdateRef::new(None, info.id))?;
    let mut state = State {
        server: client.base().to_owned(),
        repo: format!("{}/{}", client.org(), client.repo()),
        ref_name: ref_name.to_owned(),
        branch: Some(openscion_core::short_ref(ref_name)),
        upstream: Some(ref_name.to_owned()),
        base: info.id,
        sync_onto: None,
        sparse: None,
        written_at: 0,
        files,
    };
    workcopy::save(root, &mut state)?;
    Ok((info, scanned.len()))
}
