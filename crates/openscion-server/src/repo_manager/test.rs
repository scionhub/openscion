//! Restore treats an unreachable or empty `RepoDO` as an empty store.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, PoisonError, RwLock};

use openscion_core::Repository;

use super::{HydrateBody, RepoManager, SharedRepository, apply_snapshot, restore_from_url};

fn empty_repo() -> SharedRepository {
    Arc::new(RwLock::new(Repository::new()))
}

fn log_len(repository: &SharedRepository) -> usize {
    repository
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .log_len()
}

#[test]
fn unreachable_repodo_restore_starts_empty() {
    let repository = empty_repo();
    restore_from_url("andy", "new", &repository, "http://127.0.0.1:1", "secret").unwrap();
    assert_eq!(log_len(&repository), 0);
}

#[test]
fn empty_snapshot_hydrate_is_ok() {
    let repository = empty_repo();
    apply_snapshot(&repository, HydrateBody::default()).unwrap();
    assert_eq!(log_len(&repository), 0);
}

#[test]
fn empty_json_from_repodo_starts_empty() {
    let base = serve_json(
        "/__internal/do/andy/new/changesets",
        r#"{"changesets":[]}"#,
        "/__internal/do/andy/new/refs",
        r#"{"refs":[]}"#,
    );
    let repository = empty_repo();
    restore_from_url("andy", "new", &repository, &base, "secret").unwrap();
    assert_eq!(log_len(&repository), 0);
}

#[test]
fn bad_changeset_json_is_a_hard_error() {
    let repository = empty_repo();
    let body = serde_json::from_str::<HydrateBody>(
        r#"{
            "changesets": [{
                "id": "00",
                "lsn": 1,
                "root_tree": "00",
                "changeset": {"not": "a changeset"}
            }]
        }"#,
    )
    .unwrap();
    let err = apply_snapshot(&repository, body).unwrap_err();
    assert!(matches!(
        err,
        openscion_core::Error::InvalidChange {
            rule: "bad changeset json",
            ..
        }
    ));
}

#[test]
fn bad_ref_target_is_a_hard_error() {
    let repository = empty_repo();
    let body = serde_json::from_str::<HydrateBody>(
        r#"{"refs":[{"name":"main","target":"nope","version":1}]}"#,
    )
    .unwrap();
    let err = apply_snapshot(&repository, body).unwrap_err();
    assert!(matches!(
        err,
        openscion_core::Error::InvalidChange {
            rule: "bad ref id",
            ..
        }
    ));
}

#[test]
fn hydrate_replays_a_parentless_changeset_and_ref() {
    let mut source = Repository::new();
    let blob = source.put_blob(b"hi\n");
    let info = source
        .create_changeset(openscion_core::CreateChangeset::new(
            vec![],
            vec![openscion_core::Change::Upsert {
                path: openscion_core::RepoPath::new("README.md").unwrap(),
                kind: openscion_core::EntryKind::File,
                blob,
            }],
            "andy",
            "init",
        ))
        .unwrap();
    source
        .update_ref("main", openscion_core::UpdateRef::new(None, info.id))
        .unwrap();
    let record = source.changeset(info.id).unwrap();

    let body = serde_json::from_value::<HydrateBody>(serde_json::json!({
        "changesets": [{
            "id": info.id.to_string(),
            "lsn": info.lsn,
            "root_tree": info.root_tree.to_string(),
            "changeset": record.changeset,
        }],
        "refs": [{
            "name": "main",
            "target": info.id.to_string(),
            "version": 1
        }]
    }))
    .unwrap();

    let repository = empty_repo();
    apply_snapshot(&repository, body.clone()).unwrap();
    let guard = repository.read().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(guard.log_len(), 1);
    assert_eq!(guard.get_ref("main").unwrap().target, info.id);
    assert_eq!(guard.changeset(info.id).unwrap().info.id, info.id);
    drop(guard);

    let mut manager = RepoManager::new(None).unwrap();
    let cached = manager.get("acme", "cold").unwrap();
    assert_eq!(log_len(&cached), 0);
    manager.hydrate("acme", "cold", body).unwrap();
    assert_eq!(log_len(&cached), 1);
    let guard = cached.read().unwrap_or_else(PoisonError::into_inner);
    assert_eq!(guard.changeset(info.id).unwrap().info.id, info.id);
}

fn serve_json(
    path_a: &'static str,
    body_a: &'static str,
    path_b: &'static str,
    body_b: &'static str,
) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for incoming in listener.incoming().take(2) {
            let mut stream = incoming.unwrap();
            let mut buf = [0u8; 1024];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let (status, body) = if req.contains(path_a) {
                ("200 OK", body_a)
            } else if req.contains(path_b) {
                ("200 OK", body_b)
            } else {
                ("404 Not Found", "{}")
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    format!("http://{addr}")
}
