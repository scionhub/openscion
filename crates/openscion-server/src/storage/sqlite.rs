use std::path::{Path, PathBuf};

use openscion_core::{CatalogStorage, RepoStorage, Storage};
use openscion_core::{Changeset, ChangesetInfo, ChangesetRecord, ObjectId, ObjectKind, RefValue};
use openscion_core::{Error, Result};
use rusqlite::{params};

/// A SQLite-backed storage implementation. One database file spans all orgs
/// and repos.
#[derive(Debug, Clone)]
pub(crate) struct SqliteStorage {
    db_path: PathBuf,
}

impl SqliteStorage {
    /// Opens (or creates) the database at `db_path` and ensures the schema
    /// exists.
    pub(crate) fn open(db_path: impl AsRef<Path>) -> Result<Self> {
        let db_path = db_path.as_ref().to_path_buf();
        let storage = Self { db_path };
        storage.init()?;
        Ok(storage)
    }

    fn connection(&self) -> rusqlite::Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open(&self.db_path)?;
        // Reasonable defaults: WAL for safe concurrent writers, and foreign keys on.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    fn init(&self) -> Result<()> {
        let conn = self.connection().map_err(to_error)?;
        conn.execute_batch(
            r"
            CREATE TABLE IF NOT EXISTS orgs(
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS repos(
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                name   TEXT NOT NULL,
                UNIQUE(org_id, name)
            );
            -- Objects are stored once and referenced by any repo; a later phase
            -- may add per-repo reachability.
            CREATE TABLE IF NOT EXISTS objects(
                id    TEXT PRIMARY KEY, -- hex ObjectId
                kind  TEXT NOT NULL CHECK(kind IN ('blob','tree')),
                bytes BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS changesets(
                repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                lsn       INTEGER NOT NULL,
                id        TEXT NOT NULL,          -- hex ObjectId
                root_tree TEXT NOT NULL,          -- hex ObjectId
                body      TEXT NOT NULL,          -- JSON Changeset
                PRIMARY KEY (repo_id, lsn),
                UNIQUE(repo_id, id)
            );
            CREATE TABLE IF NOT EXISTS refs(
                repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                name    TEXT NOT NULL,
                target  TEXT NOT NULL,            -- hex ObjectId
                version INTEGER NOT NULL,
                PRIMARY KEY (repo_id, name)
            );
            ",
        )
        .map_err(to_error)?;
        Ok(())
    }

    fn org_id(conn: &rusqlite::Connection, org: &str) -> rusqlite::Result<i64> {
        conn.query_row("SELECT id FROM orgs WHERE name = ?1", params![org], |row| {
            row.get(0)
        })
    }

    #[allow(clippy::unused_self)]
    fn ensure_org(&self, conn: &rusqlite::Connection, org: &str) -> rusqlite::Result<i64> {
        if let Ok(id) = Self::org_id(conn, org) {
            return Ok(id);
        }
        conn.execute("INSERT OR IGNORE INTO orgs(name) VALUES (?1)", params![org])?;
        Self::org_id(conn, org)
    }

    fn repo_id(conn: &rusqlite::Connection, org: &str, repo: &str) -> rusqlite::Result<i64> {
        conn.query_row(
            r"
            SELECT r.id
            FROM repos r
            JOIN orgs o ON o.id = r.org_id
            WHERE o.name = ?1 AND r.name = ?2
            ",
            params![org, repo],
            |row| row.get(0),
        )
    }

    fn ensure_repo(
        &self,
        conn: &rusqlite::Connection,
        org: &str,
        repo: &str,
    ) -> rusqlite::Result<i64> {
        if let Ok(id) = Self::repo_id(conn, org, repo) {
            return Ok(id);
        }
        let org_id = self.ensure_org(conn, org)?;
        conn.execute(
            "INSERT OR IGNORE INTO repos(org_id, name) VALUES (?1, ?2)",
            params![org_id, repo],
        )?;
        Self::repo_id(conn, org, repo)
    }
}

impl CatalogStorage for SqliteStorage {
    fn create_repo(&self, org: &str, repo: &str) -> Result<()> {
        let conn = self.connection().map_err(to_error)?;
        let _ = self.ensure_repo(&conn, org, repo).map_err(to_error)?;
        Ok(())
    }

