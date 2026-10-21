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

use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, FetchObjects, FrameWriter, ObjectId, ObjectKind,
    RefValue, Repository, StoredObjects, UpdateRef, decode_frames,
};

pub use failure::ApiError;

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
        .route(
            "/v1/repos/{org}/{repo}/changesets/{id}",
            get(get_changeset),
        )
        .route(
            "/v1/repos/{org}/{repo}/refs/{*name}",
            get(get_ref).post(update_ref),
        )
        // Compatibility: single-repo endpoints map to a default repo.
        .route("/v1/blobs", post(put_blobs_default))
        .route("/v1/objects", post(fetch_objects_default))
        .route("/v1/changesets", post(create_changeset_default))
        .route("/v1/changesets/{id}", get(get_changeset_default))
        .route("/v1/refs/{*name}", get(get_ref_default).post(update_ref_default))
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
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    let frames = decode_frames(&body)?;
    let repository = repos_write(&repos).get(&org, &repo)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let mut ids = Vec::with_capacity(frames.len());
    for (id, bytes) in frames {
        repo.put_blob_verified(id, bytes)?;
        // Persist when configured.
        repos_read(&repos)
            .persist_object(&org, &repo, id, ObjectKind::Blob, bytes)?;
        ids.push(id);
    }
    Ok(Json(StoredObjects::new(ids)))
}

async fn put_blobs_default(
    State(repos): State<SharedRepos>,
    body: Bytes,
) -> Result<Json<StoredObjects>, ApiError> {
    put_blobs(State(repos), Path((DEFAULT_ORG.to_owned(), DEFAULT_REPO.to_owned())), body).await
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

async fn update_ref(
    State(repos): State<SharedRepos>,
    Path((org, repo, name)): Path<(String, String, String)>,
    Json(update): Json<UpdateRef>,
) -> Result<Json<RefValue>, ApiError> {
    let repository = repos_write(&repos).get(&org, &repo)?;
    let mut repo = repository.write().unwrap_or_else(PoisonError::into_inner);
    let value = repo.update_ref(&name, update)?;
    repos_read(&repos).persist_ref(&org, &repo, &value)?;
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

#[cfg(test)]
mod test;
