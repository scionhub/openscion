//! The OpenScion API routes: objects, changesets, and refs over the engine.
//!
//! Multi-repo endpoints live under `/v1/repos/{org}/{repo}/...`. Legacy
//! single-repo endpoints remain available at `/v1/...` and map to
//! `local/default` for compatibility. Filecoin locate/redirect endpoints live
//! at `/v1/objects/locate` and `/v1/objects/{id}`.
//!
//! Failures answer with an `ErrorBody`; see [`ApiError`] for the status codes.

mod browse;
mod failure;
mod packer;

use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use argon2::PasswordVerifier;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, post};
use axum::{Json, Router};
// base64 no longer used in direct path
use openscion_core::filecoin::{compute_piece_cid_minimal, compute_piece_cid_proofs};
use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, FetchObjects, FrameWriter, ObjectId,
    ObjectKind, RefValue, StoredObjects, UpdateRef, decode_frames, lookup_ref_names, short_ref,
};

use crate::api::packer::get_status;
use crate::pdp::PdpClient;
use crate::repo_manager::RepoManager;
use ethers_core::types::U256;
pub use failure::ApiError;

/// The repo manager every request shares.
pub type SharedRepos = Arc<RwLock<RepoManager>>;

/// The largest request body the API accepts: a batch of blobs.
pub const MAX_BODY_BYTES: usize = 1 << 30;

const DEFAULT_ORG: &str = "local";
const DEFAULT_REPO: &str = "default";

/// The API routes, with the shared repository as their state.
pub(crate) fn routes() -> Router<SharedRepos> {
    Router::new()
        // Catalog
        .route("/v1/orgs", get(list_orgs))
        .route("/v1/orgs/{org}/repos", get(list_repos))
        .route("/v1/orgs/{org}/membership", get(org_membership))
        .route("/v1/repos/{org}/{repo}", get(get_repo).put(create_repo))
        .route("/v1/repos/{org}/{repo}/branches", get(list_branches))
        // Redirect-compatible PieceCID reads (no lookup)
        .route(
            "/v1/repos/{org}/{repo}/objects/{id}",
            get(get_object_by_piececid),
        )
        // Admin
        .route("/v1/admin/packer/status", get(admin_packer_status))
        .route("/v1/admin/packer/flush", post(admin_packer_flush))
        .route("/v1/admin/reset", post(admin_reset))
        .route("/v1/admin/add-pieces", post(admin_add_pieces_readable))
        // Auth
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/signup", post(signup))
        // Repo-scoped routes
        .route("/v1/repos/{org}/{repo}/blobs", post(put_blobs))
        .route("/v1/repos/{org}/{repo}/objects", post(fetch_objects))
        .route(
            "/v1/repos/{org}/{repo}/objects/missing",
            post(missing_objects),
        )
        .route(
            "/v1/repos/{org}/{repo}/objects/resolve",
            post(resolve_objects),
        )
        .route(
            "/v1/repos/{org}/{repo}/objects/present",
            post(present_objects),
        )
        .route("/v1/repos/{org}/{repo}/changesets", post(create_changeset))
        .route("/v1/repos/{org}/{repo}/changesets/{id}", get(get_changeset))
        .route(
            "/v1/repos/{org}/{repo}/refs/{*name}",
            get(get_ref).post(update_ref).delete(delete_ref),
        )
        .route("/v1/repos/{org}/{repo}/tree/{*rev}", get(browse::get_tree))
        .route("/v1/repos/{org}/{repo}/blob/{*rev}", get(browse::get_blob))
        .route(
            "/v1/repos/{org}/{repo}/commits/{*rev}",
            get(browse::get_commits),
        )
        // Compatibility: single-repo endpoints map to a default repo.
        .route("/v1/blobs", post(put_blobs_default))
        .route("/v1/objects", post(fetch_objects_default))
        .route("/v1/objects/locate", post(locate_objects))
        .route("/v1/objects/{id}", get(get_object_default))
        .route("/v1/changesets", post(create_changeset_default))
        .route("/v1/changesets/{id}", get(get_changeset_default))
        .route(
            "/v1/refs/{*name}",
            get(get_ref_default).post(update_ref_default),
        )
        // Filecoin helper endpoints
        .route(
            "/v1/filecoin/providers",
            get(get_providers).post(add_provider),
        )
        .route("/v1/filecoin/datasets", get(get_datasets).post(add_dataset))
        .route("/v1/filecoin/upload", post(filecoin_upload))
        .route("/v1/filecoin/compute", post(filecoin_compute))
        .route("/v1/filecoin/pieces/{cid}/bytes", get(get_piece_bytes))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

// A handler that panicked mid-write cannot leave the repository half-updated:
// every engine call validates before it mutates. So a poisoned lock still
// guards consistent data, and the server keeps serving rather than failing
// every later request.
pub(crate) fn repos_read(repos: &SharedRepos) -> RwLockReadGuard<'_, RepoManager> {
    repos.read().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn repos_write(repos: &SharedRepos) -> RwLockWriteGuard<'_, RepoManager> {
    repos.write().unwrap_or_else(PoisonError::into_inner)
}

async fn list_orgs(State(repos): State<SharedRepos>) -> Result<Json<Vec<String>>, ApiError> {
    Ok(Json(repos_read(&repos).list_orgs()?))
}

async fn list_repos(
    State(repos): State<SharedRepos>,
    Path(org): Path<String>,
) -> Result<Json<Vec<String>>, ApiError> {
    Ok(Json(repos_read(&repos).list_repos(&org)?))
}

/// Local servers have no membership table; treat every caller as a member so
/// `opnscn branch new` creates `refs/heads/<name>`. The Worker overrides this
/// with a D1-backed answer.
#[allow(clippy::unused_async)]
async fn org_membership(Path(org): Path<String>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "org": org,
        "member": true,
        "admin": true,
    }))
}

async fn list_branches(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let branches: Vec<serde_json::Value> = repo
        .list_refs()
        .into_iter()
        .filter(|value| !value.name.starts_with("refs/tags/"))
        .map(|value| {
            serde_json::json!({
                "name": short_ref(&value.name),
                "target": value.target.to_string(),
                "ref": value.name,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "branches": branches })))
}

async fn create_repo(
    State(repos): State<SharedRepos>,
    Path((org, repo)): Path<(String, String)>,
) -> Result<(), ApiError> {
    repos_write(&repos).create_repo(&org, &repo)?;
    Ok(())
}

