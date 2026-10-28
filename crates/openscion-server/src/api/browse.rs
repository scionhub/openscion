//! Anonymous tree, blob, and commit reads for a GitHub-like repo page.
//!
//! Revision names use `lookup_ref_names`, so `main` and `refs/heads/main`
//! resolve to the same stored ref. A missing catalog repo is rejected by the
//! Worker before these handlers run.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::PoisonError;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::Uri;
use base64::Engine as _;
use openscion_core::{ChangesetRecord, EntryKind, ObjectId, Repository};

use super::{
    ApiError, SharedRepos, first_provider_url, internal_secret, repos_write, stored_ref,
    worker_base,
};

/// Lists one directory of a snapshot: `GET /v1/repos/{org}/{repo}/tree/{rev}?path=`.
///
/// # Errors
///
/// Returns [`ApiError`] when the ref, tree, or path does not exist.
pub(crate) async fn get_tree(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, rev)): Path<(String, String, String)>,
    uri: Uri,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = query_param(&uri, "path").unwrap_or_default();
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let (record, tree_id) = snapshot_tree(&repo, &rev, &path)?;
    let entries = repo.tree(tree_id)?;
    let prefix = if path.is_empty() {
        String::new()
    } else {
        format!("{}/", path.trim_matches('/'))
    };
    let metadata = record.as_ref().map(|r| &r.changeset.metadata);
    let file_map = fetch_file_map(&org, &repo_name);
    let listed: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            let full = format!("{prefix}{}", entry.name);
            let piece_cid = piece_for_path(&file_map, metadata, &full);
            let size = if entry.kind == EntryKind::Tree {
                None
            } else {
                repo.object(entry.id)
                    .ok()
                    .map(|bytes| bytes.len() as u64)
                    .or_else(|| {
                        piece_cid.as_deref().and_then(|pcid| {
                            resolve_one(&org, &repo_name, pcid).map(|(_, _, length)| length)
                        })
                    })
            };
            serde_json::json!({
                "name": entry.name,
                "kind": kind_name(entry.kind),
                "id": entry.id.to_string(),
                "size": size,
                "pieceCid": piece_cid,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "ref": rev,
        "path": path,
        "tree": tree_id.to_string(),
        "commit": record.as_ref().map(|r| r.info.id.to_string()),
        "entries": listed,
    })))
}

/// Locates one file: `GET /v1/repos/{org}/{repo}/blob/{rev}?path=`.
///
/// # Errors
///
/// Returns [`ApiError`] when the ref or path does not exist, or `path` is missing.
pub(crate) async fn get_blob(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, rev)): Path<(String, String, String)>,
    uri: Uri,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = query_param(&uri, "path").ok_or_else(|| openscion_core::Error::InvalidChange {
        path: "path".to_owned(),
        rule: "path is required",
    })?;
    if path.is_empty() {
        return Err(openscion_core::Error::InvalidChange {
            path: "path".to_owned(),
            rule: "path is required",
        }
        .into());
    }
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let (record, blob, kind) = snapshot_blob(&repo, &rev, &path)?;
    let size = repo.object(blob).ok().map(|bytes| bytes.len() as u64);
    let file_map = fetch_file_map(&org, &repo_name);
    let piece_cid = piece_for_path(&file_map, Some(&record.changeset.metadata), &path);
    let mut body = serde_json::json!({
        "ref": rev,
        "path": path,
        "kind": kind_name(kind),
        "blob": blob.to_string(),
        "size": size,
        "pieceCid": piece_cid,
        "url": serde_json::Value::Null,
        "offset": serde_json::Value::Null,
        "length": serde_json::Value::Null,
        "raw": format!("/v1/repos/{org}/{repo_name}/objects"),
    });
    if let Some(pcid) = piece_cid.as_deref() {
        if let Some((url, offset, length)) = resolve_one(&org, &repo_name, pcid) {
            body["url"] = serde_json::Value::String(url);
            body["offset"] = serde_json::json!(offset);
            body["length"] = serde_json::json!(length);
            if size.is_none() {
                body["size"] = serde_json::json!(length);
            }
        }
    }
    if body["url"].is_null() {
        if let Ok(bytes) = repo.object(blob) {
            body["size"] = serde_json::json!(bytes.len() as u64);
            if bytes.len() <= 1_048_576 {
                body["contentBase64"] = serde_json::Value::String(
                    base64::engine::general_purpose::STANDARD.encode(bytes.as_ref()),
                );
            }
        }
    }
    Ok(Json(body))
}

