//! The OpenScion API routes: objects, changesets, and refs over the engine.
//!
//! Multi-repo endpoints live under `/v1/repos/{org}/{repo}/...`. Legacy
//! single-repo endpoints remain available at `/v1/...` and map to
//! `local/default` for compatibility. Filecoin locate/redirect endpoints live
//! at `/v1/objects/locate` and `/v1/objects/{id}`.
//!
//! Failures answer with an `ErrorBody`; see [`ApiError`] for the status codes.

mod failure;
mod packer;

use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use argon2::PasswordVerifier;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use openscion_core::filecoin::{compute_piece_cid_minimal, compute_piece_cid_proofs};
use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, FetchObjects, FrameWriter, ObjectId,
    ObjectKind, RefValue, StoredObjects, UpdateRef, decode_frames,
};

use crate::api::packer::get_status;
use crate::pdp::PdpClient;
use crate::repo_manager::RepoManager;
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
        .route("/v1/repos/{org}/{repo}", put(create_repo))
        // Admin
        .route("/v1/admin/packer/status", get(admin_packer_status))
        .route("/v1/admin/packer/flush", post(admin_packer_flush))
        // Auth
        .route("/v1/auth/login", post(login))
        // Repo-scoped routes
        .route("/v1/repos/{org}/{repo}/blobs", post(put_blobs))
        .route("/v1/repos/{org}/{repo}/objects", post(fetch_objects))
        .route(
            "/v1/repos/{org}/{repo}/objects/missing",
            post(missing_objects),
        )
        .route("/v1/repos/{org}/{repo}/changesets", post(create_changeset))
        .route("/v1/repos/{org}/{repo}/changesets/{id}", get(get_changeset))
        .route(
            "/v1/repos/{org}/{repo}/refs/{*name}",
            get(get_ref).post(update_ref),
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
fn repos_read(repos: &SharedRepos) -> RwLockReadGuard<'_, RepoManager> {
    repos.read().unwrap_or_else(PoisonError::into_inner)
}