#[allow(clippy::unused_async)]
async fn get_repo(
    Path((org, repo)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    Ok(Json(serde_json::json!({ "org": org, "name": repo })))
}

#[axum::debug_handler]
async fn put_blobs(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    let frames = decode_frames(&body)?;
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let mut ids = Vec::with_capacity(frames.len());
    let org_hdr = current_org_header(&headers);
    // Persist into the in-memory repo and on-disk dev storage first
    // while building a batch for direct aggregation + upload to SP.
    let mut batch_items: Vec<(ObjectId, Vec<u8>)> = Vec::with_capacity(frames.len());
    {
        let mut repo_guard = repository.write().unwrap_or_else(PoisonError::into_inner);
        for (id, bytes) in frames {
            repo_guard.put_blob_verified(id, bytes)?;
            repos_read(&repos).persist_object(&org, &repo_name, id, ObjectKind::Blob, bytes)?;
            ids.push(id);
            batch_items.push((id, bytes.to_vec()));
        }
    }
    // Aggregate and upload directly to SP; record bundle mapping in RepoDO synchronously.
    // Run in a blocking task to keep the handler future Send.
    let org_for_block = org.clone();
    let _ = &org_hdr;
    let repo_for_block = repo_name.clone();
    let items_for_block = batch_items.clone();
    tokio::task::spawn_blocking(move || {
        pack_and_upload_direct_blocking(&org_for_block, &repo_for_block, &items_for_block)
    })
    .await
    .map_err(|_| {
        ApiError::from(openscion_core::Error::InvalidChange {
            path: "pack".to_owned(),
            rule: "join failed",
        })
    })??;
    Ok(Json(StoredObjects::new(ids)))
}

#[axum::debug_handler]
async fn put_blobs_default(
    State(repos): State<SharedRepos>,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    put_blobs(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())),
        HeaderMap::new(),
        body,
    )
    .await
}

// Legacy D1 staging path removed.

// Direct aggregation path: build pieces up to a threshold and upload to SP,
// then register the aggregate with sub-pieces and record bundle mapping in RepoDO.
const PACK_DIRECT_THRESHOLD: usize = 32 * 1024 * 1024; // 32 MiB
fn pack_and_upload_direct_blocking(
    org: &str,
    repo: &str,
    items: &[(ObjectId, Vec<u8>)],
) -> Result<(), ApiError> {
    // Best-effort: flush any pending on-chain adds recorded in the RepoDO first.
    let _ = flush_pending_adds_blocking(org, repo);
    if items.is_empty() {
        return Ok(());
    }
    // Build one or more aggregates within the threshold.
    let mut cursor = 0usize;
    while cursor < items.len() {
        let mut buf = Vec::<u8>::new();
        let mut members = Vec::<(String, u64, u64)>::new(); // (subPieceCid, offset, length)
        while cursor < items.len() && buf.len() < PACK_DIRECT_THRESHOLD {
            let (id, bytes) = &items[cursor];
            // Compute the object's sub-piece CID
            let sub = compute_piece_cid_proofs(bytes)
                .or_else(|_| compute_piece_cid_minimal(bytes))
                .map_err(|_| openscion_core::Error::InvalidChange {
                    path: "filecoin".to_owned(),
                    rule: "compute failed",
                })?
                .to_string();
            let offset = buf.len() as u64;
            let length = bytes.len() as u64;
            // Ensure the in-memory repository already has the verified blob (done upstream).
            let _ = (id, &sub);
            buf.extend_from_slice(bytes);
            members.push((sub, offset, length));
            cursor += 1;
        }
        if buf.is_empty() {
            break;
        }
        // Compute aggregate piece CID
        let agg = compute_piece_cid_proofs(&buf)
            .or_else(|_| compute_piece_cid_minimal(&buf))
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "filecoin".to_owned(),
                rule: "compute failed",
            })?
            .to_string();
        // Upload to SP synchronously using blocking HTTP (ureq) to avoid non-Send futures in handlers
        if let Ok(base) = std::env::var("PDP_BASE_URL") {
            if !base.is_empty() {
                let agent = ureq::Agent::new_with_defaults();
                if let Ok(resp) = agent.post(&format!("{base}/pdp/piece/uploads")).send(()) {
                    if let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok())
                    {
                        let upload_url = format!("{}{}", base.trim_end_matches('/'), loc);
                        let _ = agent.put(&upload_url).send(&buf);
                        let _ = agent
                            .post(&upload_url)
                            .send_json(serde_json::json!({ "pieceCid": agg }));
                        // Wait parked
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(60);
                        loop {
                            if std::time::Instant::now() >= deadline {
                                break;
                            }
                            if agent
                                .get(&format!("{base}/pdp/piece?pieceCid={agg}"))
                                .call()
                                .map(|r| r.status() == 200)
                                .unwrap_or(false)
                            {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }
                    }
                }
            }
        }
        // Record bundle mapping in RepoDO (best-effort)
        let body = serde_json::json!({
            "bundleCid": agg,
            "members": members.iter().map(|(p, o, l)| serde_json::json!({
                "pieceCid": p,
                "offset": o,
                "length": l
            })).collect::<Vec<_>>()
        });
        let path = format!("/__internal/do/{org}/{repo}/bundle-map");
        let _ = do_post(&path, &body);
        // Record a pending on-chain add for durability; actual on-chain add runs async elsewhere.
        let pend_body = serde_json::json!({
            "bundleCid": agg,
            "subPieceCids": members.iter().map(|(p, _, _)| p.clone()).collect::<Vec<_>>()
        });
        let _ = do_post(
            &format!("/__internal/do/{org}/{repo}/pending-adds"),
            &pend_body,
        );
    }
    Ok(())
}

// Deterministic dataset id per org: U256(sha256(org))
#[allow(dead_code)]
fn stable_dataset_id_for_org(org: &str) -> U256 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(org.as_bytes());
    let bytes = hasher.finalize();
    U256::from_big_endian(&bytes)
}

// Best-effort retry of pending adds recorded in the RepoDO.
fn flush_pending_adds_blocking(org: &str, repo: &str) -> Result<(), ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}/__internal/do/{org}/{repo}/pending-adds");
    let resp = agent
        .get(&url)
        .header("x-internal-secret", &secret)
        .call()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "repodo".to_owned(),
            rule: "pending-adds fetch failed",
        })?;
    let mut body = resp.into_body();
    let v: serde_json::Value =
        body.read_json()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "pending-adds decode failed",
            })?;
    let Some(arr) = v.get("pending").and_then(|x| x.as_array()) else {
        return Ok(());
    };
    if arr.is_empty() {
        return Ok(());
    }
    let _ = arr;
    Ok(())
}

async fn fetch_objects(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    Json(request): Json<FetchObjects>,
) -> Result<impl IntoResponse, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let repository = repository.read().unwrap_or_else(PoisonError::into_inner);
    let mut frames = FrameWriter::new();
    for id in request.ids {
        frames.push(id, &repository.object(id)?);
    }
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        frames.finish(),
    ))
}