/// Diffs two revisions: `GET /v1/repos/{org}/{repo}/compare/{base}...{head}`.
///
/// Each file is `{ path, status: added|modified|removed, baseSize, headSize,
/// basePieceCid, headPieceCid }`. Identical trees return `{ files: [], status:
/// "identical" }`.
///
/// # Errors
///
/// Returns [`ApiError`] when a rev does not exist or `spec` is not `base...head`.
pub(crate) async fn get_compare(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, spec)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Some((base, head)) = spec.split_once("...") else {
        return Err(openscion_core::Error::InvalidChange {
            path: "compare".to_owned(),
            rule: "spec must be base...head",
        }
        .into());
    };
    compare_revs(&repos, &org, &repo_name, base, head)
}

/// Diffs two revisions: `GET /v1/repos/{org}/{repo}/compare?base=&head=`
/// (also served at `/diff`).
///
/// # Errors
///
/// Returns [`ApiError`] when `base` or `head` is missing or a rev does not exist.
pub(crate) async fn get_compare_query(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    uri: Uri,
) -> Result<Json<serde_json::Value>, ApiError> {
    let base = query_param(&uri, "base").ok_or_else(|| openscion_core::Error::InvalidChange {
        path: "base".to_owned(),
        rule: "base is required",
    })?;
    let head = query_param(&uri, "head").ok_or_else(|| openscion_core::Error::InvalidChange {
        path: "head".to_owned(),
        rule: "head is required",
    })?;
    compare_revs(&repos, &org, &repo_name, &base, &head)
}

fn compare_revs(
    repos: &SharedRepos,
    org: &str,
    repo_name: &str,
    base: &str,
    head: &str,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repository = repos_write(repos).get(org, repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let base_id = resolve_rev(&repo, base)?;
    let head_id = resolve_rev(&repo, head)?;
    let base_record = repo.changeset(base_id)?;
    let head_record = repo.changeset(head_id)?;
    let mut base_files = BTreeMap::new();
    let mut head_files = BTreeMap::new();
    flatten_files(&repo, base_record.info.root_tree, "", &mut base_files)?;
    flatten_files(&repo, head_record.info.root_tree, "", &mut head_files)?;
    let mut paths: Vec<String> = base_files
        .keys()
        .chain(head_files.keys())
        .cloned()
        .collect();
    paths.sort();
    paths.dedup();
    let file_map = fetch_file_map(org, repo_name);
    let mut files = Vec::new();
    for path in paths {
        let b = base_files.get(&path);
        let h = head_files.get(&path);
        let status = match (b, h) {
            (None, Some(_)) => "added",
            (Some(_), None) => "removed",
            (Some(base_file), Some(head_file)) if base_file.0 == head_file.0 => continue,
            (Some(_), Some(_)) => "modified",
            (None, None) => continue,
        };
        let base_size =
            b.and_then(|(id, _)| file_size(&repo, org, repo_name, *id, &base_record, &path));
        let head_size =
            h.and_then(|(id, _)| file_size(&repo, org, repo_name, *id, &head_record, &path));
        let base_pcid = piece_for_path(&file_map, Some(&base_record.changeset.metadata), &path);
        let head_pcid = piece_for_path(&file_map, Some(&head_record.changeset.metadata), &path);
        files.push(serde_json::json!({
            "path": path,
            "status": status,
            "baseSize": base_size,
            "headSize": head_size,
            "basePieceCid": base_pcid,
            "headPieceCid": head_pcid,
        }));
    }
    let status = if files.is_empty() {
        "identical"
    } else {
        "changed"
    };
    Ok(Json(serde_json::json!({
        "base": base_id.to_string(),
        "head": head_id.to_string(),
        "status": status,
        "files": files,
    })))
}

fn flatten_files(
    repo: &Repository,
    tree: ObjectId,
    prefix: &str,
    out: &mut BTreeMap<String, (ObjectId, EntryKind)>,
) -> Result<(), ApiError> {
    for entry in repo.tree(tree)? {
        let path = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{prefix}/{}", entry.name)
        };
        if entry.kind == EntryKind::Tree {
            flatten_files(repo, entry.id, &path, out)?;
        } else {
            out.insert(path, (entry.id, entry.kind));
        }
    }
    Ok(())
}

