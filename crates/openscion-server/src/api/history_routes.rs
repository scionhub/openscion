//! Batched history transfer and first-parent walks.
//!
//! Push asks which changeset ids the remote already has, then imports the
//! missing ones in parent-before-child order. The walks stay on the server
//! so a deep history is not one HTTP request per commit.

use std::collections::{HashSet, VecDeque};
use std::sync::PoisonError;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::routing::{get, post};
use openscion_core::{Changeset, ChangesetInfo, ObjectId};
use serde_json::{Value, json};

use super::{ApiError, SharedRepos};

fn id_list(body: &Value) -> Vec<String> {
    body.get("ids")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Routes mounted beside the changeset endpoints.
pub(super) fn routes() -> Router<SharedRepos> {
    Router::new()
        .route(
            "/v1/repos/{org}/{repo}/changesets/import",
            post(import_changesets),
        )
        .route(
            "/v1/repos/{org}/{repo}/changesets/have",
            post(have_changesets),
        )
        .route(
            "/v1/repos/{org}/{repo}/changesets/export",
            post(export_changesets),
        )
        .route(
            "/v1/repos/{org}/{repo}/changesets/{id}/ancestors",
            get(ancestors),
        )
        .route(
            "/v1/repos/{org}/{repo}/history/first-parent",
            get(first_parent),
        )
        .route("/v1/repos/{org}/{repo}/history/merge-base", get(merge_base))
}

fn query_param(uri: &Uri, key: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            return Some(value.to_owned());
        }
    }
    None
}

fn query_usize(uri: &Uri, key: &str, default: usize) -> usize {
    query_param(uri, key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn parse_id(text: &str) -> Result<ObjectId, ApiError> {
    text.parse().map_err(ApiError::from)
}

fn malformed() -> ApiError {
    openscion_core::Error::InvalidChange {
        path: "changesets".to_owned(),
        rule: "malformed changeset",
    }
    .into()
}

fn append_one(
    repos: &SharedRepos,
    org: &str,
    repo_name: &str,
    changeset: Changeset,
) -> Result<ChangesetInfo, ApiError> {
    let repository = super::repos_write(repos).get(org, repo_name)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let info = repo.append_existing_changeset(changeset)?;
    let record = repo.changeset(info.id)?;
    super::repos_read(repos).persist_changeset(org, repo_name, info, &record)?;
    if super::worker_base().is_ok() {
        let body = json!({
            "id": format!("{}", info.id),
            "lsn": info.lsn,
            "root_tree": format!("{}", info.root_tree),
            "changeset": record.changeset
        });
        let path = format!("/__internal/do/{org}/{repo_name}/changesets");
        let _ = super::do_post(&path, &body);
    }
    Ok(info)
}

/// `POST /changesets/import` accepts one changeset or `{ "changesets": [...] }`.
pub(super) async fn import_changesets(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if let Some(list) = body.get("changesets") {
        let changesets: Vec<Changeset> =
            serde_json::from_value(list.clone()).map_err(|_| malformed())?;
        let mut imported = Vec::with_capacity(changesets.len());
        for changeset in changesets {
            imported.push(append_one(&repos, &org, &repo_name, changeset)?);
        }
        return Ok(Json(json!({ "imported": imported })));
    }
    let changeset: Changeset = serde_json::from_value(body).map_err(|_| malformed())?;
    Ok(Json(
        serde_json::to_value(append_one(&repos, &org, &repo_name, changeset)?)
            .map_err(|_| malformed())?,
    ))
}

/// `POST /changesets/have` reports which of `ids` this repository stores.
pub(super) async fn have_changesets(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let repository = super::repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let mut present = Vec::new();
    for id in id_list(&body) {
        let Ok(parsed) = id.parse::<ObjectId>() else {
            continue;
        };
        if repo.changeset(parsed).is_ok() {
            present.push(id);
        }
    }
    Ok(Json(json!({ "present": present })))
}

/// `POST /changesets/export` returns the requested records, in request order.
pub(super) async fn export_changesets(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let repository = super::repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let ids = id_list(&body);
    let mut changesets = Vec::with_capacity(ids.len());
    for id in &ids {
        let parsed = parse_id(id)?;
        changesets.push(repo.changeset(parsed)?);
    }
    Ok(Json(json!({ "changesets": changesets })))
}

/// `GET /changesets/{id}/ancestors` pages parent-before-child ids.
pub(super) async fn ancestors(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, id)): Path<(String, String, String)>,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    let tip = parse_id(&id)?;
    let repository = super::repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let ordered = ancestor_order(&repo, tip)?;
    let limit = query_usize(&uri, "limit", 2000).clamp(1, 5000);
    let start = query_usize(&uri, "cursor", 0).min(ordered.len());
    let end = (start + limit).min(ordered.len());
    let next = if end < ordered.len() { Some(end) } else { None };
    Ok(Json(
        json!({ "items": &ordered[start..end], "next_cursor": next }),
    ))
}