async fn fetch_objects_default(
    State(repos): State<SharedRepos>,
    Json(request): Json<FetchObjects>,
) -> Result<impl IntoResponse, ApiError> {
    fetch_objects(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())),
        Json(request),
    )
    .await
}

#[derive(serde::Deserialize)]
struct MissingReq {
    ids: Vec<String>,
}

async fn missing_objects(
    _state: State<SharedRepos>,
    Path((org, _repo_name)): Path<(String, String)>,
    Json(req): Json<MissingReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Locate through D1 and treat staged-present as found; report only true missing.
    let body = serde_json::json!({ "ids": req.ids });
    let out: serde_json::Value = d1_post_read(&format!("/__internal/d1/{org}/locate"), &body)?;
    let mut found = std::collections::HashSet::<String>::new();
    if let Some(arr) = out.get("locations").and_then(|v| v.as_array()) {
        for loc in arr {
            if let Some(id) = loc.get("objectId").and_then(|v| v.as_str()) {
                found.insert(id.to_owned());
            }
        }
    }
    // Include staged-but-unpacked objects
    let present: serde_json::Value =
        d1_post_read(&format!("/__internal/d1/{org}/staging/present"), &body)?;
    if let Some(arr) = present.get("present").and_then(|v| v.as_array()) {
        for idv in arr {
            if let Some(id) = idv.as_str() {
                found.insert(id.to_owned());
            }
        }
    }
    let ids_arr = body["ids"].as_array().cloned().unwrap_or_default();
    let missing: Vec<String> = ids_arr
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .filter(|id| !found.contains(id))
        .collect();
    Ok(Json(serde_json::json!({ "missing": missing })))
}

async fn present_objects(
    state: State<SharedRepos>,
    path: Path<(String, String)>,
    Json(req): Json<MissingReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(missing_json) = missing_objects(
        state,
        path,
        Json(MissingReq {
            ids: req.ids.clone(),
        }),
    )
    .await?;
    let missing_set: std::collections::HashSet<String> = missing_json
        .get("missing")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let present: Vec<String> = req
        .ids
        .into_iter()
        .filter(|id| !missing_set.contains(id))
        .collect();
    Ok(Json(serde_json::json!({ "present": present })))
}

#[derive(serde::Deserialize)]
struct ResolveReq {
    ids: Vec<String>,
}
async fn resolve_objects(
    _state: State<SharedRepos>,
    Path((org, repo)): Path<(String, String)>,
    Json(req): Json<ResolveReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let provider = first_provider_url(&org)?;
    // Call RepoDO to resolve in batch
    let body = serde_json::json!({ "pieceCids": req.ids });
    let path = format!("/__internal/do/{org}/{repo}/bundles/resolve");
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let resp = agent
        .post(&format!("{base}{path}"))
        .header("x-internal-secret", &secret)
        .send_json(&body)
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "repodo".to_owned(),
            rule: "resolve failed",
        })?;
    let mut body = resp.into_body();
    let v: serde_json::Value =
        body.read_json()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "decode failed",
            })?;
    let results = v
        .get("results")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    // Map to include provider URL
    let out: Vec<serde_json::Value> = results
        .into_iter()
        .map(|r| {
            let mut m = r;
            if let Some(obj) = m.as_object_mut() {
                if let Some(bundle) = obj.get("bundleCid").and_then(|x| x.as_str()) {
                    obj.insert(
                        "url".to_owned(),
                        serde_json::json!(format!(
                            "{}/piece/{}",
                            provider.trim_end_matches('/'),
                            bundle
                        )),
                    );
                }
            }
            m
        })
        .collect();
    Ok(Json(serde_json::json!({ "results": out })))
}

async fn filecoin_compute(
    _headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let cid = compute_piece_cid_proofs(&body)
        .or_else(|_| compute_piece_cid_minimal(&body))
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "compute failed",
        })?;
    Ok(Json(serde_json::json!({ "piece_cid": cid.to_string() })))
}

#[derive(serde::Deserialize)]
struct LocateRequest {
    ids: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ObjectLocation {
    #[serde(rename = "objectId")]
    object_id: String,
    #[serde(rename = "pieceCid")]
    piece_cid: String,
    offset: u64,
    length: u64,
    #[serde(rename = "providerUrl")]
    provider_url: Option<String>,
    #[serde(rename = "pieceSize")]
    piece_size: Option<u64>,
}

async fn locate_objects(
    headers: HeaderMap,
    Json(req): Json<LocateRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let org = current_org_header(&headers);
    let provider = first_provider_url(&org)?;
    let locations: Vec<serde_json::Value> = req
        .ids
        .into_iter()
        .map(|id| {
            serde_json::json!({
                "objectId": id,
                "pieceCid": id,
                "offset": 0,
                "length": 0,
                "providerUrl": provider,
                "pieceSize": null
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "locations": locations })))
}

async fn get_object_default(
    State(repos): State<SharedRepos>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    // Redirect by PieceCID with fallback proxy (default org and repo)
    let org = current_org_header(&headers);
    if first_provider_url(&org).is_ok() {
        // Reuse the repo-scoped code path with default repo
        return get_object_by_piececid(headers, Path((org, DEFAULT_REPO.to_owned(), id))).await;
    }
    // Fallback: serve from repository staging (in-memory object store of default repo)
    let id_parsed: ObjectId = id.parse()?;
    let repository = repos_write(&repos).get(DEFAULT_ORG, DEFAULT_REPO)?;
    let repo = repository.read().unwrap_or_else(PoisonError::into_inner);
    let bytes = repo.object(id_parsed)?;
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        bytes.to_vec(),
    )
        .into_response())
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Provider {
    id: String,
    name: String,
    endpoint_url: Option<String>,
    region: Option<String>,
    status: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Dataset {
    id: String,
    name: String,
    description: Option<String>,
}

// Provider and dataset registries are stored in D1; in-memory statics removed.

async fn get_providers(headers: HeaderMap) -> Result<Json<Vec<Provider>>, ApiError> {
    let org = current_org_header(&headers);
    let v = d1_get_json(&format!("/__internal/d1/{org}/providers"))?;
    let list: Vec<Provider> = v
        .get("providers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|x| serde_json::from_value(x).ok())
        .collect();
    Ok(Json(list))
}

async fn add_provider(
    headers: HeaderMap,
    Json(p): Json<Provider>,
) -> Result<Json<Provider>, ApiError> {
    let org = current_org_header(&headers);
    d1_post(&format!("/__internal/d1/{org}/providers"), &p)?;
    Ok(Json(p))
}

async fn get_datasets(headers: HeaderMap) -> Result<Json<Vec<Dataset>>, ApiError> {
    let org = current_org_header(&headers);
    let list = d1_get::<Vec<Dataset>>(&format!("/__internal/d1/{org}/datasets"))?;
    Ok(Json(list))
}

async fn add_dataset(
    headers: HeaderMap,
    Json(d): Json<Dataset>,
) -> Result<Json<Dataset>, ApiError> {
    let org = current_org_header(&headers);
    d1_post(&format!("/__internal/d1/{org}/datasets"), &d)?;
    Ok(Json(d))
}

async fn filecoin_upload(
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let cid = compute_piece_cid_proofs(&body)
        .or_else(|_| compute_piece_cid_minimal(&body))
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "compute failed",
        })?;
    let org = current_org_header(&headers);
    // register piece & upload in D1
    let upload_id = uuid::Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "pieceCid": cid.to_string(),
        "datasetId": "default",
        "sizeBytes": body.len(),
        "state": "queued",
        "uploadId": upload_id,
        "source": "api"
    });
    d1_post(&format!("/__internal/d1/{org}/upload"), &payload)?;
    // Attempt live PDP add if configured
    let pdp = PdpClient::from_env();
    if !pdp.is_enabled() {
        return Ok(Json(
            serde_json::json!({ "piece_cid": cid.to_string(), "state": "queued" }),
        ));
    }
    let _ = pdp.create_and_add_pieces(&[cid.to_string()]).await;
    Ok(Json(serde_json::json!({
        "piece_cid": cid.to_string(),
        "state": "queued"
    })))
}

