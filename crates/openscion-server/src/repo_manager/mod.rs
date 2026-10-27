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

#[derive(Debug, serde::Deserialize)]
struct RepodoChangeRow {
    #[allow(dead_code)]
    id: String,
    #[allow(dead_code)]
    lsn: u64,
    #[allow(dead_code)]
    root_tree: String,
    changeset: serde_json::Value,
}

#[derive(Debug, Default, serde::Deserialize)]
struct RepodoRefRow {
    name: String,
    target: String,
    version: u64,
}

/// Snapshot the Worker loads from `RepoDO` and posts into a cold engine.
#[derive(Debug, Default, serde::Deserialize)]
pub(crate) struct HydrateBody {
    /// Changesets in LSN order. Missing or empty means a brand-new repo.
    #[serde(default)]
    changesets: Vec<RepodoChangeRow>,
    /// Refs to restore after the log.
    #[serde(default)]
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
    /// A missing or unreachable `RepoDO` snapshot is treated as an empty store so
    /// a cold `EngineContainer` can accept writes without a working HTTP hairpin
    /// back to the Worker.
    ///
    /// # Errors
    ///
    /// Returns an error when persistence reads fail, or when a loaded snapshot
    /// cannot be replayed.
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
        } else if let Err(e) = Self::restore_from_repodo(org, repo, &repository) {
            // Hairpin/decode failures must not block writes on an empty repo.
            eprintln!("[restore] {org}/{repo} unavailable ({e}); starting empty");
        }
        self.repos
            .insert((org.to_owned(), repo.to_owned()), repository.clone());
        Ok(repository)
    }

    /// Loads `{org}/{repo}` from a Worker-supplied `RepoDO` snapshot.
    ///
    /// Used when the `EngineContainer` can reach `RepoDO` via a Durable Object stub
    /// but the Rust process cannot hairpin HTTP to the Worker. Already-loaded
    /// repos are left unchanged.
    ///
    /// # Errors
    ///
    /// Returns an error when a changeset or ref in `body` cannot be replayed.
    pub(crate) fn hydrate(
        &mut self,
        org: &str,
        repo: &str,
        body: HydrateBody,
    ) -> Result<SharedRepository> {
        if let Some(existing) = self.repos.get(&(org.to_owned(), repo.to_owned())) {
            return Ok(existing.clone());
        }
        let repository = Arc::new(RwLock::new(Repository::new()));
        apply_snapshot(&repository, body)?;
        self.repos
            .insert((org.to_owned(), repo.to_owned()), repository.clone());
        Ok(repository)
    }

    /// Clears all in-memory repositories (forces lazy restore on next use).
    pub fn clear_in_memory(&mut self) {
        self.repos.clear();
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

    /// Drops a persisted ref. Missing names are ignored.
    ///
    /// # Errors
    ///
    /// Returns an error when the storage write fails.
    pub fn persist_delete_ref(&self, org: &str, repo: &str, name: &str) -> Result<()> {
        if let Some(storage) = &self.storage {
            let repo_store = storage.open_repo(org, repo, true)?;
            repo_store.delete_ref(name)?;
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
    fn restore_from_repodo(org: &str, repo: &str, repository: &SharedRepository) -> Result<()> {
        let Some(base) = Self::worker_base() else {
            return Ok(());
        };
        let Some(secret) = Self::internal_secret() else {
            return Ok(());
        };
        restore_from_url(org, repo, repository, &base, &secret)
    }
}

/// Replays a `RepoDO` snapshot into an empty in-memory repository.
fn apply_snapshot(repository: &SharedRepository, body: HydrateBody) -> Result<()> {
    let mut parsed = Vec::with_capacity(body.changesets.len());
    for row in body.changesets {
        let cs: openscion_core::Changeset =
            serde_json::from_value(row.changeset).map_err(|_| {
                openscion_core::Error::InvalidChange {
                    path: "repodo".to_owned(),
                    rule: "bad changeset json",
                }
            })?;
        parsed.push(cs);
    }
    for cs in parsed {
        let _ = repository
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .append_restored_changeset(cs)?;
    }
    for row in body.refs {
        let value = RefValue::new(
            &row.name,
            row.target
                .parse()
                .map_err(|_| openscion_core::Error::InvalidChange {
                    path: "repodo".to_owned(),
                    rule: "bad ref id",
                })?,
            row.version,
        );
        let _ = repository
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .set_ref_direct(value)?;
    }
    Ok(())
}

/// Fetches a `RepoDO` snapshot over HTTP. Connection, status, and decode
/// failures are empty stores — a brand-new repo has nothing to restore, and
/// a cold container often cannot hairpin to the Worker at all.
fn restore_from_url(
    org: &str,
    repo: &str,
    repository: &SharedRepository,
    base: &str,
    secret: &str,
) -> Result<()> {
    let agent = ureq::Agent::new_with_defaults();
    let Some(mut body) = get_internal_json::<HydrateBody>(
        &agent,
        &format!("{base}/__internal/do/{org}/{repo}/changesets"),
        secret,
        "changesets",
        org,
        repo,
    ) else {
        return Ok(());
    };
    if let Some(refs) = get_internal_json::<HydrateBody>(
        &agent,
        &format!("{base}/__internal/do/{org}/{repo}/refs"),
        secret,
        "refs",
        org,
        repo,
    ) {
        body.refs = refs.refs;
    }
    apply_snapshot(repository, body)
}

fn get_internal_json<T: serde::de::DeserializeOwned + Default>(
    agent: &ureq::Agent,
    url: &str,
    secret: &str,
    label: &str,
    org: &str,
    repo: &str,
) -> Option<T> {
    let resp = match agent.get(url).header("x-internal-secret", secret).call() {
        Ok(resp) => resp,
        Err(error) => {
            eprintln!("[restore] {org}/{repo} {label} fetch failed: {error}");
            return None;
        }
    };
    let text = match resp
        .into_body()
        .with_config()
        .limit(1 << 30)
        .read_to_string()
    {
        Ok(text) => text,
        Err(error) => {
            eprintln!("[restore] {org}/{repo} {label} decode failed: {error}");
            return None;
        }
    };
    match serde_json::from_str::<T>(&text) {
        Ok(value) => Some(value),
        Err(error) => {
            eprintln!("[restore] {org}/{repo} {label} decode failed: {error}");
            None
        }
    }
}

#[cfg(test)]
mod test;
