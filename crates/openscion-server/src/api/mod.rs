//! The OpenScion API routes: objects, changesets, and refs over the engine.
//!
//! Each handler takes the shared [`Repository`], makes one engine call, and
//! translates the result to HTTP. JSON carries every payload except object
//! bytes, which travel as a frame stream (`id ‖ u64 length ‖ bytes`, see
//! `openscion_core::FrameWriter`) so a batch of thousands of files is one
//! request with no base64 overhead.
//!
//! | Method | Path | Request | Response |
//! | --- | --- | --- | --- |
//! | `POST` | `/v1/blobs` | blob frames | `StoredObjects` |
//! | `POST` | `/v1/objects` | `FetchObjects` | object frames, in request order |
//! | `POST` | `/v1/changesets` | `CreateChangeset` | `ChangesetInfo` |
//! | `GET` | `/v1/changesets/{id}` | — | `ChangesetRecord` |
//! | `GET` | `/v1/refs/{name}` | — | `RefValue` |
//! | `POST` | `/v1/refs/{name}` | `UpdateRef` | `RefValue`, or `409` on conflict |
//!
//! Failures answer with an `ErrorBody`; see [`ApiError`] for the status codes.

mod failure;
mod packer;

use std::sync::{Arc, OnceLock, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Redirect};
use axum::routing::{get, post};
use axum::{Json, Router};
use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, FetchObjects, FrameWriter, ObjectId, RefValue,
    Repository, StoredObjects, UpdateRef, decode_frames,
};
use openscion_core::filecoin::{compute_piece_cid_proofs, compute_piece_cid_minimal};
use ureq;
use crate::pdp::PdpClient;
pub use failure::ApiError;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

/// The repository every request shares.
pub type SharedRepository = Arc<RwLock<Repository>>;

/// The largest request body the API accepts: a batch of blobs.
pub const MAX_BODY_BYTES: usize = 1 << 30;

/// The API routes, with the shared repository as their state.
pub(crate) fn routes() -> Router<SharedRepository> {
    Router::new()
        .route("/v1/blobs", post(put_blobs))
        .route("/v1/objects", post(fetch_objects))
        .route("/v1/objects/locate", post(locate_objects))
        .route("/v1/objects/{id}", get(get_object))
        .route("/v1/changesets", post(create_changeset))
        .route("/v1/changesets/{id}", get(get_changeset))
        .route("/v1/filecoin/providers", get(get_providers).post(add_provider))
        .route("/v1/filecoin/datasets", get(get_datasets).post(add_dataset))
        .route("/v1/filecoin/upload", post(filecoin_upload))
        .route("/v1/filecoin/compute", post(filecoin_compute))
        .route("/v1/filecoin/pieces/{cid}/bytes", get(get_piece_bytes))
        .route("/v1/refs/{*name}", get(get_ref).post(update_ref))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

// A handler that panicked mid-write cannot leave the repository half-updated:
// every engine call validates before it mutates. So a poisoned lock still
// guards consistent data, and the server keeps serving rather than failing
// every later request.
fn read(repository: &SharedRepository) -> RwLockReadGuard<'_, Repository> {
    repository.read().unwrap_or_else(PoisonError::into_inner)
}

fn write(repository: &SharedRepository) -> RwLockWriteGuard<'_, Repository> {
    repository.write().unwrap_or_else(PoisonError::into_inner)
}

async fn put_blobs(
    State(repository): State<SharedRepository>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    let frames = decode_frames(&body)?;
    let mut repository = write(&repository);
    let mut ids = Vec::with_capacity(frames.len());
    let org = current_org_header(&headers);
    for (id, bytes) in frames {
        repository.put_blob_verified(id, bytes)?;
        ids.push(id);
        // Persist staging durably in D1 before acknowledging.
        persist_staging(&org, id, bytes)?;
    }
    // Try threshold-based flush after this batch
    drop(repository);
    // fire-and-forget flush to avoid blocking handler (and to keep handler future Send)
    let org_for_task = org.clone();
    tokio::spawn(async move {
        let _ = packer::maybe_flush(&org_for_task).await;
    });
    Ok(Json(StoredObjects::new(ids)))
}