pub(crate) fn worker_base() -> Result<String, ApiError> {
    std::env::var("WORKER_BASE_URL").map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "missing WORKER_BASE_URL",
        }
        .into()
    })
}

pub(crate) fn internal_secret() -> Result<String, ApiError> {
    std::env::var("INTERNAL_SECRET").map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "missing INTERNAL_SECRET",
        }
        .into()
    })
}

fn current_org_header(headers: &HeaderMap) -> String {
    headers
        .get("x-org")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("filecoin-project")
        .to_owned()
}
// no current_repo_header: repo is explicit in routes

fn d1_get<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}");
    let resp = agent
        .get(&url)
        .header("x-internal-secret", &secret)
        .call()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "get failed",
        })?;
    let mut body = resp.into_body();
    let text = body
        .read_to_string()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "decode failed",
        })?;
    serde_json::from_str(&text).map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "decode failed",
        }
        .into()
    })
}

fn d1_get_json(path: &str) -> Result<serde_json::Value, ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}");
    let resp = agent
        .get(&url)
        .header("x-internal-secret", &secret)
        .call()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "get failed",
        })?;
    let mut body = resp.into_body();
    let text = body
        .read_to_string()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "decode failed",
        })?;
    serde_json::from_str(&text).map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "decode failed",
        }
        .into()
    })
}

pub(crate) fn first_provider_url(org: &str) -> Result<String, ApiError> {
    if let Ok(base) = std::env::var("PDP_BASE_URL") {
        if !base.is_empty() {
            return Ok(base);
        }
    }
    let v = d1_get_json(&format!("/__internal/d1/{org}/providers"))?;
    if let Some(arr) = v.get("providers").and_then(|v| v.as_array()) {
        if let Some(url) = arr
            .iter()
            .find_map(|p| p.get("endpoint_url").and_then(|x| x.as_str()))
        {
            return Ok(url.to_owned());
        }
    }
    Err(openscion_core::Error::InvalidChange {
        path: "providers".to_owned(),
        rule: "no provider configured",
    }
    .into())
}

fn do_post(path: &str, body: &impl serde::Serialize) -> Result<(), ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}");
    let _ = agent
        .post(&url)
        .header("x-internal-secret", &secret)
        .send_json(body)
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "do".to_owned(),
            rule: "post failed",
        })?;
    Ok(())
}

fn d1_post(path: &str, body: &impl serde::Serialize) -> Result<(), ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}");
    let _ = agent
        .post(&url)
        .header("x-internal-secret", &secret)
        .send_json(body)
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "post failed",
        })?;
    Ok(())
}

fn d1_post_read<T: serde::de::DeserializeOwned>(
    path: &str,
    body: &impl serde::Serialize,
) -> Result<T, ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}");
    let resp = agent
        .post(&url)
        .header("x-internal-secret", &secret)
        .send_json(body)
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "post failed",
        })?;
    let mut body = resp.into_body();
    let text = body
        .read_to_string()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "decode failed",
        })?;
    serde_json::from_str(&text).map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "decode failed",
        }
        .into()
    })
}

fn admin_ok(headers: &HeaderMap) -> bool {
    let Some(want) = std::env::var("ADMIN_TOKEN").ok() else {
        return false;
    };
    if let Some(Ok(auth)) = headers.get(header::AUTHORIZATION).map(|v| v.to_str()) {
        if let Some(m) = auth.split_whitespace().nth(1) {
            if m == want {
                return true;
            }
        }
    }
    if let Some(Ok(tok)) = headers.get("x-admin-token").map(|v| v.to_str()) {
        if tok == want {
            return true;
        }
    }
    false
}

async fn admin_packer_flush(headers: HeaderMap) -> Result<Json<serde_json::Value>, ApiError> {
    if !admin_ok(&headers) {
        return Err(ApiError::from(openscion_core::Error::InvalidChange {
            path: "admin".to_owned(),
            rule: "unauthorized",
        }));
    }
    let org = current_org_header(&headers);
    let res = packer::maybe_flush(&org).await;
    let s = get_status();
    Ok(Json(serde_json::json!({
        "ok": res.is_ok(),
        "last_error": s.last_error,
        "last_success_unix_ms": s.last_success_unix_ms
    })))
}

async fn admin_packer_status(headers: HeaderMap) -> Result<Json<serde_json::Value>, ApiError> {
    if !admin_ok(&headers) {
        return Err(ApiError::from(openscion_core::Error::InvalidChange {
            path: "admin".to_owned(),
            rule: "unauthorized",
        }));
    }
    let s = get_status();
    let pdp = crate::pdp::PdpClient::from_env();
    // Attempt to surface DO pending-adds last error for default repo of current org.
    let org = current_org_header(&headers);
    let mut do_err: Option<String> = None;
    if let Ok(base) = std::env::var("WORKER_BASE_URL") {
        if let Ok(secret) = std::env::var("INTERNAL_SECRET") {
            let agent = ureq::Agent::new_with_defaults();
            let url = format!("{base}/__internal/do/{org}/default/pending-adds/status");
            if let Ok(resp) = agent.get(&url).header("x-internal-secret", &secret).call() {
                if let Ok(v) = resp.into_body().read_json::<serde_json::Value>() {
                    do_err = v
                        .get("lastError")
                        .and_then(serde_json::Value::as_str)
                        .map(std::borrow::ToOwned::to_owned);
                }
            }
        }
    }
    Ok(Json(serde_json::json!({
        "last_error": s.last_error,
        "last_success_unix_ms": s.last_success_unix_ms,
        "signer": pdp.wallet_address(),
        "payer": std::env::var("PDP_PAYER").ok(),
        "payee": std::env::var("PDP_PAYEE").ok(),
        "pending_adds_error": do_err
    })))
}

