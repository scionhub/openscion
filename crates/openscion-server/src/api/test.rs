//! Tests for the API routes, over a real socket.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use axum::http::StatusCode;
use openscion_core::{
    Change, ChangesetInfo, ChangesetRecord, CreateChangeset, EntryKind, ErrorBody, FetchObjects,
    FrameWriter, ObjectId, ObjectKind, RefValue, RepoPath, StoredObjects, UpdateRef, decode_frames,
    decode_tree, object_id,
};
use serde_json::Value;

use super::ApiError;
use crate::{Server, ServerConfig};

/// Starts a server on its own runtime thread and returns its base URL.
fn start() -> String {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let server = Server::bind(&ServerConfig::new("127.0.0.1:0".parse().unwrap()))
                .await
                .unwrap();
            sender.send(server.local_addr()).unwrap();
            server.serve(std::future::pending()).await.unwrap();
        });
    });
    format!("http://{}", receiver.recv().unwrap())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into()
}

fn post_json(url: &str, body: &impl serde::Serialize) -> (u16, Value) {
    let mut response = agent().post(url).send_json(body).unwrap();
    (
        response.status().as_u16(),
        response.body_mut().read_json().unwrap(),
    )
}

fn get_json(url: &str) -> (u16, Value) {
    let mut response = agent().get(url).call().unwrap();
    (
        response.status().as_u16(),
        response.body_mut().read_json().unwrap(),
    )
}

fn create_repo(base: &str, org: &str, repo: &str) {
    let url = format!("{base}/v1/repos/{org}/{repo}");
    let response = agent().put(&url).send(&[][..]).unwrap();
    assert_eq!(response.status().as_u16(), 200);
}

fn upload(base: &str, org: &str, repo: &str, blobs: &[&[u8]]) -> Vec<ObjectId> {
    let mut frames = FrameWriter::new();
    for blob in blobs {
        frames.push(object_id(ObjectKind::Blob, blob), blob);
    }
    let mut response = agent()
        .post(format!("{base}/v1/repos/{org}/{repo}/blobs"))
        .send(&frames.finish()[..])
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    response
        .body_mut()
        .read_json::<StoredObjects>()
        .unwrap()
        .ids
}

fn create(base: &str, org: &str, repo: &str, request: &CreateChangeset) -> ChangesetInfo {
    let (status, body) = post_json(&format!("{base}/v1/repos/{org}/{repo}/changesets"), request);
    assert_eq!(status, 200, "{body}");
    serde_json::from_value(body).unwrap()
}

fn file(path: &str, blob: ObjectId) -> Change {
    Change::Upsert {
        path: RepoPath::new(path).unwrap(),
        kind: EntryKind::File,
        blob,
    }
}

#[test]
fn a_client_can_upload_commit_move_a_ref_and_fetch_the_snapshot() {
    let base = start();
    create_repo(&base, "acme", "demo");
    let ids = upload(&base, "acme", "demo", &[b"one", b"two"]);
    assert_eq!(ids[0], object_id(ObjectKind::Blob, b"one"));

    let request = CreateChangeset::new(
        vec![],
        vec![file("a/one.txt", ids[0]), file("two.txt", ids[1])],
        "test",
        "init",
    );
    let info = create(&base, "acme", "demo", &request);

    let (status, body) = post_json(
        &format!("{base}/v1/repos/acme/demo/refs/main"),
        &UpdateRef::new(None, info.id),
    );
    assert_eq!(status, 200);
    let main: RefValue = serde_json::from_value(body).unwrap();
    assert_eq!((main.target, main.version), (info.id, 1));

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/refs/main"));
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_value::<RefValue>(body).unwrap(), main);

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/changesets/{}", info.id));
    assert_eq!(status, 200);
    let record: ChangesetRecord = serde_json::from_value(body).unwrap();
    assert_eq!(record.info, info);

    let mut response = agent()
        .post(format!("{base}/v1/repos/acme/demo/objects"))
        .send_json(FetchObjects::new(vec![info.root_tree, ids[1]]))
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    let bytes = response.body_mut().read_to_vec().unwrap();
    let frames = decode_frames(&bytes).unwrap();
    assert_eq!(frames.len(), 2);
    let root = decode_tree(frames[0].1).unwrap();
    assert_eq!(root[0].name, "a");
    assert_eq!(frames[1], (ids[1], &b"two"[..]));
}

