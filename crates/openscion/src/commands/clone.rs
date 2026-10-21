//! `opnscn clone`: materialize a snapshot, or one directory of it.

use std::collections::{BTreeMap, HashSet};
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
    let root_tree = client.changeset(target)?.info.root_tree;
    let filter: Vec<&str> = sparse.map_or_else(Vec::new, |path| path.components().collect());
    let wanted = walk_trees(client, root_tree, &filter)?;

    std::fs::create_dir_all(dest).map_err(workcopy::io_error(dest))?;
    let mut files = BTreeMap::new();
    for batch in wanted.chunks(FETCH_BATCH) {
        let ids = unique(batch.iter().map(|(_, _, blob)| *blob));
        // Try locate path
        let mut blob_bytes: BTreeMap<ObjectId, Vec<u8>> = BTreeMap::new();
        if let Ok(locations) = client.locate_objects(&ids) {
            // Group by piece URL
            #[derive(Clone)]
            struct Seg {
                object: ObjectId,
                offset: u64,
                length: u64,
            }
            let mut groups: BTreeMap<String, Vec<Seg>> = BTreeMap::new();
            for loc in locations {
                if let (Some(url), Ok(object)) =
                    (loc.provider_url.as_ref(), parse_object_id(&loc.object_id))
                {
                    let piece_url =
                        format!("{}/piece/{}", url.trim_end_matches('/'), loc.piece_cid);
                    groups.entry(piece_url).or_default().push(Seg {
                        object,
                        offset: loc.offset,
                        length: loc.length,
                    });
                }
            }
            // Fetch per group: try HTTP Range per contiguous block; if server ignores Range (200), download whole piece once and slice.
            let agent = ureq::Agent::new_with_defaults();
            for (piece_url, mut segs) in groups {
                segs.sort_by(|a, b| {
                    a.offset
                        .cmp(&b.offset)
                        .then_with(|| a.length.cmp(&b.length))
                });
                let mut full_piece_buf: Option<Vec<u8>> = None;
                let mut i = 0usize;
                while i < segs.len() {
                    let start = segs[i].offset;
                    let mut end = start + segs[i].length;
                    let mut j = i + 1;
                    while j < segs.len() && segs[j].offset == end {
                        end += segs[j].length;
                        j += 1;
                    }
                    // Attempt a ranged GET for [start, end)
                    let range_header = format!("bytes={}-{}", start, end.saturating_sub(1));
                    let resp = agent
                        .get(&piece_url)
                        .header("Range", &range_header)
                        .call()
                        .map_err(|e| Error::Request {
                            url: piece_url.clone(),
                            message: e.to_string(),
                        })?;
                    if resp.status() == 206 {
                        let mut body = resp.into_body();
                        let buf = body.read_to_vec().map_err(|e| Error::Decode {
                            url: piece_url.clone(),
                            message: e.to_string(),
                        })?;
                        // distribute buffer to segments i..j
                        let mut cursor = 0usize;
                        for seg in &segs[i..j] {
                            let seg_len = usize::try_from(seg.length)
                                .map_err(|_| Error::Decode {
                                    url: piece_url.clone(),
                                    message: "segment too large".to_owned(),
                                })?;
                            let next_end = cursor.checked_add(seg_len).ok_or_else(|| Error::Decode {
                                url: piece_url.clone(),
                                message: "segment overflow".to_owned(),
                            })?;
                            let data = &buf[cursor..next_end];
                            let actual = object_id(ObjectKind::Blob, data);
                            if actual != seg.object {
                                return Err(openscion_core::Error::CorruptObject {
                                    expected: seg.object,
                                    actual,
                                }
                                .into());
                            }
                            blob_bytes.insert(seg.object, data.to_vec());
                            cursor = next_end;
                        }
                    } else if resp.status() == 200 {
                        // Fallback: download whole piece once, then slice
                        if full_piece_buf.is_none() {
                            let mut body = resp.into_body();
                            let buf = body.read_to_vec().map_err(|e| Error::Decode {
                                url: piece_url.clone(),
                                message: e.to_string(),
                            })?;
                            full_piece_buf = Some(buf);
                        }
                        if let Some(buf) = full_piece_buf.as_ref() {
                            for seg in &segs[i..j] {
                                let start = usize::try_from(seg.offset).map_err(|_| Error::Decode {
                                    url: piece_url.clone(),
                                    message: "segment start too large".to_owned(),
                                })?;
                                let seg_len = usize::try_from(seg.length).map_err(|_| Error::Decode {
                                    url: piece_url.clone(),
                                    message: "segment length too large".to_owned(),
                                })?;
                                let end = start.saturating_add(seg_len);
                                if end > buf.len() {
                                    return Err(Error::Decode {
                                        url: piece_url.clone(),
                                        message: "segment out of bounds".to_owned(),
                                    });
                                }
                                let data = &buf[start..end];
                                let actual = object_id(ObjectKind::Blob, data);
                                if actual != seg.object {
                                    return Err(openscion_core::Error::CorruptObject {
                                        expected: seg.object,
                                        actual,
                                    }
                                    .into());
                                }
                                blob_bytes.insert(seg.object, data.to_vec());
                            }
                        } else {
                                return Err(Error::Decode {
                                url: piece_url.clone(),
                                message: "missing piece buffer".to_owned(),
                            });
                        }
                    } else {
                        return Err(Error::Request {
                            url: piece_url.clone(),
                            message: format!("unexpected status {}", resp.status()),
                        });
                    }
                    i = j;
                }
            }
        }
        // Fallback for anything missing: use server proxied /v1/objects
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
            let content = blob_bytes
                .get(blob)
                .map(Vec::as_slice)
                .unwrap_or_default();
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

fn parse_object_id(s: &str) -> Result<ObjectId> {
    s.parse().map_err(|_| Error::Decode {
        url: "locate:objectId".to_owned(),
        message: "invalid object id".to_owned(),
    })
}