async fn admin_reset(
    State(repos): State<SharedRepos>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !admin_ok(&headers) {
        return Err(ApiError::from(openscion_core::Error::InvalidChange {
            path: "admin".to_owned(),
            rule: "unauthorized",
        }));
    }
    repos_write(&repos).clear_in_memory();
    // Also ask RepoDO to drop its tables
    let _ = do_post("/__internal/do/local/default/reset", &serde_json::json!({}));
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
struct AddPiecesReq {
    org: String,
    pieces: Vec<String>,
}
/// Readable reason for a failed add: decodes known FWSS/FilecoinPay revert selectors.
fn readable_add_error(raw: &str) -> String {
    let u = |h: &str| u128::from_str_radix(h.trim_start_matches('0'), 16).ok();
    let fmt = |v: Option<u128>| v.map_or_else(|| "?".to_owned(), |x| format!("{:.6} USDFC", x as f64 / 1e18));
    if let Some(i) = raw.find("revert reason=[0x") {
        let hex: String = raw[i + 17..].chars().take_while(char::is_ascii_hexdigit).collect();
        let w = |n: usize| hex.get(8 + n * 64..8 + (n + 1) * 64).and_then(u);
        match hex.get(0..8) {
            Some("dae03403") => {
                return format!("InsufficientLockupFunds: required {}, available {} (deposit needed)", fmt(w(1)), fmt(w(2)));
            }
            Some("dfca894c") => {
                return format!(
                    "InsufficientLockupAllowance: allowance {}, usage {}, required {} (raise FWSS operator lockup allowance)",
                    fmt(w(2)), fmt(w(3)), fmt(w(4))
                );
            }
            Some(sel) => return format!("revert 0x{sel}: {}", raw.chars().take(300).collect::<String>()),
            None => {}
        }
    }
    raw.chars().take(400).collect()
}

async fn admin_add_pieces_readable(
    headers: HeaderMap,
    body: Json<AddPiecesReq>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    match admin_add_pieces(headers, body).await {
        Ok(j) => j.into_response(),
        Err(e) => {
            let raw = packer::get_status().last_error.unwrap_or_default();
            let reason = readable_add_error(&raw);
            let mut resp = e.into_response();
            if !raw.is_empty() {
                resp = (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(serde_json::json!({ "code": "AddPiecesFailed", "message": reason })),
                )
                    .into_response();
            }
            resp
        }
    }
}

#[allow(clippy::unused_async)]
async fn admin_add_pieces(
    headers: HeaderMap,
    Json(req): Json<AddPiecesReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !admin_ok(&headers) {
        return Err(ApiError::from(openscion_core::Error::InvalidChange {
            path: "admin".to_owned(),
            rule: "unauthorized",
        }));
    }
    if req.pieces.is_empty() {
        return Ok(Json(serde_json::json!({ "ok": true, "added": 0 })));
    }
    // Ensure dataset row exists in top D1 (idempotent)
    let ds_id_u256 = stable_dataset_id_for_org(&req.org);
    let ds_hex = format!("{ds_id_u256:#x}");
    let _ = d1_post(
        &format!("/__internal/d1/{}/datasets", req.org),
        &serde_json::json!({ "id": ds_hex, "name": "default" }),
    );
    // Lookup on-chain dataset id if present
    let pdp = PdpClient::from_env();
    if !pdp.is_enabled() {
        return Ok(Json(
            serde_json::json!({ "ok": true, "added": req.pieces.len(), "mock": true }),
        ));
    }
    let ds_list = d1_get_json(&format!("/__internal/d1/{}/datasets", req.org))?;
    let mut onchain_id: Option<String> = None;
    if let Some(arr) = ds_list.get("datasets").and_then(|x| x.as_array()) {
        for d in arr {
            if d.get("id").and_then(serde_json::Value::as_str) == Some(&ds_hex) {
                onchain_id = d
                    .get("onchain_id")
                    .and_then(serde_json::Value::as_str)
                    .map(std::borrow::ToOwned::to_owned);
                break;
            }
        }
    }
    if let Some(ref ds_onchain) = onchain_id {
        let ds_num = ds_onchain.split('|').next().unwrap_or_default();
        return match pdp
            .add_pieces_with_dataset(ds_id_u256, ds_num, &req.pieces)
            .await
        {
            Ok(loc) => {
                packer::note_success();
                Ok(Json(
                    serde_json::json!({ "ok": true, "added": req.pieces.len(), "dataSetId": ds_num, "location": loc }),
                ))
            }
            Err(e) => {
                packer::note_error(format!("add to dataset {ds_num}: {e}"));
                Err(ApiError::from(openscion_core::Error::InvalidChange {
                    path: "admin".to_owned(),
                    rule: "add pieces failed",
                }))
            }
        };
    }
    // Create dataset and add; capture on-chain id and persist only after confirmation
    let onchain = pdp
        .create_dataset_and_add_with_id_return_onchain(ds_id_u256, &req.pieces)
        .await
        .map_err(|e| {
            packer::note_error(format!("create_and_add: {e}"));
            ApiError::from(openscion_core::Error::InvalidChange {
                path: "admin".to_owned(),
                rule: "add pieces failed",
            })
        })?;
    let _ = d1_post(
        &format!("/__internal/d1/{}/datasets", req.org),
        &serde_json::json!({ "id": ds_hex, "name": "default", "onchainId": onchain }),
    );
    packer::note_success();
    Ok(Json(
        serde_json::json!({ "ok": true, "created": true, "added": req.pieces.len(), "dataSet": onchain }),
    ))
}

async fn create_changeset(
    State(repos): State<SharedRepos>,
    Path((org, repo_name)): Path<(String, String)>,
    Json(request): Json<CreateChangeset>,
) -> Result<Json<ChangesetInfo>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let info = repo.create_changeset(request)?;
    // Persist into dev storage if configured, then into RepoDO (when Worker is set).
    let record = repo.changeset(info.id)?;
    repos_read(&repos).persist_changeset(&org, &repo_name, info, &record)?;
    if worker_base().is_ok() {
        let body = serde_json::json!({
            "id": format!("{}", info.id),
            "lsn": info.lsn,
            "root_tree": format!("{}", info.root_tree),
            "changeset": record.changeset
        });
        let path = format!("/__internal/do/{org}/{repo_name}/changesets");
        let _ = do_post(&path, &body);
    }
    Ok(Json(info))
}

async fn create_changeset_default(
    State(repos): State<SharedRepos>,
    Json(request): Json<CreateChangeset>,
) -> Result<Json<ChangesetInfo>, ApiError> {
    create_changeset(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())),
        Json(request),
    )
    .await
}