fn file_size(
    repo: &Repository,
    org: &str,
    repo_name: &str,
    id: ObjectId,
    record: &ChangesetRecord,
    path: &str,
) -> Option<u64> {
    repo.object(id)
        .ok()
        .map(|bytes| bytes.len() as u64)
        .or_else(|| {
            let file_map = fetch_file_map(org, repo_name);
            piece_for_path(&file_map, Some(&record.changeset.metadata), path)
                .and_then(|pcid| resolve_one(org, repo_name, &pcid).map(|(_, _, length)| length))
        })
}

/// Latest commits reachable from a ref: `GET /v1/repos/{org}/{repo}/commits/{rev}?limit=20`.
///
/// # Errors
///
/// Returns [`ApiError`] when the ref does not exist.
pub(crate) async fn get_commits(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, rev)): Path<(String, String, String)>,
    uri: Uri,
) -> Result<Json<serde_json::Value>, ApiError> {
    let limit = query_param(&uri, "limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20)
        .clamp(1, 100);
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let tip = resolve_rev(&repo, &rev)?;
    let mut commits = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([tip]);
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            continue;
        }
        let record = repo.changeset(id)?;
        for parent in &record.changeset.parents {
            queue.push_back(*parent);
        }
        commits.push(commit_json(&record));
        if commits.len() >= limit {
            break;
        }
    }
    Ok(Json(serde_json::json!({
        "ref": rev,
        "commits": commits,
    })))
}

fn commit_json(record: &ChangesetRecord) -> serde_json::Value {
    serde_json::json!({
        "id": record.info.id.to_string(),
        "message": record.changeset.message,
        "author": record.changeset.author,
        "created_at": record.changeset.created_at,
        "parents": record.changeset.parents.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "root_tree": record.info.root_tree.to_string(),
        "metadata": record.changeset.metadata,
    })
}

fn kind_name(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File | EntryKind::Executable => "file",
        EntryKind::Symlink => "symlink",
        EntryKind::Tree => "dir",
    }
}

fn query_param(uri: &Uri, name: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == name {
            return Some(
                urlencoding::decode(value)
                    .unwrap_or(std::borrow::Cow::Borrowed(value))
                    .into_owned(),
            );
        }
    }
    None
}

fn resolve_rev(repo: &Repository, rev: &str) -> Result<ObjectId, ApiError> {
    if let Ok(id) = rev.parse::<ObjectId>()
        && repo.changeset(id).is_ok()
    {
        return Ok(id);
    }
    Ok(stored_ref(repo, rev)?.target)
}

fn snapshot_tree(
    repo: &Repository,
    rev: &str,
    path: &str,
) -> Result<(Option<ChangesetRecord>, ObjectId), ApiError> {
    if path.is_empty() {
        if let Ok(id) = rev.parse::<ObjectId>() {
            if repo.changeset(id).is_err() && repo.tree(id).is_ok() {
                return Ok((None, id));
            }
        }
    }
    let record = repo.changeset(resolve_rev(repo, rev)?)?;
    let tree_id = walk_tree(repo, record.info.root_tree, path)?;
    Ok((Some(record), tree_id))
}

fn snapshot_blob(
    repo: &Repository,
    rev: &str,
    path: &str,
) -> Result<(ChangesetRecord, ObjectId, EntryKind), ApiError> {
    let record = repo.changeset(resolve_rev(repo, rev)?)?;
    let (id, kind) = walk_file(repo, record.info.root_tree, path)?;
    Ok((record, id, kind))
}