    fn list_orgs(&self) -> Result<Vec<String>> {
        let conn = self.connection().map_err(to_error)?;
        let mut stmt = conn
            .prepare("SELECT name FROM orgs ORDER BY name ASC")
            .map_err(to_error)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        let mut out = Vec::new();
        for org in rows {
            out.push(org.map_err(to_error)?);
        }
        Ok(out)
    }

    fn list_repos(&self, org: &str) -> Result<Vec<String>> {
        let conn = self.connection().map_err(to_error)?;
        let mut stmt = conn
            .prepare(
                r"
                SELECT r.name
                FROM repos r
                JOIN orgs o ON o.id = r.org_id
                WHERE o.name = ?1
                ORDER BY r.name ASC
                ",
            )
            .map_err(to_error)?;
        let rows = stmt
            .query_map([org], |row| row.get::<_, String>(0))
            .map_err(to_error)?;
        let mut out = Vec::new();
        for repo in rows {
            out.push(repo.map_err(to_error)?);
        }
        Ok(out)
    }
}

impl Storage for SqliteStorage {
    type Repo = SqliteRepo;

    fn open_repo(&self, org: &str, repo: &str, create: bool) -> Result<Self::Repo> {
        let conn = self.connection().map_err(to_error)?;
        let repo_id = if create {
            self.ensure_repo(&conn, org, repo)
        } else {
            Self::repo_id(&conn, org, repo)
        }
        .map_err(to_error)?;
        Ok(SqliteRepo {
            db_path: self.db_path.clone(),
            repo_id,
        })
    }
}

/// A repo-scoped `SQLite` handle.
#[derive(Debug, Clone)]
pub(crate) struct SqliteRepo {
    db_path: PathBuf,
    repo_id: i64,
}

impl SqliteRepo {
    fn connection(&self) -> rusqlite::Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open(&self.db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }
}

impl RepoStorage for SqliteRepo {
    fn save_object(&self, id: ObjectId, kind: ObjectKind, bytes: &[u8]) -> Result<()> {
        let conn = self.connection().map_err(to_error)?;
        let kind_text = match kind {
            ObjectKind::Blob => "blob",
            ObjectKind::Tree => "tree",
            ObjectKind::Changeset => {
                // objects() only stores blobs and trees.
                return Ok(());
            }
        };
        conn.execute(
            "INSERT OR IGNORE INTO objects(id, kind, bytes) VALUES (?1, ?2, ?3)",
            params![id.to_string(), kind_text, bytes],
        )
        .map_err(to_error)?;
        Ok(())
    }

    fn load_objects(&self) -> Result<Vec<(ObjectId, ObjectKind, Vec<u8>)>> {
        let conn = self.connection().map_err(to_error)?;
        let mut stmt = conn
            .prepare("SELECT id, kind, bytes FROM objects")
            .map_err(to_error)?;
        let rows = stmt
            .query_map([], |row| {
                let id_text: String = row.get(0)?;
                let kind_text: String = row.get(1)?;
                let bytes: Vec<u8> = row.get(2)?;
                let kind = if kind_text.as_str() == "tree" {
                    ObjectKind::Tree
                } else {
                    ObjectKind::Blob // ignore unexpected kinds => treat as blob
                };
                Ok((id_text, kind, bytes))
            })
            .map_err(to_error)?;
        let mut out = Vec::new();
        for row in rows {
            let (id_text, kind, bytes): (String, ObjectKind, Vec<u8>) = row.map_err(to_error)?;
            let id: ObjectId = id_text.parse().map_err(|_| to_error_str("bad object id"))?;
            out.push((id, kind, bytes));
        }
        Ok(out)
    }

