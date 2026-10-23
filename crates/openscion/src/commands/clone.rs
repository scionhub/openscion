//! `opnscn clone`: materialize a snapshot, or one directory of it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
    let stored = client.get_ref(ref_name)?;
    let target = stored.target;
    let filter: Vec<&str> = sparse.map_or_else(Vec::new, |path| path.components().collect());
    let snapshot = fetch_snapshot(client, target, &filter)?;

    std::fs::create_dir_all(dest).map_err(workcopy::io_error(dest))?;
    let mut files = BTreeMap::new();
    for (path, file) in &snapshot.files {
        workcopy::write_file(dest, path, file.kind, &file.bytes)?;
        let (size, mtime) = workcopy::stat(dest, path)?;
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
    let count = files.len();
    let mut state = State {
        server: client.base().to_owned(),
        repo: format!("{}/{}", client.org(), client.repo()),
        ref_name: stored.name.clone(),
        branch: Some(openscion_core::short_ref(&stored.name)),
        upstream: Some(stored.name.clone()),
        base: target,
        sync_onto: None,
        sparse: sparse.map(|path| path.as_str().to_owned()),
        written_at: 0,
        files,
    };
    workcopy::save(dest, &mut state)?;
    Ok((target, count))
}

/// Replaces the working copy at `root` with the snapshot of `ref_name`.
///
/// Refuses when the tree is dirty. Updates branch tracking to `branch` /
/// `upstream` when given.
pub(crate) fn checkout(
    client: &RepoClient,
    root: &Path,
    ref_name: &str,
    branch: Option<&str>,
    upstream: Option<&str>,
) -> Result<ObjectId> {
    if workcopy::is_dirty(root)? {
        return Err(Error::DirtyWorkingCopy);
    }
    let mut state = workcopy::load(root)?;
    let stored = client.get_ref(ref_name)?;
    let filter: Vec<&str> = state
        .sparse
        .as_deref()
        .map(|p| p.split('/').collect())
        .unwrap_or_default();
    let snapshot = fetch_snapshot(client, stored.target, &filter)?;
    apply_snapshot(root, &state.files, &snapshot)?;
    let mut files = BTreeMap::new();
    for (path, file) in &snapshot.files {
        let (size, mtime) = workcopy::stat(root, path)?;
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
    state.base = stored.target;
    state.sync_onto = None;
    let branch = branch.map_or_else(|| openscion_core::short_ref(&stored.name), str::to_owned);
    let upstream = upstream.map_or_else(|| stored.name.clone(), str::to_owned);
    state.set_tracking(branch, upstream);
    workcopy::save(root, &mut state)?;
    Ok(stored.target)
}

fn apply_snapshot(
    root: &Path,
    previous: &BTreeMap<String, FileState>,
    snapshot: &Snapshot,
) -> Result<()> {
    for path in previous.keys() {
        if !snapshot.files.contains_key(path) {
            workcopy::remove_file(root, path)?;
        }
    }
    for (path, file) in &snapshot.files {
        workcopy::write_file(root, path, file.kind, &file.bytes)?;
    }
    Ok(())
}

fn is_empty_dir(path: &Path) -> Result<bool> {
    let mut entries = std::fs::read_dir(path).map_err(workcopy::io_error(path))?;
    Ok(entries.next().is_none())
}

/// One file in a fetched snapshot.
pub(super) struct SnapshotFile {
    pub kind: EntryKind,
    pub blob: ObjectId,
    pub bytes: Vec<u8>,
}

/// A changeset's files, fetched via `PieceCID` Range-GET with an objects fallback.
pub(super) struct Snapshot {
    pub files: BTreeMap<String, SnapshotFile>,
}

/// Fetches every file of `changeset`, limited to `filter` (everything when empty).
///
/// Reuses clone's resolve + storage-provider Range GET, then the objects endpoint.
pub(super) fn fetch_snapshot(
    client: &RepoClient,
    changeset: ObjectId,
    filter: &[&str],
) -> Result<Snapshot> {
    let record = client.changeset(changeset)?;
    let path_to_piece = pcid_map(&record.changeset.metadata);
    let wanted = walk_trees(client, record.info.root_tree, filter)?;
    let blobs = load_blobs(client, &wanted, &path_to_piece)?;
    let mut files = BTreeMap::new();
    for (path, kind, blob) in wanted {
        let bytes = blobs.get(&blob).cloned().unwrap_or_default();
        files.insert(path, SnapshotFile { kind, blob, bytes });
    }
    Ok(Snapshot { files })
}

fn pcid_map(metadata: &BTreeMap<String, String>) -> HashMap<String, String> {
    let mut path_to_piece = HashMap::new();
    for (key, value) in metadata {
        if let Some(path) = key.strip_prefix("pcid:") {
            path_to_piece.insert(path.to_owned(), value.clone());
        }
    }
    path_to_piece
}

fn load_blobs(
    client: &RepoClient,
    wanted: &[Wanted],
    path_to_piece: &HashMap<String, String>,
) -> Result<BTreeMap<ObjectId, Vec<u8>>> {
    let mut blob_bytes: BTreeMap<ObjectId, Vec<u8>> = BTreeMap::new();
    let empty = object_id(ObjectKind::Blob, &[]);
    for batch in wanted.chunks(FETCH_BATCH) {
        let ids = unique(batch.iter().map(|(_, _, blob)| *blob));
        if ids.contains(&empty) {
            blob_bytes.insert(empty, Vec::new());
        }
        let mut pcids: Vec<String> = Vec::new();
        let mut pcid_to_blob: BTreeMap<String, ObjectId> = BTreeMap::new();
        for (path, kind, blob) in batch {
            if *kind == EntryKind::Tree || *blob == empty {
                continue;
            }
            if let Some(pcid) = path_to_piece.get(path) {
                pcids.push(pcid.clone());
                pcid_to_blob.insert(pcid.clone(), *blob);
            }
        }
        if !pcids.is_empty() {
            if let Ok(results) = client.resolve_pieces(&pcids) {
                fetch_ranges(&results, &pcid_to_blob, &mut blob_bytes);
            }
        }
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
    }
    Ok(blob_bytes)
}

fn fetch_ranges(
    results: &[(String, String, u64, u64)],
    pcid_to_blob: &BTreeMap<String, ObjectId>,
    blob_bytes: &mut BTreeMap<ObjectId, Vec<u8>>,
) {
    struct Seg {
        blob: ObjectId,
        offset: u64,
        length: u64,
    }
    let mut groups: BTreeMap<String, Vec<Seg>> = BTreeMap::new();
    for (pcid, url, off, len) in results {
        if let Some(blob) = pcid_to_blob.get(pcid) {
            groups.entry(url.clone()).or_default().push(Seg {
                blob: *blob,
                offset: *off,
                length: *len,
            });
        }
    }
    let groups_vec: Vec<(String, Vec<Seg>)> = groups
        .into_iter()
        .map(|(url, mut segs)| {
            segs.sort_by(|a, b| a.offset.cmp(&b.offset));
            (url, segs)
        })
        .collect();
    let blob_bytes_arc = Arc::new(Mutex::new(std::mem::take(blob_bytes)));
    let concurrency = 16usize;
    let next_index = Arc::new(AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for _ in 0..concurrency {
            let groups_ref = &groups_vec;
            let out = Arc::clone(&blob_bytes_arc);
            let next = Arc::clone(&next_index);
            scope.spawn(move || {
                let agent = ureq::Agent::new_with_defaults();
                loop {
                    let j = next.fetch_add(1, Ordering::AcqRel);
                    if j >= groups_ref.len() {
                        break;
                    }
                    let (ref url, ref segs) = groups_ref[j];
                    let mut i = 0usize;
                    while i < segs.len() {
                        let start = segs[i].offset;
                        let mut end = start + segs[i].length;
                        let mut k = i + 1;
                        while k < segs.len() && segs[k].offset == end {
                            end += segs[k].length;
                            k += 1;
                        }
                        let range_header = format!("bytes={}-{}", start, end.saturating_sub(1));
                        if let Ok(resp) = agent.get(url).header("Range", &range_header).call() {
                            if resp.status() == 206 || resp.status() == 200 {
                                let buf = resp
                                    .into_body()
                                    .with_config()
                                    .limit(u64::MAX)
                                    .read_to_vec()
                                    .unwrap_or_default();
                                let mut cursor = 0usize;
                                for seg in &segs[i..k] {
                                    let seg_len = usize::try_from(seg.length).unwrap_or(0);
                                    let next_end = cursor.saturating_add(seg_len);
                                    if next_end <= buf.len() {
                                        let data = buf[cursor..next_end].to_vec();
                                        let actual = object_id(ObjectKind::Blob, &data);
                                        if actual == seg.blob {
                                            out.lock()
                                                .unwrap_or_else(PoisonError::into_inner)
                                                .insert(seg.blob, data);
                                        }
                                    }
                                    cursor = next_end;
                                }
                            }
                        }
                        i = k;
                    }
                }
            });
        }
    });
    *blob_bytes = blob_bytes_arc
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
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
