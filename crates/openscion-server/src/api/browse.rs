//! Anonymous tree, blob, and commit reads for a GitHub-like repo page.

use std::collections::{HashSet, VecDeque};
use std::sync::PoisonError;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::Uri;
use base64::Engine as _;
use openscion_core::{ChangesetRecord, EntryKind, ObjectId, Repository};

use super::{ApiError, SharedRepos, first_provider_url, internal_secret, repos_write, worker_base};

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
    let listed: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            let full = format!("{prefix}{}", entry.name);
            let piece_cid = metadata.and_then(|m| m.get(&format!("pcid:{full}")).cloned());
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
    let piece_cid = record
        .changeset
        .metadata
        .get(&format!("pcid:{path}"))
        .cloned();
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
    if let Ok(id) = rev.parse::<ObjectId>() {
        if repo.changeset(id).is_ok() {
            return Ok(id);
        }
    }
    let names = [
        rev.to_owned(),
        format!("refs/heads/{rev}"),
        format!("refs/{rev}"),
    ];
    for name in &names {
        if let Ok(value) = repo.get_ref(name) {
            return Ok(value.target);
        }
    }
    Err(openscion_core::Error::NoSuchRef(rev.to_owned()).into())
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
