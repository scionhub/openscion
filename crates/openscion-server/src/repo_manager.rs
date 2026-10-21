//! In-memory repositories with optional `SQLite` persistence and multi-repo catalog.
//!
//! The server exposes many repositories under `/v1/repos/{org}/{repo}/…`. Each
//! one is an in-memory `openscion_core::Repository` whose state is replayed
//! from `SQLite` on first use when a database path is configured.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, PoisonError, RwLock};

use openscion_core::{
    CatalogStorage, ChangesetInfo, ChangesetRecord, ObjectId, ObjectKind, RefValue, RepoStorage,
    Repository, Result, Storage,
};

use crate::storage::sqlite::SqliteStorage;

#[derive(serde::Deserialize)]
struct RepodoChangeRow {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    lsn: u64,
    #[allow(dead_code)]
    root_tree: String,
    changeset: serde_json::Value,
}
#[derive(serde::Deserialize)]
struct RepodoChangeWrap {
    changesets: Vec<RepodoChangeRow>,
}
#[derive(serde::Deserialize)]
struct RepodoRefRow {
    name: String,
    target: String,
    version: u64,
}
#[derive(serde::Deserialize)]
struct RepodoRefWrap {
    refs: Vec<RepodoRefRow>,
}

/// A loaded repository keyed by `(org, repo)`.
pub(crate) type SharedRepository = Arc<RwLock<Repository>>;

#[derive(Debug)]
/// Manages loaded repositories and optional persistence to `SQLite`.
pub struct RepoManager {
    storage: Option<SqliteStorage>,
    repos: HashMap<(String, String), SharedRepository>,
}

impl RepoManager {
    /// Creates a new manager. When `db_path` is set, `SQLite` persistence is enabled.
    ///
    /// # Errors
    ///
    /// Returns an error if the database cannot be opened.
    #[allow(clippy::needless_pass_by_value)]
    pub fn new(db_path: Option<PathBuf>) -> Result<Self> {
        let storage = match &db_path {
            Some(path) => Some(SqliteStorage::open(path)?),
            None => None,
        };
        Ok(Self {
            storage,
            repos: HashMap::new(),
        })
    }

    /// Lists organizations with at least one repo.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog backend query fails.
    pub fn list_orgs(&self) -> Result<Vec<String>> {
        if let Some(storage) = &self.storage {
            storage.list_orgs()
        } else {
            // In-memory only: list loaded orgs.
            let mut orgs: Vec<_> = self.repos.keys().map(|(org, _)| org.clone()).collect();
            orgs.sort();
            orgs.dedup();
            Ok(orgs)
        }
    }

    /// Lists repositories under `org`.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog backend query fails.
    pub fn list_repos(&self, org: &str) -> Result<Vec<String>> {
        if let Some(storage) = &self.storage {
            storage.list_repos(org)
        } else {
            let mut repos: Vec<_> = self
                .repos
                .keys()
                .filter(|(o, _)| o == org)
                .map(|(_, r)| r.clone())
                .collect();
            repos.sort();
            repos.dedup();
            Ok(repos)
        }
    }

    /// Creates `{org}/{repo}` in the catalog if not present.
    ///
    /// # Errors
    ///
    /// Returns an error when the catalog backend write fails.
    pub fn create_repo(&mut self, org: &str, repo: &str) -> Result<()> {
        if let Some(storage) = &self.storage {
            storage.create_repo(org, repo)?;
        }
        // Lazily loaded on first use; nothing to do in memory.
        Ok(())
    }