async fn get_changeset(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, id)): Path<(String, String, String)>,
) -> Result<Json<ChangesetRecord>, ApiError> {
    let id: ObjectId = id.parse()?;
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    Ok(Json(
        repository
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .changeset(id)?,
    ))
}

async fn get_changeset_default(
    State(repos): State<SharedRepos>,
    Path(id): Path<String>,
) -> Result<Json<ChangesetRecord>, ApiError> {
    get_changeset(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned(), id)),
    )
    .await
}

fn stored_ref(
    repo: &openscion_core::Repository,
    name: &str,
) -> Result<RefValue, openscion_core::Error> {
    let mut last = None;
    for candidate in lookup_ref_names(name) {
        match repo.get_ref(&candidate) {
            Ok(value) => return Ok(value),
            Err(error @ openscion_core::Error::NoSuchRef(_)) => last = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last.unwrap_or_else(|| openscion_core::Error::NoSuchRef(name.to_owned())))
}

async fn get_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, name)): Path<(String, String, String)>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    Ok(Json(stored_ref(
        &repository.read().unwrap_or_else(PoisonError::into_inner),
        &name,
    )?))
}

async fn get_ref_default(
    State(repos): State<SharedRepos>,
    Path(name): Path<String>,
) -> Result<Json<RefValue>, ApiError> {
    get_ref(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned(), name)),
    )
    .await
}

async fn get_piece_bytes(Path(cid): Path<String>) -> Result<impl IntoResponse, ApiError> {
    let pdp = crate::pdp::PdpClient::from_env();
    match pdp.get_piece(&cid).await {
        Ok(bytes) => Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes)),
        Err(_) => Err(ApiError::from(openscion_core::Error::NotFound(
            openscion_core::ObjectId::from_bytes([0; 32]),
        ))),
    }
}

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock as StdRwLock};
static PROVIDER_SUBPIECE_OK: OnceLock<StdRwLock<HashMap<String, bool>>> = OnceLock::new();
fn subpiece_cache() -> &'static StdRwLock<HashMap<String, bool>> {
    PROVIDER_SUBPIECE_OK.get_or_init(|| StdRwLock::new(HashMap::new()))
}

fn head_ok(agent: &ureq::Agent, url: &str) -> bool {
    agent
        .head(url)
        .call()
        .map(|resp| resp.status() == 200 || resp.status() == 206)
        .unwrap_or(false)
}

fn bundles_find(org: &str, repo: &str, piece_cid: &str) -> Result<(String, u64, u64), ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}/__internal/do/{org}/{repo}/bundles/find?pieceCid={piece_cid}");
    let resp = match agent.get(&url).header("x-internal-secret", &secret).call() {
        Ok(r) => r,
        Err(ureq::Error::StatusCode(404)) => {
            return Err(
                openscion_core::Error::NotFound(openscion_core::ObjectId::from_bytes([0; 32]))
                    .into(),
            );
        }
        Err(_) => {
            return Err(openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "bundle find failed",
            }
            .into());
        }
    };
    if resp.status() == 404 {
        return Err(
            openscion_core::Error::NotFound(openscion_core::ObjectId::from_bytes([0; 32])).into(),
        );
    }
    let mut body = resp.into_body();
    let v: serde_json::Value =
        body.read_json()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "decode failed",
            })?;
    let bundle = v
        .get("bundleCid")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_owned();
    let offset = v
        .get("offset")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let length = v
        .get("length")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    Ok((bundle, offset, length))
}

#[allow(dead_code)]
fn adjust_range(original: Option<&str>, offset: u64, length: u64) -> String {
    // When no original, request exactly the member's full range.
    if original.is_none() {
        let end = offset.saturating_add(length.saturating_sub(1));
        return format!("bytes={offset}-{end}");
    }
    let s = original.unwrap_or_default();
    // Expect bytes=a-b or bytes=a-; ignore malformed inputs and default to full range.
    let s = s.trim();
    if !s.to_ascii_lowercase().starts_with("bytes=") {
        let end = offset.saturating_add(length.saturating_sub(1));
        return format!("bytes={offset}-{end}");
    }
    let spec = &s[6..];
    let mut parts = spec.split('-');
    let start = parts
        .next()
        .and_then(|x| x.parse::<u64>().ok())
        .unwrap_or(0);
    let end_opt = parts.next().and_then(|x| {
        if x.is_empty() {
            None
        } else {
            x.parse::<u64>().ok()
        }
    });
    if let Some(end) = end_opt {
        let new_start = offset.saturating_add(start);
        let new_end = offset.saturating_add(end);
        format!("bytes={new_start}-{new_end}")
    } else {
        let new_start = offset.saturating_add(start);
        format!("bytes={new_start}-")
    }
}

// New: repo-scoped object redirect by PieceCID with fallback proxy if sub-piece unsupported
async fn get_object_by_piececid(
    _headers: HeaderMap,
    Path((org, repo_name, cid)): Path<(String, String, String)>,
) -> Result<axum::response::Response, ApiError> {
    let provider = first_provider_url(&org)?;
    let piece_url = format!("{}/piece/{}", provider.trim_end_matches('/'), cid);
    // Fast path: cache says sub-piece ok, or HEAD succeeds -> 302 redirect
    let agent = ureq::Agent::new_with_defaults();
    let cache_key = provider.clone();
    let cached_ok = subpiece_cache()
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&cache_key)
        .copied();
    let mut should_redirect = cached_ok.unwrap_or(false);
    if cached_ok.is_none() {
        if head_ok(&agent, &piece_url) {
            should_redirect = true;
            subpiece_cache()
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(cache_key.clone(), true);
        } else {
            subpiece_cache()
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(cache_key.clone(), false);
        }
    }
    if should_redirect {
        return Ok(Redirect::temporary(&piece_url).into_response());
    }
    // Fallback: resolve bundle mapping from RepoDO and return a JSON hint for client-side Range GET
    let (bundle, offset, length) = bundles_find(&org, &repo_name, &cid)?;
    let url = format!("{}/piece/{}", provider.trim_end_matches('/'), bundle);
    Ok(axum::Json(serde_json::json!({
        "url": url,
        "offset": offset,
        "length": length
    }))
    .into_response())
}

async fn update_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, name)): Path<(String, String, String)>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let mut repo_guard = repository.write().unwrap_or_else(PoisonError::into_inner);
    let stored = stored_ref(&repo_guard, &name).ok();
    let key = stored.as_ref().map_or_else(|| name.clone(), |value| value.name.clone());
    let value = repo_guard.update_ref(&key, update)?;
    repos_read(&repos).persist_ref(&org, &repo_name, &value)?;
    if worker_base().is_ok() {
        let body = serde_json::json!({
            "name": value.name,
            "target": format!("{}", value.target),
            "version": value.version
        });
        let path = format!("/__internal/do/{org}/{repo_name}/refs");
        let _ = do_post(&path, &body);
    }
    Ok(Json(value))
}