fn persist_staging(org: &str, id: ObjectId, bytes: &[u8]) -> Result<(), ApiError> {
    // If Worker base/secret are not configured (local tests), skip durable staging (mock mode).
    let base = match worker_base() {
        Ok(b) => b,
        Err(_) => return Ok(()),
    };
    let secret = match internal_secret() {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    let agent = ureq::Agent::new_with_defaults();
    let chunk = 64 * 1024usize;
    let total = bytes.len();
    let mut index = 0usize;
    while index < total {
        let end = (index + chunk).min(total);
        let slice = &bytes[index..end];
        let body = serde_json::json!({
            "objectId": format!("{id}"),
            "chunkIndex": index / chunk,
            "totalLength": total,
            "bytesBase64": B64.encode(slice)
        });
        let url = format!("{base}/__internal/d1/{org}/staging/object?s={}", urlencoding::encode(&secret));
        let _ = agent
            .post(&url)
            .send_json(&body)
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "d1".to_owned(),
                rule: "staging failed",
            })?;
        index = end;
    }
    Ok(())
}

async fn fetch_objects(
    State(repository): State<SharedRepository>,
    Json(request): Json<FetchObjects>,
) -> Result<impl IntoResponse, ApiError> {
    let repository = read(&repository);
    let mut frames = FrameWriter::new();
    for id in request.ids {
        frames.push(id, &repository.object(id)?);
    }
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        frames.finish(),
    ))
}

async fn filecoin_compute(_headers: HeaderMap, body: Bytes) -> Result<Json<serde_json::Value>, ApiError> {
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
    objectId: String,
    pieceCid: String,
    offset: u64,
    length: u64,
    providerUrl: Option<String>,
    pieceSize: Option<u64>,
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

async fn get_object(
    State(repository): State<SharedRepository>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    // Try locate
    let org = current_org_header(&headers);
    let body = serde_json::json!({ "ids": [id.clone()] });
    let out: serde_json::Value = d1_post_read(&format!("/__internal/d1/{org}/locate"), &body)?;
    if let Some(arr) = out.get("locations").and_then(|v| v.as_array()) {
        if let Some(loc) = arr.first() {
            let provider = loc.get("providerUrl").and_then(|v| v.as_str()).unwrap_or("");
            let piece_cid = loc.get("pieceCid").and_then(|v| v.as_str()).unwrap_or("");
            let offset = loc.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let length = loc.get("length").and_then(|v| v.as_u64()).unwrap_or(0);
            let piece_size = loc.get("pieceSize").and_then(|v| v.as_u64()).unwrap_or(0);
            if offset == 0 && length > 0 && length == piece_size && !provider.is_empty() {
                let url = format!("{}/piece/{}", provider.trim_end_matches('/'), piece_cid);
                return Ok(Redirect::temporary(&url).into_response());
            }
            return Ok(axum::Json(loc.clone()).into_response());
        }
    }
    // Fallback: serve from repository staging (in-memory object store)
    let id_parsed: ObjectId = id.parse()?;
    let repo = read(&repository);
    let bytes = repo.object(id_parsed)?;
    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes.to_vec()).into_response())
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

static PROVIDERS: OnceLock<RwLock<Vec<Provider>>> = OnceLock::new();
static DATASETS: OnceLock<RwLock<Vec<Dataset>>> = OnceLock::new();

async fn get_providers(headers: HeaderMap) -> Result<Json<Vec<Provider>>, ApiError> {
    let org = current_org_header(&headers);
    let list = d1_get::<Vec<Provider>>(&format!("/__internal/d1/{org}/providers"))?;
    Ok(Json(list))
}

async fn add_provider(headers: HeaderMap, Json(p): Json<Provider>) -> Result<Json<Provider>, ApiError> {
    let org = current_org_header(&headers);
    d1_post(&format!("/__internal/d1/{org}/providers"), &p)?;
    Ok(Json(p))
}

async fn get_datasets(headers: HeaderMap) -> Result<Json<Vec<Dataset>>, ApiError> {
    let org = current_org_header(&headers);
    let list = d1_get::<Vec<Dataset>>(&format!("/__internal/d1/{org}/datasets"))?;
    Ok(Json(list))
}

async fn add_dataset(headers: HeaderMap, Json(d): Json<Dataset>) -> Result<Json<Dataset>, ApiError> {
    let org = current_org_header(&headers);
    d1_post(&format!("/__internal/d1/{org}/datasets"), &d)?;
    Ok(Json(d))
}

async fn filecoin_upload(headers: HeaderMap, body: Bytes) -> Result<Json<serde_json::Value>, ApiError> {
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
        return Ok(Json(serde_json::json!({ "piece_cid": cid.to_string(), "state": "queued" })));
    }
    let _ = pdp.create_and_add_pieces(&[cid.to_string()]).await;
    Ok(Json(serde_json::json!({
        "piece_cid": cid.to_string(),
        "state": "queued"
    })))
}

