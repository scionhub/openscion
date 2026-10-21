//! In-memory repositories with optional `SQLite` persistence and multi-repo catalog.
//!
//! The server exposes many repositories under `/v1/repos/{org}/{repo}/…`. Each
//! one is an in-memory `openscion_core::Repository` whose state is replayed
//! from `SQLite` on first use when a database path is configured.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock, PoisonError};

use openscion_core::{
    CatalogStorage, ChangesetInfo, ChangesetRecord, ObjectId, ObjectKind, RefValue, RepoStorage,
    Repository, Result, Storage,
};

use crate::storage::sqlite::SqliteStorage;

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
        Ok(Self { storage, repos: HashMap::new() })
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
