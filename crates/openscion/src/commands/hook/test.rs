//! Hook commands against a scripted server.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::{add, list, remove};
use crate::ServerClient;
use crate::test_support::{save_checkout, scratch, scripted_server};

#[test]
fn add_posts_the_url_and_events() {
    let base = scripted_server(|request| {
        assert_eq!(request.method, "POST");
        assert!(request.path.contains("/hooks"));
        let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["url"], "https://ci.example/hook");
        assert_eq!(body["events"][0], "push");
        assert!(body["secret"].as_str().unwrap().len() >= 8);
        assert!(!request.body.contains("piece"));
        (
            201,
            r#"{"id":"h1","url":"https://ci.example/hook","events":["push"],"created_at":1}"#
                .to_owned(),
        )
    });
    let root = scratch("hook-add");
    save_checkout(&root, &base);
    let (id, secret) = add(
        &root,
        "https://ci.example/hook",
        &["push".to_owned()],
        None,
        None,
    )
    .unwrap();
    assert_eq!(id, "h1");
    assert!(secret.len() >= 8);
}

#[test]
fn remove_deletes_the_matching_url() {
    let base = scripted_server(|request| {
        if request.method == "GET" {
            (
                200,
                r#"{"hooks":[{"id":"h1","url":"https://ci.example/hook","events":["tag"]}]}"#
                    .to_owned(),
            )
        } else {
            assert_eq!(request.method, "DELETE");
            assert!(request.path.contains("/hooks/h1"));
            (200, r#"{"ok":true}"#.to_owned())
        }
    });
    let root = scratch("hook-remove");
    save_checkout(&root, &base);
    let listed = list(&root, None).unwrap();
    assert!(listed.contains("https://ci.example/hook"));
    assert_eq!(remove(&root, "https://ci.example/hook", None).unwrap(), 1);
}

#[test]
fn set_status_posts_state_and_context() {
    let base = scripted_server(|request| {
        assert_eq!(request.method, "POST");
        assert!(request.path.contains("/statuses/"));
        let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["state"], "success");
        assert_eq!(body["context"], "ci");
        assert_eq!(body["target_url"], "https://ci.example/1");
        assert!(!request.body.contains("bafy"));
        (200, r#"{"state":"success","context":"ci"}"#.to_owned())
    });
    let client = ServerClient::new(&base).repo("acme", "widgets");
    client
        .set_status(
            &"ab".repeat(32),
            "success",
            "ci",
            Some("https://ci.example/1"),
        )
        .unwrap();
}
