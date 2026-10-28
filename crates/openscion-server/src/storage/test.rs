//! Engine `SQLite`: CAS ref persist, one object row per id, and O(1) tip → tree lookup.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use openscion_core::{
    CatalogStorage, Changeset, ChangesetInfo, CreateChangeset, Error, ObjectId, ObjectKind,
    RefValue, RepoStorage, Storage,
};

use super::sqlite::SqliteStorage;

fn hex_id(byte: u8) -> ObjectId {
    ObjectId::from_bytes([byte; 32])
}

fn tmp_db(prefix: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "openscion-sqlite-{prefix}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos()
    ));
    path
}

fn temp_storage() -> (SqliteStorage, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "openscion-sqlite-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.db");
    (SqliteStorage::open(&path).unwrap(), dir)
}

fn sample_changeset() -> Changeset {
    Changeset::from_request(CreateChangeset::new(vec![], vec![], "agent", "init"), 1)
}

#[test]
fn set_ref_inserts_then_rejects_same_version_other_target() {
    let path = tmp_db("cas");
    let storage = SqliteStorage::open(&path).expect("open sqlite");
    storage.create_repo("acme", "web").unwrap();
    let repo = storage.open_repo("acme", "web", true).unwrap();
    let a = ObjectId::from_bytes([1; 32]);
    let b = ObjectId::from_bytes([2; 32]);
    repo.set_ref(&RefValue::new("main", a, 1)).unwrap();
    repo.set_ref(&RefValue::new("main", a, 1)).unwrap();
    let err = repo.set_ref(&RefValue::new("main", b, 1)).unwrap_err();
    assert!(matches!(err, Error::RefConflict { name, .. } if name == "main"));
    repo.set_ref(&RefValue::new("main", b, 2)).unwrap();
    let refs = repo.load_refs().unwrap();
    assert_eq!(refs[0].target, b);
    assert_eq!(refs[0].version, 2);
    let _ = std::fs::remove_file(path);
}

#[test]
fn objects_are_stored_once_across_repos() {
    let (storage, dir) = temp_storage();
    let a = storage.open_repo("org", "one", true).unwrap();
    let b = storage.open_repo("org", "two", true).unwrap();
    let id = hex_id(0xaa);
    a.save_object(id, ObjectKind::Blob, b"hello").unwrap();
    b.save_object(id, ObjectKind::Blob, b"hello").unwrap();

    let conn = rusqlite::Connection::open(dir.join("test.db")).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM objects WHERE id = ?1",
            [id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "same ObjectId must occupy one objects row");
}

#[test]
fn load_tip_tree_is_a_ref_pointer_not_a_log_scan() {
    let (storage, dir) = temp_storage();
    let repo = storage.open_repo("andy", "demo", true).unwrap();
    let changeset_id = hex_id(0x11);
    let tree_id = hex_id(0x22);
    repo.append_changeset(
        ChangesetInfo::new(changeset_id, 1, tree_id),
        &sample_changeset(),
    )
    .unwrap();
    repo.set_ref(&RefValue::new("main", changeset_id, 1))
        .unwrap();

    let (value, root) = repo.load_tip_tree("main").unwrap();
    assert_eq!(value.target, changeset_id);
    assert_eq!(root, tree_id);

    let conn = rusqlite::Connection::open(dir.join("test.db")).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT root_tree FROM refs WHERE name = 'main'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, tree_id.to_string());
}

#[test]
fn load_tip_tree_rejects_a_missing_ref() {
    let (storage, _) = temp_storage();
    let repo = storage.open_repo("andy", "demo", true).unwrap();
    let err = repo.load_tip_tree("main").unwrap_err();
    assert!(matches!(err, Error::NoSuchRef(name) if name == "main"));
}

#[test]
fn backfills_root_tree_on_refs_that_predate_the_column() {
    let dir = std::env::temp_dir().join(format!(
        "openscion-sqlite-legacy-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("legacy.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        r"
        CREATE TABLE orgs(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
        CREATE TABLE repos(
            id INTEGER PRIMARY KEY,
            org_id INTEGER NOT NULL,
            name TEXT NOT NULL
        );
        CREATE TABLE changesets(
            repo_id INTEGER NOT NULL,
            lsn INTEGER NOT NULL,
            id TEXT NOT NULL,
            root_tree TEXT NOT NULL,
            body TEXT NOT NULL,
            PRIMARY KEY (repo_id, lsn)
        );
        CREATE TABLE refs(
            repo_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            target TEXT NOT NULL,
            version INTEGER NOT NULL,
            PRIMARY KEY (repo_id, name)
        );
        INSERT INTO orgs(id, name) VALUES (1, 'andy');
        INSERT INTO repos(id, org_id, name) VALUES (1, 1, 'demo');
        INSERT INTO changesets(repo_id, lsn, id, root_tree, body)
            VALUES (1, 1, '11', '22', '{}');
        INSERT INTO refs(repo_id, name, target, version)
            VALUES (1, 'main', '11', 1);
        ",
    )
    .unwrap();
    drop(conn);

    // Open through the real constructor so init() migrates the column.
    let storage = SqliteStorage::open(&path).unwrap();
    let repo = storage.open_repo("andy", "demo", false).unwrap();
    // The backfill wrote root_tree; the stored ids in this fixture are not
    // 64-hex ObjectIds, so load_tip_tree would fail parse. Check the column.
    let conn = rusqlite::Connection::open(&path).unwrap();
    let stored: String = conn
        .query_row(
            "SELECT root_tree FROM refs WHERE name = 'main'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, "22");
    let _ = repo;
}