#[test]
fn refs_with_slashes_in_their_names_are_routed() {
    let base = start();
    create_repo(&base, "acme", "demo");
    let ids = upload(&base, "acme", "demo", &[b"x"]);
    let info = create(
        &base,
        "acme",
        "demo",
        &CreateChangeset::new(vec![], vec![file("x", ids[0])], "t", "m"),
    );
    let (status, body) = post_json(
        &format!("{base}/v1/repos/acme/demo/refs/release/1.0"),
        &UpdateRef::new(None, info.id),
    );
    assert_eq!(status, 200);
    assert_eq!(body["name"], "release/1.0");
}

fn error(status_and_body: (u16, Value)) -> (u16, String) {
    let (status, body) = status_and_body;
    (
        status,
        serde_json::from_value::<ErrorBody>(body).unwrap().code,
    )
}

#[test]
fn failures_map_to_status_codes_and_error_bodies() {
    let base = start();
    let ghost = ObjectId::from_bytes([7; 32]);

    assert_eq!(
        error(get_json(&format!("{base}/v1/repos/acme/demo/refs/main"))),
        (404, "NotFound".to_owned())
    );
    assert_eq!(
        error(get_json(&format!(
            "{base}/v1/repos/acme/demo/changesets/{ghost}"
        ))),
        (404, "NotFound".to_owned())
    );
    assert_eq!(
        error(get_json(&format!(
            "{base}/v1/repos/acme/demo/changesets/not-an-id"
        ))),
        (404, "NotFound".to_owned())
    );
    assert_eq!(
        error(post_json(
            &format!("{base}/v1/repos/acme/demo/objects"),
            &FetchObjects::new(vec![ghost])
        )),
        (404, "NotFound".to_owned())
    );
    // Create the repo first.
    create_repo(&base, "acme", "demo");
    let request = CreateChangeset::new(vec![], vec![file("x", ghost)], "t", "m");
    assert_eq!(
        error(post_json(
            &format!("{base}/v1/repos/acme/demo/changesets"),
            &request
        )),
        (404, "NotFound".to_owned())
    );

    let ids = upload(&base, "acme", "demo", &[b"x"]);
    let info = create(
        &base,
        "acme",
        "demo",
        &CreateChangeset::new(vec![], vec![file("x", ids[0])], "t", "m"),
    );
    let swap = UpdateRef::new(Some(info.id), info.id);
    assert_eq!(
        error(post_json(
            &format!("{base}/v1/repos/acme/demo/refs/main"),
            &swap
        )),
        (409, "RefConflict".to_owned())
    );
}

#[test]
fn uploads_with_a_wrong_id_or_a_truncated_frame_are_rejected() {
    let base = start();
    let mut frames = FrameWriter::new();
    frames.push(ObjectId::from_bytes([1; 32]), b"lies");
    let mut response = agent()
        .post(format!("{base}/v1/repos/acme/demo/blobs"))
        .send(&frames.finish()[..])
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
    let body: ErrorBody = response.body_mut().read_json().unwrap();
    assert_eq!(body.code, "CorruptObject");

    let mut response = agent()
        .post(format!("{base}/v1/repos/acme/demo/blobs"))
        .send(&[1u8, 2, 3][..])
        .unwrap();
    assert_eq!(response.status().as_u16(), 400);
    let body: ErrorBody = response.body_mut().read_json().unwrap();
    assert_eq!(body.code, "Malformed");
}