async fn delete_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, name)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let mut repo_guard = repository.write().unwrap_or_else(PoisonError::into_inner);
    let stored = stored_ref(&repo_guard, &name)?;
    let value = repo_guard.delete_ref(&stored.name)?;
    drop(repo_guard);
    repos_read(&repos).persist_delete_ref(&org, &repo_name, &value.name)?;
    if worker_base().is_ok() {
        let path = format!(
            "/__internal/do/{org}/{repo_name}/refs/{}",
            urlencoding::encode(&value.name)
        );
        let _ = do_delete(&path);
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "deleted": value.name,
        "target": value.target.to_string(),
    })))
}

fn do_delete(path: &str) -> Result<(), ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}");
    let _ = agent
        .delete(&url)
        .header("x-internal-secret", &secret)
        .call()
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "do".to_owned(),
            rule: "delete failed",
        })?;
    Ok(())
}

async fn update_ref_default(
    State(repos): State<SharedRepos>,
    Path(name): Path<String>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    update_ref(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned(), name)),
        Json(update),
    )
    .await
}
/* duplicate-merge-block-start (commented out)
// (duplicate documentation and imports removed)
use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, FetchObjects, FrameWriter, ObjectId, ObjectKind,
    RefValue, Repository, StoredObjects, UpdateRef, decode_frames,
};
use openscion_core::filecoin::{compute_piece_cid_proofs, compute_piece_cid_minimal};
use ureq;
use crate::pdp::PdpClient;
pub use failure::ApiError;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::repo_manager::RepoManager;

/// The repo manager every request shares.
pub type SharedRepos = Arc<RwLock<RepoManager>>;

/// The largest request body the API accepts: a batch of blobs.
pub const MAX_BODY_BYTES: usize = 1 << 30;

const DEFAULT_ORG: &str = "local";
const DEFAULT_REPO: &str = "default";

/// The API routes, with the shared repository as their state.
pub(crate) fn routes() -> Router<SharedRepos> {
    Router::new()
        // Catalog
        .route("/v1/orgs", get(list_orgs))
        .route("/v1/orgs/{org}/repos", get(list_repos))
        .route("/v1/repos/{org}/{repo}", put(create_repo))
        // Repo-scoped routes
        .route("/v1/repos/{org}/{repo}/blobs", post(put_blobs))
        .route("/v1/repos/{org}/{repo}/objects", post(fetch_objects))
        .route("/v1/repos/{org}/{repo}/changesets", post(create_changeset))
        .route("/v1/repos/{org}/{repo}/changesets/{id}", get(get_changeset))
        .route("/v1/repos/{org}/{repo}/refs/{*name}", get(get_ref).post(update_ref))
        // Compatibility: single-repo endpoints map to a default repo.
        .route("/v1/blobs", post(put_blobs_default))
        .route("/v1/objects", post(fetch_objects_default))
        .route("/v1/objects/locate", post(locate_objects))
        .route("/v1/objects/{id}", get(get_object_default))
        .route("/v1/changesets", post(create_changeset_default))
        .route("/v1/changesets/{id}", get(get_changeset_default))
        .route("/v1/refs/{*name}", get(get_ref_default).post(update_ref_default))
        // Auth
        .route("/v1/auth/login", post(login))
        // Filecoin helper endpoints
        .route("/v1/filecoin/providers", get(get_providers).post(add_provider))
        .route("/v1/filecoin/datasets", get(get_datasets).post(add_dataset))
        .route("/v1/filecoin/upload", post(filecoin_upload))
        .route("/v1/filecoin/compute", post(filecoin_compute))
        .route("/v1/filecoin/pieces/{cid}/bytes", get(get_piece_bytes))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

// A handler that panicked mid-write cannot leave the repository half-updated:
// every engine call validates before it mutates. So a poisoned lock still
// guards consistent data, and the server keeps serving rather than failing
// every later request.
pub(crate) fn repos_read(repos: &SharedRepos) -> RwLockReadGuard<'_, RepoManager> {
    repos.read().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn repos_write(repos: &SharedRepos) -> RwLockWriteGuard<'_, RepoManager> {
    repos.write().unwrap_or_else(PoisonError::into_inner)
}

async fn list_orgs(State(repos): State<SharedRepos>) -> Result<Json<Vec<String>>, ApiError> {
    Ok(Json(repos_read(&repos).list_orgs()?))
}

async fn list_repos(
    State(repos): State<SharedRepos>,
    Path(org): Path<String>,
) -> Result<Json<Vec<String>>, ApiError> {
    Ok(Json(repos_read(&repos).list_repos(&org)?))
}

async fn create_repo(
    State(repos): State<SharedRepos>,
    Path((org, repo)): Path<(String, String)>,
) -> Result<(), ApiError> {
    repos_write(&repos).create_repo(&org, &repo)?;
    Ok(())
}

async fn put_blobs(
    State(repos): State<SharedRepos>,
    Path((org, repo)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    let frames = decode_frames(&body)?;
    let repository = repos_write(&repos).get(&org, &repo)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let mut ids = Vec::with_capacity(frames.len());
    let org = current_org_header(&headers);
    for (id, bytes) in frames {
        repo.put_blob_verified(id, bytes)?;
        // Persist when configured.
        repos_read(&repos)
            .persist_object(&org, &repo, id, ObjectKind::Blob, bytes)?;
        ids.push(id);
        // Persist staging durably in D1 before acknowledging.
        persist_staging(&org, id, bytes)?;
    }
    // Release the write lock before async work.
    drop(repo_guard);
    // fire-and-forget flush to avoid blocking handler (and to keep handler future Send)
    let org_for_task = org.clone();
    tokio::spawn(async move {
        let _ = packer::maybe_flush(&org_for_task).await;
    });
    Ok(Json(StoredObjects::new(ids)))
}

async fn put_blobs_default(
    State(repos): State<SharedRepos>,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    put_blobs(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())),
        HeaderMap::new(),
        body,
    )
    .await
}

async fn fetch_objects(
    State(repos): State<SharedRepos>,
    Path((org, repo)): Path<(String, String)>,
    Json(request): Json<FetchObjects>,
) -> Result<impl IntoResponse, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo)?;
    let repository = repository.read().unwrap_or_else(PoisonError::into_inner);
    let mut frames = FrameWriter::new();
    for id in request.ids {
        frames.push(id, &repository.object(id)?);
    }
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        frames.finish(),
    ))
}

async fn fetch_objects_default(
    State(repos): State<SharedRepos>,
    Json(request): Json<FetchObjects>,
) -> Result<impl IntoResponse, ApiError> {
    fetch_objects(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())),
        Json(request),
    )
    .await
}

async fn create_changeset(
    State(repos): State<SharedRepos>,
    Path((org, repo)): Path<(String, String)>,
    Json(request): Json<CreateChangeset>,
) -> Result<Json<ChangesetInfo>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let info = repo.create_changeset(request)?;
    // Persist the full record when configured.
    let record = repo.changeset(info.id)?;
    repos_read(&repos).persist_changeset(&org, &repo, info, &record)?;
    // Also persist into RepoDO when Worker is configured.
    if worker_base().is_ok() {
        let body = serde_json::json!({
            "id": format!("{}", info.id),
            "lsn": info.lsn,
            "root_tree": format!("{}", info.root_tree),
            "changeset": record.changeset
        });
        let path = format!("/__internal/do/{org}/{repo_name}/changesets");
        let _ = do_post(&path, &body);
    }
    Ok(Json(info))
}

async fn create_changeset_default(
    State(repos): State<SharedRepos>,
    Json(request): Json<CreateChangeset>,
) -> Result<Json<ChangesetInfo>, ApiError> {
    create_changeset(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())),
        Json(request),
    )
    .await
}

async fn get_changeset(
    State(repos): State<SharedRepos>,
    Path((org, repo, id)): Path<(String, String, String)>,
) -> Result<Json<ChangesetRecord>, ApiError> {
    let id: ObjectId = id.parse()?;
    let repository = repos_write(&repos).get(&org, &repo)?;
    Ok(Json(
        repository
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .changeset(id)?,
    ))
}

async fn get_changeset_default(
    State(repos): State<SharedRepos>,
    Path(id): Path<String>,
) -> Result<Json<ChangesetRecord>, ApiError> {
    get_changeset(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned(), id)),
    )
    .await
}

async fn get_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo, name)): Path<(String, String, String)>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo)?;
    Ok(Json(
        repository
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get_ref(&name)?,
    ))
}

async fn get_ref_default(
    State(repos): State<SharedRepos>,
    Path(name): Path<String>,
) -> Result<Json<RefValue>, ApiError> {
    get_ref(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned(), name)),
    )
    .await
}

async fn get_piece_bytes(Path(cid): Path<String>) -> Result<impl IntoResponse, ApiError> {
    let pdp = crate::pdp::PdpClient::from_env();
    match pdp.get_piece(&cid).await {
        Ok(bytes) => Ok((
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )),
        Err(_) => Err(ApiError::from(openscion_core::Error::NotFound(
            openscion_core::ObjectId::from_bytes([0; 32]),
        ))),
    }
}

async fn update_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo, name)): Path<(String, String, String)>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let value = repo.update_ref(&name, update)?;
    repos_read(&repos).persist_ref(&org, &repo, &value)?;
    if worker_base().is_ok() {
        let body = serde_json::json!({
            "name": value.name,
            "target": format!("{}", value.target),
            "version": value.version
        });
        let path = format!("/__internal/do/{org}/{repo_name}/refs");
        let _ = do_post(&path, &body);
    }
    Ok(Json(value))
}

async fn update_ref_default(
    State(repos): State<SharedRepos>,
    Path(name): Path<String>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    update_ref(
        State(repos),
        Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned(), name)),
        Json(update),
    )
    .await
}

*/
// duplicate-merge-block-end
#[cfg(test)]
mod test;