fn ancestor_order(
    repo: &openscion_core::Repository,
    tip: ObjectId,
) -> Result<Vec<Value>, openscion_core::Error> {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![(tip, false)];
    while let Some((id, expanded)) = stack.pop() {
        if expanded {
            if !seen.insert(id) {
                continue;
            }
            let record = repo.changeset(id)?;
            ordered.push(json!({
                "id": id.to_string(),
                "parents": record.changeset.parents.iter().map(ToString::to_string).collect::<Vec<_>>(),
                "lsn": record.info.lsn,
            }));
            continue;
        }
        if seen.contains(&id) {
            continue;
        }
        stack.push((id, true));
        let record = repo.changeset(id)?;
        for parent in record.changeset.parents.iter().rev() {
            stack.push((*parent, false));
        }
    }
    Ok(ordered)
}

/// `GET /history/first-parent?bad&good` lists commits after `good` through `bad`.
pub(super) async fn first_parent(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    let bad = parse_id(&query_param(&uri, "bad").unwrap_or_default())?;
    let good = parse_id(&query_param(&uri, "good").unwrap_or_default())?;
    let repository = super::repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let ids = first_parent_ids(&repo, bad, good)?;
    Ok(Json(json!({ "ids": ids })))
}

fn first_parent_ids(
    repo: &openscion_core::Repository,
    bad: ObjectId,
    good: ObjectId,
) -> Result<Vec<String>, openscion_core::Error> {
    if bad == good {
        return Err(openscion_core::Error::NotFound(bad));
    }
    let mut newest = Vec::new();
    let mut id = bad;
    for _ in 0..1_000_000 {
        if id == good {
            newest.reverse();
            return if newest.is_empty() {
                Err(openscion_core::Error::NotFound(bad))
            } else {
                Ok(newest)
            };
        }
        newest.push(id.to_string());
        let record = repo.changeset(id)?;
        let Some(parent) = record.changeset.parents.first().copied() else {
            return Err(openscion_core::Error::NotFound(good));
        };
        id = parent;
    }
    Err(openscion_core::Error::NotFound(good))
}

/// `GET /history/merge-base?a&b` is the nearest shared ancestor, or null.
pub(super) async fn merge_base(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    uri: Uri,
) -> Result<Json<Value>, ApiError> {
    let a = parse_id(&query_param(&uri, "a").unwrap_or_default())?;
    let b = parse_id(&query_param(&uri, "b").unwrap_or_default())?;
    let repository = super::repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let id = merge_base_of(&repo, a, b)?;
    Ok(Json(json!({ "id": id.map(|value| value.to_string()) })))
}

fn merge_base_of(
    repo: &openscion_core::Repository,
    a: ObjectId,
    b: ObjectId,
) -> Result<Option<ObjectId>, openscion_core::Error> {
    if a == b {
        return Ok(Some(a));
    }
    let mut seen_a = HashSet::from([a]);
    let mut seen_b = HashSet::from([b]);
    let mut queue_a = VecDeque::from([a]);
    let mut queue_b = VecDeque::from([b]);
    while !queue_a.is_empty() || !queue_b.is_empty() {
        if let Some(id) = queue_a.pop_front() {
            for parent in repo.changeset(id)?.changeset.parents.clone() {
                if seen_b.contains(&parent) {
                    return Ok(Some(parent));
                }
                if seen_a.insert(parent) {
                    queue_a.push_back(parent);
                }
            }
        }
        if let Some(id) = queue_b.pop_front() {
            for parent in repo.changeset(id)?.changeset.parents.clone() {
                if seen_a.contains(&parent) {
                    return Ok(Some(parent));
                }
                if seen_b.insert(parent) {
                    queue_b.push_back(parent);
                }
            }
        }
    }
    Ok(None)
}
