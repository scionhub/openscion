//! Local tag cache formatting and scripted tag writes.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::{Tag, create, delete, format_list, list, sync_down};
use crate::ServerClient;
use crate::test_support::{save_checkout, scratch, scripted_server};

#[test]
fn annotated_tags_include_their_message() {
    let text = format_list(&[
        Tag {
            name: "v1".to_owned(),
            target: "ab".repeat(32),
            message: Some("ship".to_owned()),
            author: Some("ada".to_owned()),
            created_at: 1,
            annotated: true,
        },
        Tag {
            name: "nightly".to_owned(),
            target: "cd".repeat(32),
            message: None,
            author: None,
            created_at: 2,
            annotated: false,
        },
    ]);
    assert!(text.starts_with("nightly "));
    assert!(text.contains("v1 "));
    assert!(text.contains("ship"));
    assert!(!text.contains("piece"));
}

#[test]
fn create_list_and_delete_round_trip_on_the_server() {
    let target = "ab".repeat(32);
    let posted = target.clone();
    let base = scripted_server(move |request| {
        if request.method == "POST" {
            let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(body["name"], "v1");
            assert_eq!(body["message"], "ship");
            assert!(!request.body.contains("bafy"));
            return (
                201,
                format!(
                    r#"{{"name":"v1","target":"{posted}","message":"ship","author":"ada","created_at":1,"annotated":true}}"#
                ),
            );
        }
        if request.method == "DELETE" {
            assert!(request.path.contains("/tags/v1"));
            return (200, r#"{"ok":true}"#.to_owned());
        }
        (
            200,
            format!(
                r#"{{"tags":[{{"name":"v1","target":"{posted}","annotated":true,"message":"ship"}}]}}"#
            ),
        )
    });
    let root = scratch("tag-scripted");
    save_checkout(&root, &base);
    let created = create(&root, "v1", Some(&target), Some("ship"), None).unwrap();
    assert!(created.annotated);
    assert_eq!(created.target, target);
    let listed = list(&root, None).unwrap();
    assert_eq!(listed.len(), 1);
    delete(&root, "v1", None).unwrap();
}

#[test]
fn sync_down_treats_a_missing_tags_route_as_empty() {
    let base = scripted_server(|_| (404, r#"{"error":"not found"}"#.to_owned()));
    let root = scratch("tag-missing");
    save_checkout(&root, &base);
    let client = ServerClient::new(&base).repo("acme", "widgets");
    assert_eq!(sync_down(&root, &client).unwrap(), 0);
}