    /// Returns a shared repository for `{org}/{repo}`, creating and restoring
    /// it on first use. When no database is configured, a new empty repository
    /// is created on demand.
    ///
    /// # Errors
    ///
    /// Returns an error when persistence reads fail.
    pub fn get(&mut self, org: &str, repo: &str) -> Result<SharedRepository> {
        if let Some(existing) = self.repos.get(&(org.to_owned(), repo.to_owned())) {
            return Ok(existing.clone());
        }
        let repository = Arc::new(RwLock::new(Repository::new()));
        if let Some(storage) = &self.storage {
            let repo_store = storage.open_repo(org, repo, true)?;
            // Seed objects first so replay sees every referenced blob/tree.
            for (id, kind, bytes) in repo_store.load_objects()? {
                repository
                    .write()
                    .unwrap_or_else(PoisonError::into_inner)
                    .put_object_verified(kind, id, &bytes)?;
            }
            // Replay changesets in order.
            for ChangesetRecord {
                info: _, changeset, ..
            } in repo_store.load_changesets()?
            {
                let _ = repository
                    .write()
                    .unwrap_or_else(PoisonError::into_inner)
                    .append_existing_changeset(changeset)?;
            }
            // Restore refs last.
            for value in repo_store.load_refs()? {
                let _ = repository
                    .write()
                    .unwrap_or_else(PoisonError::into_inner)
                    .set_ref_direct(value)?;
            }
        } else {
            // No on-disk storage: attempt lazy restore from RepoDO via Worker.
            if let Err(e) = self.restore_from_repodo(org, repo, &repository) {
                eprintln!("[restore] {org}/{repo} failed: {e}");
                return Err(e);
            }
        }
        self.repos
            .insert((org.to_owned(), repo.to_owned()), repository.clone());
        Ok(repository)
    }

    /// Persists a stored blob or tree for a repo, if a database is configured.
    ///
    /// # Errors
    ///
    /// Returns an error when the storage write fails.
    pub fn persist_object(
        &self,
        org: &str,
        repo: &str,
        id: ObjectId,
        kind: ObjectKind,
        bytes: &[u8],
    ) -> Result<()> {
        if let Some(storage) = &self.storage {
            let repo_store = storage.open_repo(org, repo, true)?;
            repo_store.save_object(id, kind, bytes)?;
        }
        Ok(())
    }

    /// Persists a newly appended changeset for a repo.
    ///
    /// # Errors
    ///
    /// Returns an error when the storage write fails.
    pub fn persist_changeset(
        &self,
        org: &str,
        repo: &str,
        info: ChangesetInfo,
        record: &openscion_core::ChangesetRecord,
    ) -> Result<()> {
        if let Some(storage) = &self.storage {
            let repo_store = storage.open_repo(org, repo, true)?;
            repo_store.append_changeset(info, &record.changeset)?;
        }
        Ok(())
    }

    /// Persists a ref value for a repo.
    ///
    /// # Errors
    ///
    /// Returns an error when the storage write fails.
    pub fn persist_ref(&self, org: &str, repo: &str, value: &RefValue) -> Result<()> {
        if let Some(storage) = &self.storage {
            let repo_store = storage.open_repo(org, repo, true)?;
            repo_store.set_ref(value)?;
        }
        Ok(())
    }
}

