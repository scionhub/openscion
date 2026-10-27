//! `SQLite` ref persist is compare-and-swap, not last-writer-wins.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;

use openscion_core::{CatalogStorage, Error, ObjectId, RefValue, RepoStorage, Storage};

use super::sqlite::SqliteStorage;

fn tmp_db() -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "openscion-sqlite-cas-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    path
}

#[test]
fn set_ref_inserts_then_rejects_same_version_other_target() {
    let path = tmp_db();
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
