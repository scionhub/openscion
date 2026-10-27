//! Storage abstraction ports for persistence and multi-repo catalog.
//!
//! These traits describe the minimal operations a persistent backend must
//! support for OpenScion's engine state: objects (blobs and trees),
//! changesets, and refs, plus a catalog of organizations and repositories.
//! Implementations live outside this crate (for example in
//! `openscion-server`) so `openscion-core` stays free of concrete storage
//! dependencies.
//!
//! The engine continues to operate purely in memory; a server persists state
//! by saving writes as they happen and replaying them on startup using the
//! [`Repository`](crate::Repository)'s restore hooks.
//!
//! A later phase adds a Filecoin-backed object store; keeping objects as an
//! explicit facet of the storage API makes that substitution load-bearing.

use crate::Result;
use openscion_proto::{Changeset, ChangesetInfo, ChangesetRecord, ObjectId, ObjectKind, RefValue};

/// The repository-catalog operations: organizations and their repositories.
pub trait CatalogStorage: Send + Sync {
    /// Creates `{org}/{repo}` if it does not already exist.
    ///
    /// # Errors
    ///
    /// Returns an error when the underlying backend fails to persist the row.
    fn create_repo(&self, org: &str, repo: &str) -> Result<()>;

    /// Lists every organization that holds at least one repository.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend query fails.
    fn list_orgs(&self) -> Result<Vec<String>>;

    /// Lists the repositories under `org`.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend query fails.
    fn list_repos(&self, org: &str) -> Result<Vec<String>>;
}

/// A handle to one repository's persistent state.
pub trait RepoStorage: Send + Sync {
    /// Saves one object (blob or tree). Idempotent — an existing row is kept.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend write fails.
    fn save_object(&self, id: ObjectId, kind: ObjectKind, bytes: &[u8]) -> Result<()>;

    /// Loads every stored object for this repository.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend query fails or a row cannot be decoded.
    fn load_objects(&self) -> Result<Vec<(ObjectId, ObjectKind, Vec<u8>)>>;

    /// Appends a changeset, paired with its summary. Idempotent on `info.id`.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend write fails.
    fn append_changeset(&self, info: ChangesetInfo, changeset: &Changeset) -> Result<()>;

    /// Loads all changesets in log order (lsn ascending).
    ///
    /// # Errors
    ///
    /// Returns an error when the backend query fails or a row cannot be decoded.
    fn load_changesets(&self) -> Result<Vec<ChangesetRecord>>;

    /// Writes a ref value verbatim (used during restore). Idempotent.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend write fails.
    fn set_ref(&self, value: &RefValue) -> Result<()>;

    /// Drops a stored ref. Missing names are ignored.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend write fails.
    fn delete_ref(&self, name: &str) -> Result<()>;

    /// Loads every stored ref value.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend query fails or a row cannot be decoded.
    fn load_refs(&self) -> Result<Vec<RefValue>>;
}

/// A storage backend that spans many repositories.
pub trait Storage: CatalogStorage + Send + Sync {
    /// A repo-scoped storage handle produced by [`Storage::open_repo`].
    type Repo: RepoStorage;

    /// Opens `{org}/{repo}`, creating it when `create` is true.
    ///
    /// # Errors
    ///
    /// Returns an error when the backend cannot open or create the repository.
    fn open_repo(&self, org: &str, repo: &str, create: bool) -> Result<Self::Repo>;
}