impl RepoManager {
    fn worker_base() -> Option<String> {
        std::env::var("WORKER_BASE_URL").ok()
    }
    fn internal_secret() -> Option<String> {
        std::env::var("INTERNAL_SECRET").ok()
    }
    #[allow(clippy::unused_self, clippy::too_many_lines)]
    fn restore_from_repodo(
        &self,
        org: &str,
        repo: &str,
        repository: &SharedRepository,
    ) -> Result<()> {
        let Some(base) = Self::worker_base() else {
            return Ok(());
        };
        let Some(secret) = Self::internal_secret() else {
            return Ok(());
        };
        let agent = ureq::Agent::new_with_defaults();
        // Load changesets in order
        let url = format!("{base}/__internal/do/{org}/{repo}/changesets");
        let resp = agent
            .get(&url)
            .header("x-internal-secret", &secret)
            .call()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "changesets fetch failed",
            })?;
        let mut body = resp.into_body();
        let text = body
            .read_to_string()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "decode failed",
            })?;
        let wrap: RepodoChangeWrap =
            serde_json::from_str(&text).map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "decode failed",
            })?;
        let mut parsed = Vec::with_capacity(wrap.changesets.len());
        for r in wrap.changesets {
            let cs: openscion_core::Changeset =
                serde_json::from_value(r.changeset).map_err(|_| {
                    openscion_core::Error::InvalidChange {
                        path: "repodo".to_owned(),
                        rule: "bad changeset json",
                    }
                })?;
            parsed.push(cs);
        }
        // Hydrate every referenced blob (container memory is ephemeral), in parallel.
        let mut wanted: Vec<openscion_core::ObjectId> = Vec::new();
        {
            let guard = repository.read().unwrap_or_else(PoisonError::into_inner);
            for cs in &parsed {
                for change in &cs.changes {
                    if let openscion_core::Change::Upsert { blob, .. } = change {
                        if guard.object(*blob).is_err() {
                            wanted.push(*blob);
                        }
                    }
                }
            }
        }
        wanted.sort_unstable();
        wanted.dedup();
        let fetched = std::sync::Mutex::new(Vec::with_capacity(wanted.len()));
        let workers = 16usize;
        std::thread::scope(|scope| {
            for w in 0..workers {
                let (wanted, fetched, base, secret) = (&wanted, &fetched, &base, &secret);
                scope.spawn(move || {
                    let agent = ureq::Agent::new_with_defaults();
                    for id in wanted.iter().skip(w).step_by(workers) {
                        for _ in 0..4 {
                            if let Some(bytes) = fetch_durable_object(&agent, base, secret, org, *id) {
                                fetched.lock().unwrap_or_else(PoisonError::into_inner).push((*id, bytes));
                                break;
                            }
                        }
                    }
                });
            }
        });
        {
            let mut guard = repository.write().unwrap_or_else(PoisonError::into_inner);
            for (id, bytes) in fetched.into_inner().unwrap_or_else(PoisonError::into_inner) {
                if let Err(e) = guard.put_blob_verified(id, &bytes) {
                    eprintln!("[restore] blob {id} rejected: {e}");
                }
            }
        }
        for cs in parsed {
            let _ = repository
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .append_existing_changeset(cs)?;
        }
        // Load refs
        let url = format!("{base}/__internal/do/{org}/{repo}/refs");
        let resp = agent
            .get(&url)
            .header("x-internal-secret", &secret)
            .call()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "refs fetch failed",
            })?;
        let mut body = resp.into_body();
        let text = body
            .read_to_string()
            .map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "decode failed",
            })?;
        let wrap: RepodoRefWrap =
            serde_json::from_str(&text).map_err(|_| openscion_core::Error::InvalidChange {
                path: "repodo".to_owned(),
                rule: "decode failed",
            })?;
        for r in wrap.refs {
            let value = RefValue::new(
                &r.name,
                r.target
                    .parse()
                    .map_err(|_| openscion_core::Error::InvalidChange {
                        path: "repodo".to_owned(),
                        rule: "bad ref id",
                    })?,
                r.version,
            );
            let _ = repository
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .set_ref_direct(value)?;
        }
        Ok(())
    }
}

/// Reads an object's bytes from durable storage: D1 staging first, then the
/// PDP piece it was packed into (byte range of the piece on the SP).
fn fetch_durable_object(
    agent: &ureq::Agent,
    base: &str,
    secret: &str,
    org: &str,
    id: openscion_core::ObjectId,
) -> Option<Vec<u8>> {
    let url = format!("{base}/__internal/d1/{org}/staging/object/{id}");
    if let Ok(resp) = agent.get(&url).header("x-internal-secret", secret).call() {
        if let Ok(bytes) = resp.into_body().with_config().limit(1 << 30).read_to_vec() {
            if !bytes.is_empty() {
                return Some(bytes);
            }
        }
    }
    let url = format!("{base}/__internal/d1/{org}/locate");
    let out: serde_json::Value = agent
        .post(&url)
        .header("x-internal-secret", secret)
        .send_json(serde_json::json!({ "ids": [id.to_string()] }))
        .ok()?
        .into_body()
        .read_json()
        .ok()?;
    let loc = out.get("locations")?.as_array()?.first()?.clone();
    let provider = loc.get("providerUrl")?.as_str()?.trim_end_matches('/').to_owned();
    let cid = loc.get("pieceCid")?.as_str()?.to_owned();
    let offset = loc.get("offset")?.as_u64()?;
    let length = loc.get("length")?.as_u64()?;
    let resp = agent
        .get(&format!("{provider}/piece/{cid}"))
        .header("range", &format!("bytes={}-{}", offset, offset + length - 1))
        .call()
        .ok()?;
    let mut bytes = resp.into_body().with_config().limit(1 << 34).read_to_vec().ok()?;
    if bytes.len() as u64 > length {
        // Server ignored Range; slice locally.
        let start = usize::try_from(offset).ok()?;
        bytes = bytes.get(start..start + usize::try_from(length).ok()?)?.to_vec();
    }
    Some(bytes)
}
