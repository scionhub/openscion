//! `opnscn clone`: materialize a snapshot, or one directory of it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use openscion_core::{
    EntryKind, ObjectId, ObjectKind, RepoPath, decode_frames, decode_tree, object_id,
};

use super::FETCH_BATCH;
use crate::workcopy::{self, FileState, State};
use crate::{Error, RepoClient, Result};

/// A file to fetch: its path, kind, and blob.
type Wanted = (String, EntryKind, ObjectId);

/// Clones `ref_name` into `dest`, limited to the directory or file `sparse`
/// when given. Returns the changeset cloned and the number of files written.
#[allow(clippy::too_many_lines)] // CLI convenience: keep flow in one place for readability
pub(crate) fn clone(
    client: &RepoClient,
    ref_name: &str,
    dest: &Path,
    sparse: Option<&RepoPath>,
) -> Result<(ObjectId, usize)> {
    if dest.exists() && !is_empty_dir(dest)? {
        return Err(Error::AlreadyExists(dest.to_path_buf()));
    }
    let target = client.get_ref(ref_name)?.target;
    let record = client.changeset(target)?;
    let root_tree = record.info.root_tree;
    // Build pieceCID mapping from changeset metadata (pcid:<path> = PieceCID)
    let mut path_to_piece: HashMap<String, String> = HashMap::new();
    for (k, v) in &record.changeset.metadata {
        if let Some(path) = k.strip_prefix("pcid:") {
            path_to_piece.insert(path.to_owned(), v.to_owned());
        }
    }
    let filter: Vec<&str> = sparse.map_or_else(Vec::new, |path| path.components().collect());
    let wanted = walk_trees(client, root_tree, &filter)?;

    std::fs::create_dir_all(dest).map_err(workcopy::io_error(dest))?;
    let mut files = BTreeMap::new();
    for batch in wanted.chunks(FETCH_BATCH) {
        let ids = unique(batch.iter().map(|(_, _, blob)| *blob));
        let mut blob_bytes: BTreeMap<ObjectId, Vec<u8>> = BTreeMap::new();
        // Fetch by PieceCID when available
        for (path, kind, blob) in batch {
            if *kind == EntryKind::Tree {
                continue;
            }
            if let Some(pcid) = path_to_piece.get(path) {
                if let Ok(data) = client.fetch_by_piece_cid(pcid, None) {
                    // Verify bytes by BLAKE3 id
                    let actual = object_id(ObjectKind::Blob, &data);
                    if actual == *blob {
                        blob_bytes.insert(*blob, data);
                    }
                }
            }
        }
        // Fallback for anything missing: use server /v1/repos/{org}/{repo}/objects
        let missing: Vec<ObjectId> = ids
            .iter()
            .copied()
            .filter(|id| !blob_bytes.contains_key(id))
            .collect();
        if !missing.is_empty() {
            let bytes = client.fetch_objects(missing.clone())?;
            let blobs: BTreeMap<ObjectId, &[u8]> = verified(&bytes, ObjectKind::Blob, &missing)?;
            for (id, body) in blobs {
                blob_bytes.insert(id, body.to_vec());
            }
        }
        // Write files
        for (path, kind, blob) in batch {
            let content = blob_bytes.get(blob).map(Vec::as_slice).unwrap_or_default();
            workcopy::write_file(dest, path, *kind, content)?;
            let (size, mtime) = workcopy::stat(dest, path)?;
            files.insert(
                path.clone(),
                FileState {
                    kind: *kind,
                    blob: *blob,
                    size,
                    mtime,
                },
            );
        }
    }
    let count = files.len();
    let mut state = State {
        server: client.base().to_owned(),
        repo: format!("{}/{}", client.org(), client.repo()),
        ref_name: ref_name.to_owned(),
        base: target,
        sparse: sparse.map(|path| path.as_str().to_owned()),
        written_at: 0,
        files,
    };
    workcopy::save(dest, &mut state)?;
    Ok((target, count))
}

fn is_empty_dir(path: &Path) -> Result<bool> {
    let mut entries = std::fs::read_dir(path).map_err(workcopy::io_error(path))?;
    Ok(entries.next().is_none())
}

/// Walks the snapshot breadth first, one fetch per level, and returns every
/// file under `filter` (everything when it is empty).
fn walk_trees(client: &RepoClient, root: ObjectId, filter: &[&str]) -> Result<Vec<Wanted>> {
    let mut wanted = Vec::new();
    let mut level: Vec<(String, ObjectId)> = vec![(String::new(), root)];
    let mut depth = 0;
    while !level.is_empty() {
        let mut next = Vec::new();
        for batch in level.chunks(FETCH_BATCH) {
            let ids = unique(batch.iter().map(|(_, id)| *id));
            let bytes = client.fetch_objects(ids.clone())?;
            let trees = verified(&bytes, ObjectKind::Tree, &ids)?;
            for (prefix, id) in batch {
                let entries = decode_tree(trees.get(id).copied().unwrap_or_default())?;
                for entry in entries {
                    // Inside the filter everything is wanted; above it, only
                    // the entry on the way down.
                    if depth < filter.len() && entry.name != filter[depth] {
                        continue;
                    }
                    let path = format!("{prefix}{}", entry.name);
                    if entry.kind == EntryKind::Tree {
                        next.push((format!("{path}/"), entry.id));
                    } else if depth + 1 >= filter.len() {
                        wanted.push((path, entry.kind, entry.id));
                    }
                }
            }
        }
        level = next;
        depth += 1;
    }
    Ok(wanted)
}

fn unique(ids: impl Iterator<Item = ObjectId>) -> Vec<ObjectId> {
    let mut seen = HashSet::new();
    ids.filter(|id| seen.insert(*id)).collect()
}

/// Decodes a fetched frame stream, checking that it holds exactly the
/// requested objects and that each one hashes to its id.
pub(super) fn verified<'a>(
    bytes: &'a [u8],
    kind: ObjectKind,
    requested: &[ObjectId],
) -> Result<BTreeMap<ObjectId, &'a [u8]>> {
    let frames = decode_frames(bytes)?;
    let mut out = BTreeMap::new();
    for (id, body) in frames {
        let actual = object_id(kind, body);
        if actual != id {
            return Err(openscion_core::Error::CorruptObject {
                expected: id,
                actual,
            }
            .into());
        }
        out.insert(id, body);
    }
    if let Some(missing) = requested.iter().find(|id| !out.contains_key(id)) {
        return Err(openscion_core::Error::NotFound(*missing).into());
    }
    Ok(out)
}

#[allow(dead_code)]
fn parse_object_id(s: &str) -> Result<ObjectId> {
    s.parse().map_err(|_| Error::Decode {
        url: "locate:objectId".to_owned(),
        message: "invalid object id".to_owned(),
    })
}