fn repos_write(repos: &SharedRepos) -> RwLockWriteGuard<'_, RepoManager> {
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
    Path((org, repo_name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    let frames = decode_frames(&body)?;
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let mut repo_guard = repository.write().unwrap_or_else(PoisonError::into_inner);
    let mut ids = Vec::with_capacity(frames.len());
    let org_hdr = current_org_header(&headers);
    // Persist into the in-memory repo and on-disk dev storage first
    // while building a multi-object staging batch to D1.
    let mut batch_items: Vec<(ObjectId, Vec<u8>)> = Vec::with_capacity(frames.len());
    for (id, bytes) in frames {
        repo_guard.put_blob_verified(id, bytes)?;
        repos_read(&repos).persist_object(&org, &repo_name, id, ObjectKind::Blob, bytes)?;
        ids.push(id);
        batch_items.push((id, bytes.to_vec()));
    }
    drop(repo_guard);
    // Persist staging durably in D1 (header secret) before acknowledging: batch across objects.
    persist_staging_multi(&org_hdr, &batch_items)?;
    let org_for_task = org_hdr.clone();
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

const STAGING_CHUNK_BYTES: usize = 1_048_576; // 1 MiB
const STAGING_MAX_CHUNKS_PER_BATCH: usize = 8; // ~8 MiB

// Cursor for multi-object staging batching.
#[derive(Clone)]
struct Cursor {
    id: ObjectId,
    total: usize,
    offset: usize,
    next_chunk_index: usize,
}

// Multi-object variant: batches several objects' chunks into one or more D1 requests.
fn persist_staging_multi(org: &str, items: &[(ObjectId, Vec<u8>)]) -> Result<(), ApiError> {
    // If Worker base/secret are not configured (local tests), skip durable staging (mock mode).
    let Ok(base) = worker_base() else {
        return Ok(());
    };
    let Ok(secret) = internal_secret() else {
        return Ok(());
    };
    let mut cursors: Vec<Cursor> = items
        .iter()
        .map(|(id, bytes)| Cursor {
            id: *id,
            total: bytes.len(),
            offset: 0,
            next_chunk_index: 0,
        })
        .collect();
    let agent = ureq::Agent::new_with_defaults();
    // Send pages of chunks until every object is fully staged.
    loop {
        // Build one page comprised of up to N chunks per object and a global cap.
        let mut page = Vec::<serde_json::Value>::new();
        let mut total_chunks = 0usize;
        for (idx, c) in cursors.iter_mut().enumerate() {
            if c.offset >= c.total {
                continue;
            }
            let (_, bytes) = &items[idx];
            let mut taken_for_object = 0usize;
            while c.offset < c.total
                && taken_for_object < STAGING_MAX_CHUNKS_PER_BATCH
                && total_chunks < STAGING_MAX_CHUNKS_PER_BATCH * 8
            {
                let end = (c.offset + STAGING_CHUNK_BYTES).min(c.total);
                let slice = &bytes[c.offset..end];
                page.push(serde_json::json!({
                    "objectId": format!("{}", c.id),
                    "totalLength": c.total,
                    "chunks": [{
                        "chunkIndex": c.next_chunk_index,
                        "bytesBase64": B64.encode(slice)
                    }]
                }));
                c.offset = end;
                c.next_chunk_index += 1;
                taken_for_object += 1;
                total_chunks += 1;
                if total_chunks >= STAGING_MAX_CHUNKS_PER_BATCH * 8 {
                    break;
                }
            }
        }
        if page.is_empty() {
            break;
        }
        let body = serde_json::json!({ "items": page });
        let url = format!("{base}/__internal/d1/{org}/staging/batch-multi");
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            match agent
                .post(&url)
                .header("x-internal-secret", &secret)
                .send_json(&body)
            {
                Ok(_) => break,
                Err(e) if attempt < 5 => {
                    eprintln!("[staging-batch-multi] attempt {attempt} failed: {e}");
                    std::thread::sleep(std::time::Duration::from_millis(250 * u64::from(attempt)));
                }
                Err(_) => {
                    return Err(openscion_core::Error::InvalidChange {
                        path: "d1".to_owned(),
                        rule: "staging multi failed",
                    }
                    .into());
                }
            }
        }
    }
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
    let body = serde_json::json!({ "ids": req.ids });
    let out: serde_json::Value = d1_post_read(&format!("/__internal/d1/{org}/locate"), &body)?;
    Ok(Json(out))
}

async fn get_object_default(
    State(repos): State<SharedRepos>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    // Try locate first
    let org = current_org_header(&headers);
    let body = serde_json::json!({ "ids": [id.clone()] });
    let out: serde_json::Value = d1_post_read(&format!("/__internal/d1/{org}/locate"), &body)?;
    if let Some(arr) = out.get("locations").and_then(|v| v.as_array()) {
        if let Some(loc) = arr.first() {
            let provider = loc
                .get("providerUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let piece_cid = loc.get("pieceCid").and_then(|v| v.as_str()).unwrap_or("");
            let offset = loc
                .get("offset")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let length = loc
                .get("length")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let piece_size = loc
                .get("pieceSize")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            if offset == 0 && length > 0 && length == piece_size && !provider.is_empty() {
                let url = format!("{}/piece/{}", provider.trim_end_matches('/'), piece_cid);
                return Ok(Redirect::temporary(&url).into_response());
            }
            return Ok(axum::Json(loc.clone()).into_response());
        }
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
    let list = d1_get::<Vec<Provider>>(&format!("/__internal/d1/{org}/providers"))?;
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

fn worker_base() -> Result<String, ApiError> {
    std::env::var("WORKER_BASE_URL").map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "missing WORKER_BASE_URL",
        }
        .into()
    })
}

fn internal_secret() -> Result<String, ApiError> {
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
    Ok(Json(serde_json::json!({
        "last_error": s.last_error,
        "last_success_unix_ms": s.last_success_unix_ms
    })))
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

async fn get_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, name)): Path<(String, String, String)>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
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
        Ok(bytes) => Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes)),
        Err(_) => Err(ApiError::from(openscion_core::Error::NotFound(
            openscion_core::ObjectId::from_bytes([0; 32]),
        ))),
    }
}

async fn update_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo_name, name)): Path<(String, String, String)>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo_name)?;
    let mut repo_guard = repository.write().unwrap_or_else(PoisonError::into_inner);
    let value = repo_guard.update_ref(&name, update)?;
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
fn repos_read(repos: &SharedRepos) -> RwLockReadGuard<'_, RepoManager> {
    repos.read().unwrap_or_else(PoisonError::into_inner)
}

fn repos_write(repos: &SharedRepos) -> RwLockWriteGuard<'_, RepoManager> {
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
        .ok_or_else(|| openscion_core::Error::InvalidChange {
            path: "auth".to_owned(),
            rule: "invalid user",
        })?;
    let parsed =
        argon2::PasswordHash::new(hash).map_err(|_| openscion_core::Error::InvalidChange {
            path: "auth".to_owned(),
            rule: "bad hash",
        })?;
    let ok = argon2::Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed)
        .is_ok();
    if !ok {
        return Err(ApiError::from(openscion_core::Error::InvalidChange {
            path: "auth".to_owned(),
            rule: "invalid credentials",
        }));
    }
    // Issue token (random), store hashed
    let token = uuid::Uuid::new_v4().to_string() + "." + &uuid::Uuid::new_v4().to_string();
    let token_hash = sha256_hex(&token);
    let user_id = user.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    d1_post(
        &format!("/__internal/d1/{org}/auth/token"),
        &serde_json::json!({ "user_id": user_id, "token_hash": token_hash }),
    )?;
    Ok(Json(serde_json::json!({ "token": token })))
}