fn walk_tree(repo: &Repository, mut tree: ObjectId, path: &str) -> Result<ObjectId, ApiError> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(tree);
    }
    for component in trimmed.split('/').filter(|p| !p.is_empty()) {
        let entries = repo.tree(tree)?;
        let entry = entries
            .iter()
            .find(|e| e.name == *component)
            .ok_or(openscion_core::Error::NotFound(tree))?;
        if entry.kind != EntryKind::Tree {
            return Err(openscion_core::Error::InvalidChange {
                path: trimmed.to_owned(),
                rule: "not a directory",
            }
            .into());
        }
        tree = entry.id;
    }
    Ok(tree)
}

fn walk_file(
    repo: &Repository,
    tree: ObjectId,
    path: &str,
) -> Result<(ObjectId, EntryKind), ApiError> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Err(openscion_core::Error::InvalidChange {
            path: "path".to_owned(),
            rule: "path is required",
        }
        .into());
    }
    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    let Some((file_name, dirs)) = parts.split_last() else {
        return Err(openscion_core::Error::InvalidChange {
            path: "path".to_owned(),
            rule: "path is required",
        }
        .into());
    };
    let mut current = tree;
    for component in dirs {
        let entries = repo.tree(current)?;
        let entry = entries
            .iter()
            .find(|e| e.name == *component)
            .ok_or(openscion_core::Error::NotFound(current))?;
        if entry.kind != EntryKind::Tree {
            return Err(openscion_core::Error::InvalidChange {
                path: trimmed.to_owned(),
                rule: "not a directory",
            }
            .into());
        }
        current = entry.id;
    }
    let entries = repo.tree(current)?;
    let entry = entries
        .iter()
        .find(|e| e.name == *file_name)
        .ok_or(openscion_core::Error::NotFound(current))?;
    if entry.kind == EntryKind::Tree {
        return Err(openscion_core::Error::InvalidChange {
            path: trimmed.to_owned(),
            rule: "not a file",
        }
        .into());
    }
    Ok((entry.id, entry.kind))
}

fn fetch_file_map(org: &str, repo: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(base) = worker_base() else {
        return out;
    };
    let Ok(secret) = internal_secret() else {
        return out;
    };
    let agent = ureq::Agent::new_with_defaults();
    let path = format!("/__internal/do/{org}/{repo}/file-map");
    let Ok(resp) = agent
        .get(&format!("{base}{path}"))
        .header("x-internal-secret", &secret)
        .call()
    else {
        return out;
    };
    let Ok(v) = resp.into_body().read_json::<serde_json::Value>() else {
        return out;
    };
    if let Some(files) = v.get("files").and_then(|x| x.as_array()) {
        for row in files {
            if let (Some(path), Some(cid)) = (
                row.get("path").and_then(|x| x.as_str()),
                row.get("pieceCid").and_then(|x| x.as_str()),
            ) {
                out.insert(path.to_owned(), cid.to_owned());
            }
        }
    }
    out
}

fn piece_for_path(
    file_map: &BTreeMap<String, String>,
    metadata: Option<&BTreeMap<String, String>>,
    path: &str,
) -> Option<String> {
    file_map
        .get(path)
        .cloned()
        .or_else(|| metadata.and_then(|m| m.get(&format!("pcid:{path}")).cloned()))
}

fn resolve_one(org: &str, repo: &str, piece_cid: &str) -> Option<(String, u64, u64)> {
    let provider = first_provider_url(org).ok()?;
    let base = worker_base().ok()?;
    let secret = internal_secret().ok()?;
    let agent = ureq::Agent::new_with_defaults();
    let path = format!("/__internal/do/{org}/{repo}/bundles/resolve");
    let body = serde_json::json!({ "pieceCids": [piece_cid] });
    let resp = agent
        .post(&format!("{base}{path}"))
        .header("x-internal-secret", &secret)
        .send_json(&body)
        .ok()?;
    let v: serde_json::Value = resp.into_body().read_json().ok()?;
    let row = v.get("results")?.as_array()?.first()?;
    let bundle = row.get("bundleCid")?.as_str()?;
    let offset = row.get("offset")?.as_u64()?;
    let length = row.get("length")?.as_u64()?;
    let url = format!("{}/piece/{bundle}", provider.trim_end_matches('/'));
    Some((url, offset, length))
}