    fn append_changeset(&self, info: ChangesetInfo, changeset: &Changeset) -> Result<()> {
        let conn = self.connection().map_err(to_error)?;
        let json = serde_json::to_string(changeset).map_err(to_json_error)?;
        conn.execute(
            "INSERT OR IGNORE INTO changesets(repo_id, lsn, id, root_tree, body) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                self.repo_id,
                i64::try_from(info.lsn).unwrap_or(i64::MAX),
                info.id.to_string(),
                info.root_tree.to_string(),
                json
            ],
        )
        .map_err(to_error)?;
        Ok(())
    }

    fn load_changesets(&self) -> Result<Vec<ChangesetRecord>> {
        let conn = self.connection().map_err(to_error)?;
        let mut stmt = conn
            .prepare(
                "SELECT lsn, id, root_tree, body FROM changesets WHERE repo_id = ?1 ORDER BY lsn ASC",
            )
            .map_err(to_error)?;
        let rows = stmt
            .query_map([self.repo_id], |row| {
                let lsn: i64 = row.get(0)?;
                let id_text: String = row.get(1)?;
                let root_text: String = row.get(2)?;
                let json: String = row.get(3)?;
                Ok((lsn, id_text, root_text, json))
            })
            .map_err(to_error)?;
        let mut out = Vec::new();
        for row in rows {
            let (lsn, id_text, root_text, json): (i64, String, String, String) =
                row.map_err(to_error)?;
            let id: ObjectId = id_text
                .parse()
                .map_err(|_| to_error_str("bad changeset id"))?;
            let root_tree: ObjectId = root_text
                .parse()
                .map_err(|_| to_error_str("bad root_tree id"))?;
            let changeset: Changeset = serde_json::from_str(&json).map_err(to_json_error)?;
            let info = ChangesetInfo::new(id, u64::try_from(lsn).unwrap_or_default(), root_tree);
            out.push(ChangesetRecord::new(info, changeset));
        }
        Ok(out)
    }

    fn set_ref(&self, value: &RefValue) -> Result<()> {
        let conn = self.connection().map_err(to_error)?;
        conn.execute(
            "INSERT OR REPLACE INTO refs(repo_id, name, target, version) VALUES (?1, ?2, ?3, ?4)",
            params![
                self.repo_id,
                value.name,
                value.target.to_string(),
                i64::try_from(value.version).unwrap_or(i64::MAX)
            ],
        )
        .map_err(to_error)?;
        Ok(())
    }

    fn load_refs(&self) -> Result<Vec<RefValue>> {
        let conn = self.connection().map_err(to_error)?;
        let mut stmt = conn
            .prepare("SELECT name, target, version FROM refs WHERE repo_id = ?1 ORDER BY name ASC")
            .map_err(to_error)?;
        let rows = stmt
            .query_map([self.repo_id], |row| {
                let name: String = row.get(0)?;
                let target_text: String = row.get(1)?;
                let version: i64 = row.get(2)?;
                Ok((name, target_text, version))
            })
            .map_err(to_error)?;
        let mut out = Vec::new();
        for row in rows {
            let (name, target_text, version): (String, String, i64) = row.map_err(to_error)?;
            let target: ObjectId = target_text
                .parse()
                .map_err(|_| to_error_str("bad ref target"))?;
            let value = RefValue::new(&name, target, u64::try_from(version).unwrap_or_default());
            out.push(value);
        }
        Ok(out)
    }
}

#[allow(clippy::needless_pass_by_value)]
fn to_error(err: rusqlite::Error) -> Error {
    Error::Malformed {
        what: "sqlite",
        reason: Box::leak(err.to_string().into_boxed_str()),
    }
}

#[allow(clippy::needless_pass_by_value)]
fn to_json_error(err: serde_json::Error) -> Error {
    Error::Malformed {
        what: "json",
        reason: Box::leak(err.to_string().into_boxed_str()),
    }
}

fn to_error_str(msg: &'static str) -> Error {
    Error::Malformed {
        what: "sqlite",
        reason: msg,
    }
}