fn worker_base() -> Result<String, ApiError> {
    std::env::var("WORKER_BASE_URL").map_err(|_| openscion_core::Error::InvalidChange {
        path: "filecoin".to_owned(),
        rule: "missing WORKER_BASE_URL",
    }.into())
}

fn internal_secret() -> Result<String, ApiError> {
    std::env::var("INTERNAL_SECRET").map_err(|_| openscion_core::Error::InvalidChange {
        path: "filecoin".to_owned(),
        rule: "missing INTERNAL_SECRET",
    }.into())
}

fn current_org_header(headers: &HeaderMap) -> String {
    headers
        .get("x-org")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("filecoin-project")
        .to_owned()
}

fn d1_get<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}?s={}", urlencoding::encode(&secret));
    let mut resp = agent
        .get(&url)
        .call()
        .map_err(|_| openscion_core::Error::InvalidChange {
        path: "d1".to_owned(),
        rule: "get failed",
    })?;
    let mut body = resp.into_body();
    let text = body.read_to_string().map_err(|_| openscion_core::Error::InvalidChange {
        path: "d1".to_owned(),
        rule: "decode failed",
    })?;
    serde_json::from_str(&text).map_err(|_| openscion_core::Error::InvalidChange {
        path: "d1".to_owned(),
        rule: "decode failed",
    }.into())
}

fn d1_post(path: &str, body: &impl serde::Serialize) -> Result<(), ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}?s={}", urlencoding::encode(&secret));
    let _ = agent
        .post(&url)
        .send_json(body)
        .map_err(|e| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "post failed",
        })?;
    Ok(())
}

fn d1_post_read<T: serde::de::DeserializeOwned>(path: &str, body: &impl serde::Serialize) -> Result<T, ApiError> {
    let base = worker_base()?;
    let secret = internal_secret()?;
    let agent = ureq::Agent::new_with_defaults();
    let url = format!("{base}{path}?s={}", urlencoding::encode(&secret));
    let mut resp = agent
        .post(&url)
        .send_json(body)
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "d1".to_owned(),
            rule: "post failed",
        })?;
    let mut body = resp.into_body();
    let text = body.read_to_string().map_err(|_| openscion_core::Error::InvalidChange {
        path: "d1".to_owned(),
        rule: "decode failed",
    })?;
    serde_json::from_str(&text).map_err(|_| openscion_core::Error::InvalidChange {
        path: "d1".to_owned(),
        rule: "decode failed",
    }.into())
}

async fn create_changeset(
    State(repository): State<SharedRepository>,
    Json(request): Json<CreateChangeset>,
) -> Result<Json<ChangesetInfo>, ApiError> {
    Ok(Json(write(&repository).create_changeset(request)?))
}

async fn get_changeset(
    State(repository): State<SharedRepository>,
    Path(id): Path<String>,
) -> Result<Json<ChangesetRecord>, ApiError> {
    let id: ObjectId = id.parse()?;
    Ok(Json(read(&repository).changeset(id)?))
}

async fn get_ref(
    State(repository): State<SharedRepository>,
    Path(name): Path<String>,
) -> Result<Json<RefValue>, ApiError> {
    Ok(Json(read(&repository).get_ref(&name)?))
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
    State(repository): State<SharedRepository>,
    Path(name): Path<String>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    Ok(Json(write(&repository).update_ref(&name, update)?))
}

#[cfg(test)]
mod test;

// --- Auth helpers and endpoints (server <-> Worker D1) ---

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let parts: Vec<&str> = auth.split_whitespace().collect();
    if parts.len() == 2 && parts[0].eq_ignore_ascii_case("bearer") {
        Some(parts[1].to_owned())
    } else {
        None
    }
}

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

async fn login(headers: HeaderMap, Json(body): Json<LoginBody>) -> Result<Json<serde_json::Value>, ApiError> {
    // Fetch user from D1 via worker
    let org = current_org_header(&headers);
    let user: serde_json::Value =
        d1_get(&format!("/__internal/d1/{org}/auth/user?name={}", urlencoding::encode(&body.name)))?;
    // Verify password against argon2 hash in server
    let hash = user
        .get("password_hash")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            openscion_core::Error::InvalidChange {
                path: "auth".to_owned(),
                rule: "invalid user",
            }
        })?;
    let parsed = argon2::PasswordHash::new(hash).map_err(|_| {
        openscion_core::Error::InvalidChange {
            path: "auth".to_owned(),
            rule: "bad hash",
        }
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
    let _ = d1_post(
        &format!("/__internal/d1/{org}/auth/token"),
        &serde_json::json!({ "user_id": user_id, "token_hash": token_hash }),
    )?;
    Ok(Json(serde_json::json!({ "token": token })))
}