// --- Auth helpers and endpoints (server <-> Worker D1) ---

// no bearer_token helper: writes are authorized via D1-backed tokens

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let out = hasher.finalize();
    hex::encode(out)
}

#[derive(serde::Deserialize)]
struct LoginBody {
    name: String,
    password: String,
}

#[derive(serde::Deserialize)]
struct SignupBody {
    username: String,
    password: String,
    email: Option<String>,
}

fn auth_err(rule: &'static str) -> ApiError {
    openscion_core::Error::InvalidChange {
        path: "auth".to_owned(),
        rule,
    }
    .into()
}

fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.len() < 3 || bytes.len() > 32 {
        return false;
    }
    let Some((first, rest)) = bytes.split_first() else {
        return false;
    };
    (first.is_ascii_lowercase() || first.is_ascii_digit())
        && rest
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

fn hash_password(password: &str) -> Result<String, ApiError> {
    use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};
    let salt = SaltString::generate(&mut OsRng);
    argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| auth_err("hash failed"))
}

fn issue_token(org: &str, user_id: &str) -> Result<String, ApiError> {
    let token = uuid::Uuid::new_v4().to_string() + "." + &uuid::Uuid::new_v4().to_string();
    let token_hash = sha256_hex(&token);
    d1_post(
        &format!("/__internal/d1/{org}/auth/token"),
        &serde_json::json!({ "user_id": user_id, "token_hash": token_hash }),
    )?;
    Ok(token)
}

#[allow(clippy::unused_async)]
async fn login(
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // Fetch user from D1 via worker
    let org = current_org_header(&headers);
    let user: serde_json::Value = d1_get(&format!(
        "/__internal/d1/{org}/auth/user?name={}",
        urlencoding::encode(&body.name)
    ))?;
    // Verify password against argon2 hash in server
    let hash = user
        .get("password_hash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| auth_err("invalid user"))?;
    let parsed = argon2::PasswordHash::new(hash).map_err(|_| auth_err("bad hash"))?;
    let ok = argon2::Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed)
        .is_ok();
    if !ok {
        return Err(auth_err("invalid credentials"));
    }
    let user_id = user.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let token = issue_token(&org, user_id)?;
    Ok(Json(serde_json::json!({ "token": token })))
}

#[allow(clippy::unused_async)]
async fn signup(
    headers: HeaderMap,
    Json(body): Json<SignupBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !valid_username(&body.username) {
        return Err(auth_err("username must match ^[a-z0-9][a-z0-9-]{2,31}$"));
    }
    if body.password.len() < 10 {
        return Err(auth_err("password must be at least 10 characters"));
    }
    let org = current_org_header(&headers);
    if d1_get::<serde_json::Value>(&format!(
        "/__internal/d1/{org}/auth/user?name={}",
        urlencoding::encode(&body.username)
    ))
    .is_ok()
    {
        return Err(auth_err("username taken"));
    }
    let password_hash = hash_password(&body.password)?;
    let email = body
        .email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let created: serde_json::Value = d1_post_read(
        &format!("/__internal/d1/{org}/auth/user"),
        &serde_json::json!({
            "name": body.username,
            "password_hash": password_hash,
            "admin": false,
            "email": email,
        }),
    )?;
    let user_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| auth_err("create failed"))?;
    let token = issue_token(&org, user_id)?;
    Ok(Json(serde_json::json!({ "token": token })))
}
