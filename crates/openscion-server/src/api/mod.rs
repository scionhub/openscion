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

use std::sync::{Arc, OnceLock, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, FetchObjects, FrameWriter, ObjectId, RefValue,
    Repository, StoredObjects, UpdateRef, decode_frames,
};
use openscion_core::filecoin::{compute_piece_cid_proofs, compute_piece_cid_minimal};

pub use failure::ApiError;

/// The repository every request shares.
pub type SharedRepository = Arc<RwLock<Repository>>;

/// The largest request body the API accepts: a batch of blobs.
pub const MAX_BODY_BYTES: usize = 1 << 30;

/// The API routes, with the shared repository as their state.
pub(crate) fn routes() -> Router<SharedRepository> {
    Router::new()
        .route("/v1/blobs", post(put_blobs))
        .route("/v1/objects", post(fetch_objects))
        .route("/v1/changesets", post(create_changeset))
        .route("/v1/changesets/{id}", get(get_changeset))
        .route("/v1/filecoin/providers", get(get_providers).post(add_provider))
        .route("/v1/filecoin/datasets", get(get_datasets).post(add_dataset))
        .route("/v1/filecoin/upload", post(filecoin_upload))
        .route("/v1/filecoin/compute", post(filecoin_compute))
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
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    let frames = decode_frames(&body)?;
    let mut repository = write(&repository);
    let mut ids = Vec::with_capacity(frames.len());
    for (id, bytes) in frames {
        repository.put_blob_verified(id, bytes)?;
        ids.push(id);
    }
    Ok(Json(StoredObjects::new(ids)))
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

async fn filecoin_compute(body: Bytes) -> Result<Json<serde_json::Value>, ApiError> {
    let cid = compute_piece_cid_proofs(&body)
        .or_else(|_| compute_piece_cid_minimal(&body))
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "compute failed",
        })?;
    Ok(Json(serde_json::json!({ "piece_cid": cid.to_string() })))
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

async fn get_providers() -> Result<Json<Vec<Provider>>, ApiError> {
    let list = PROVIDERS.get_or_init(|| RwLock::new(Vec::new())).read().unwrap().clone();
    Ok(Json(list))
}

async fn add_provider(Json(p): Json<Provider>) -> Result<Json<Provider>, ApiError> {
    let mut list = PROVIDERS.get_or_init(|| RwLock::new(Vec::new())).write().unwrap();
    if let Some(existing) = list.iter_mut().find(|x| x.id == p.id) {
        *existing = p.clone();
    } else {
        list.push(p.clone());
    }
    Ok(Json(p))
}

async fn get_datasets() -> Result<Json<Vec<Dataset>>, ApiError> {
    let list = DATASETS.get_or_init(|| RwLock::new(Vec::new())).read().unwrap().clone();
    Ok(Json(list))
}

async fn add_dataset(Json(d): Json<Dataset>) -> Result<Json<Dataset>, ApiError> {
    let mut list = DATASETS.get_or_init(|| RwLock::new(Vec::new())).write().unwrap();
    if let Some(existing) = list.iter_mut().find(|x| x.id == d.id) {
        *existing = d.clone();
    } else {
        list.push(d.clone());
    }
    Ok(Json(d))
}

async fn filecoin_upload(body: Bytes) -> Result<Json<serde_json::Value>, ApiError> {
    let cid = compute_piece_cid_proofs(&body)
        .or_else(|_| compute_piece_cid_minimal(&body))
        .map_err(|_| openscion_core::Error::InvalidChange {
            path: "filecoin".to_owned(),
            rule: "compute failed",
        })?;
    Ok(Json(serde_json::json!({
        "piece_cid": cid.to_string(),
        "state": "queued",
        "note": "PDP upload not configured; add PDP_* secrets to enable real storage"
    })))
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

async fn update_ref(
    State(repository): State<SharedRepository>,
    Path(name): Path<String>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    Ok(Json(write(&repository).update_ref(&name, update)?))
}

#[cfg(test)]
mod test;