#[test]
fn get_repo_returns_org_and_name() {
    let base = start();
    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo"));
    assert_eq!(status, 200);
    assert_eq!(body["org"], "acme");
    assert_eq!(body["name"], "demo");
}

#[test]
fn empty_repo_tree_and_commits_are_not_found() {
    let base = start();
    create_repo(&base, "acme", "empty");
    let (status, body) = get_json(&format!("{base}/v1/repos/acme/empty"));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["org"], "acme");
    assert_eq!(body["name"], "empty");
    let (status, body) = get_json(&format!("{base}/v1/repos/acme/empty/tree/main"));
    assert_eq!(status, 404, "{body}");
    let (status, body) = get_json(&format!("{base}/v1/repos/acme/empty/commits/main"));
    assert_eq!(status, 404, "{body}");
    let (status, body) = get_json(&format!("{base}/v1/repos/acme/empty/blob/main?path=a.txt"));
    assert_eq!(status, 404, "{body}");
}

#[test]
fn tree_blob_and_commits_serve_a_snapshot() {
    let base = start();
    create_repo(&base, "acme", "demo");
    let ids = upload(&base, "acme", "demo", &[b"hello\n", b"nested"]);
    let mut request = CreateChangeset::new(
        vec![],
        vec![file("README.md", ids[0]), file("src/lib.rs", ids[1])],
        "ada",
        "init",
    );
    request
        .metadata
        .insert("pcid:README.md".to_owned(), "bafkreadme".to_owned());
    let info = create(&base, "acme", "demo", &request);
    post_json(
        &format!("{base}/v1/repos/acme/demo/refs/main"),
        &UpdateRef::new(None, info.id),
    );

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/changesets/main"));
    assert_eq!(status, 200, "{body}");
    let rec: ChangesetRecord = serde_json::from_value(body).unwrap();
    assert_eq!(rec.info.id, info.id);

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/tree/main"));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["tree"], info.root_tree.to_string());
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["name"], "README.md");
    assert_eq!(entries[0]["kind"], "file");
    assert_eq!(entries[0]["id"], ids[0].to_string());
    assert_eq!(entries[0]["size"], 6);
    assert_eq!(entries[0]["pieceCid"], "bafkreadme");
    assert_eq!(entries[1]["name"], "src");
    assert_eq!(entries[1]["kind"], "dir");

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/tree/main?path=src"));
    assert_eq!(status, 200, "{body}");
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["name"], "lib.rs");
    assert_eq!(entries[0]["kind"], "file");
    assert_eq!(entries[0]["size"], 6);
    let src_tree = body["tree"].as_str().unwrap().to_owned();
    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/tree/{src_tree}"));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["entries"][0]["name"], "lib.rs");

    let (status, body) = get_json(&format!(
        "{base}/v1/repos/acme/demo/blob/main?path=README.md"
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["blob"], ids[0].to_string());
    assert_eq!(body["size"], 6);
    assert_eq!(body["pieceCid"], "bafkreadme");
    assert_eq!(body["raw"], "/v1/repos/acme/demo/objects");
    let decoded = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        body["contentBase64"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(decoded, b"hello\n");

    let ids2 = upload(&base, "acme", "demo", &[b"hello world\n"]);
    let mut request = CreateChangeset::new(
        vec![info.id],
        vec![file("README.md", ids2[0])],
        "ada",
        "edit readme",
    );
    request
        .metadata
        .insert("pcid:README.md".to_owned(), "bafknew".to_owned());
    request
        .metadata
        .insert("pcid:src/lib.rs".to_owned(), "bafklib".to_owned());
    let head = create(&base, "acme", "demo", &request);
    post_json(
        &format!("{base}/v1/repos/acme/demo/refs/compare-head"),
        &UpdateRef::new(None, head.id),
    );

    let (status, body) = get_json(&format!(
        "{base}/v1/repos/acme/demo/compare/main...compare-head"
    ));
    assert_eq!(status, 200, "{body}");
    let files = body["files"].as_array().unwrap();
    assert_eq!(files.len(), 1, "{body}");
    assert_eq!(files[0]["path"], "README.md");
    assert_eq!(files[0]["status"], "modified");
    assert_eq!(files[0]["baseSize"], 6);
    assert_eq!(files[0]["headSize"], 12);
    assert_eq!(files[0]["basePieceCid"], "bafkreadme");
    assert_eq!(files[0]["headPieceCid"], "bafknew");

    let (status, body) = get_json(&format!(
        "{base}/v1/repos/acme/demo/compare?base=main&head=compare-head"
    ));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["files"][0]["status"], "modified");

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/compare/main...main"));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "identical");
    assert_eq!(body["files"].as_array().unwrap().len(), 0);

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/commits/main?limit=5"));
    assert_eq!(status, 200, "{body}");
    let commits = body["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0]["id"], info.id.to_string());
    assert_eq!(commits[0]["message"], "init");
    assert_eq!(commits[0]["author"], "ada");
    assert_eq!(commits[0]["root_tree"], info.root_tree.to_string());
    assert_eq!(commits[0]["metadata"]["pcid:README.md"], "bafkreadme");

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/changesets/{}", info.id));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["message"], "init");
    assert_eq!(body["metadata"]["pcid:README.md"], "bafkreadme");
}

#[test]
fn signup_rejects_a_short_username_or_password() {
    let base = start();
    let (status, body) = post_json(
        &format!("{base}/v1/auth/signup"),
        &serde_json::json!({ "username": "ab", "password": "password12" }),
    );
    assert_eq!(status, 400, "{body}");
    let (status, body) = post_json(
        &format!("{base}/v1/auth/signup"),
        &serde_json::json!({ "username": "alice", "password": "short" }),
    );
    assert_eq!(status, 400, "{body}");
}

#[test]
fn internal_auth_hashes_and_verifies_with_rust_argon2_defaults() {
    let base = start();
    let password = "test-password-ok";
    let (status, body) = post_json(
        &format!("{base}/__internal/auth/hash"),
        &serde_json::json!({ "password": password }),
    );
    assert_eq!(status, 200, "{body}");
    let hash = body["password_hash"].as_str().expect("password_hash");
    assert!(
        hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"),
        "expected Rust Argon2::default PHC prefix"
    );

    let (status, body) = post_json(
        &format!("{base}/__internal/auth/verify"),
        &serde_json::json!({ "password": password, "password_hash": hash }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], true);

    let (status, body) = post_json(
        &format!("{base}/__internal/auth/verify"),
        &serde_json::json!({ "password": "wrong-password", "password_hash": hash }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], false);
}

#[test]
fn internal_auth_hash_rejects_a_short_password() {
    let base = start();
    let (status, body) = post_json(
        &format!("{base}/__internal/auth/hash"),
        &serde_json::json!({ "password": "short" }),
    );
    assert_eq!(status, 400, "{body}");
}

#[test]
fn internal_auth_verify_treats_a_malformed_hash_as_not_ok() {
    let base = start();
    let (status, body) = post_json(
        &format!("{base}/__internal/auth/verify"),
        &serde_json::json!({
            "password": "test-password-ok",
            "password_hash": "not-a-phc-hash"
        }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], false);
}

#[test]
fn internal_auth_verify_requires_password_and_hash() {
    let base = start();
    let (status, body) = post_json(
        &format!("{base}/__internal/auth/verify"),
        &serde_json::json!({ "password": "", "password_hash": "x" }),
    );
    assert_eq!(status, 400, "{body}");
    let (status, body) = post_json(
        &format!("{base}/__internal/auth/verify"),
        &serde_json::json!({ "password": "test-password-ok", "password_hash": "" }),
    );
    assert_eq!(status, 400, "{body}");
}

#[test]
fn refs_are_listed_and_deleted_and_looked_up_by_short_name() {
    let base = start();
    create_repo(&base, "acme", "demo");
    let ids = upload(&base, "acme", "demo", &[b"x"]);
    let info = create(
        &base,
        "acme",
        "demo",
        &CreateChangeset::new(vec![], vec![file("x", ids[0])], "t", "m"),
    );
    post_json(
        &format!("{base}/v1/repos/acme/demo/refs/main"),
        &UpdateRef::new(None, info.id),
    );
    post_json(
        &format!("{base}/v1/repos/acme/demo/refs/feature"),
        &UpdateRef::new(None, info.id),
    );

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/refs/refs/heads/main"));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["name"], "main");

    let (status, body) = get_json(&format!("{base}/v1/repos/acme/demo/branches"));
    assert_eq!(status, 200, "{body}");
    let names: Vec<&str> = body["branches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"main"));
    assert!(names.contains(&"feature"));

    let (status, body) = get_json(&format!("{base}/v1/orgs/acme/membership"));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["member"], serde_json::json!(true));
    assert_eq!(body["org"], "acme");

    let mut response = agent()
        .delete(format!("{base}/v1/repos/acme/demo/refs/feature"))
        .call()
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let deleted: Value = response.body_mut().read_json().unwrap();
    assert_eq!(deleted["deleted"], "feature");
    assert_eq!(
        get_json(&format!("{base}/v1/repos/acme/demo/refs/feature")).0,
        404
    );
}

#[test]
fn lockup_header_forces_the_insufficient_lockup_path() {
    use axum::http::HeaderMap;
    let mut headers = HeaderMap::new();
    assert!(!super::force_add_error(&headers));
    headers.insert("x-scn-force-add-error", "lockup".parse().unwrap());
    assert!(super::force_add_error(&headers));
    headers.insert(
        "x-scn-force-add-error",
        "InsufficientLockupFunds".parse().unwrap(),
    );
    assert!(super::force_add_error(&headers));
    assert!(super::forced_lockup_message().starts_with("InsufficientLockupFunds:"));
}

#[test]
fn shared_mode_add_pieces_does_not_create_a_dataset() {
    assert!(!super::should_create_dataset(Some(false)));
    assert!(super::should_create_dataset(Some(true)));
    assert!(super::should_create_dataset(None));
}

#[test]
fn query_param_reads_org_from_the_query_string() {
    let uri: axum::http::Uri = "/v1/admin/data-set-pieces?org=filecoin-project"
        .parse()
        .unwrap();
    assert_eq!(
        super::query_param(&uri, "org").as_deref(),
        Some("filecoin-project")
    );
    let missing: axum::http::Uri = "/v1/admin/data-set-pieces".parse().unwrap();
    assert_eq!(super::query_param(&missing, "org"), None);
}

#[test]
fn remove_pieces_body_uses_camel_case_piece_ids() {
    let req: super::RemovePiecesReq =
        serde_json::from_str(r#"{"org":"filecoin-project","pieceIds":[1,2,3]}"#).unwrap();
    assert_eq!(req.org, "filecoin-project");
    assert_eq!(req.piece_ids, vec![1, 2, 3]);
    let alias: super::RemovePiecesReq =
        serde_json::from_str(r#"{"org":"alice","piece_ids":[9]}"#).unwrap();
    assert_eq!(alias.piece_ids, vec![9]);
}

#[test]
fn duplicate_client_dataset_errors_are_detected() {
    assert!(super::is_duplicate_client_dataset(
        "create failed: duplicate clientDataSetId"
    ));
    assert!(super::is_duplicate_client_dataset(
        "client dataset already exists"
    ));
    assert!(!super::is_duplicate_client_dataset(
        "InsufficientLockupFunds: deposit needed"
    ));
}

#[test]
fn engine_errors_other_than_lookups_and_conflicts_are_bad_requests() {
    let error = ApiError::from(openscion_core::Error::InvalidChange {
        path: "a".to_owned(),
        rule: "path changed twice",
    });
    let (status, body) = error.parts();
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body.code, "InvalidChange");
}
