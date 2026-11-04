//! URL parsing and API-base discovery.

// Same allowance as the other unit-test modules; these tests unwrap parse results.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::{discover_api_base, parse_repo_url, resolve_server};
use crate::test_support::canned_server;

#[test]
fn bare_org_repo_uses_the_default_server() {
    let spec = parse_repo_url("filecoin-project/lotus").unwrap();
    assert!(spec.origin.is_none());
    assert_eq!(spec.org, "filecoin-project");
    assert_eq!(spec.repo, "lotus");
    assert_eq!(spec.repo_path(), "filecoin-project/lotus");
}

#[test]
fn host_qualified_paths_default_to_https() {
    let spec = parse_repo_url("git.example:8443/acme/widgets").unwrap();
    assert_eq!(spec.origin.as_deref(), Some("https://git.example:8443"));
    assert_eq!(spec.repo_path(), "acme/widgets");

    let spec = parse_repo_url("localhost:8787/acme/widgets.git").unwrap();
    assert_eq!(spec.origin.as_deref(), Some("https://localhost:8787"));
    assert_eq!(spec.repo, "widgets");
}

#[test]
fn absolute_urls_keep_their_scheme() {
    let spec = parse_repo_url("https://api.example/acme/widgets/").unwrap();
    assert_eq!(spec.origin.as_deref(), Some("https://api.example"));
    assert_eq!(spec.repo_path(), "acme/widgets");

    let spec = parse_repo_url("http://127.0.0.1:9/local/default").unwrap();
    assert_eq!(spec.origin.as_deref(), Some("http://127.0.0.1:9"));
    assert_eq!(spec.org, "local");
    assert_eq!(spec.repo, "default");
}

#[test]
fn a_single_segment_is_rejected() {
    assert!(parse_repo_url("lotus").is_err());
    assert!(parse_repo_url("https://example.com").is_err());
    assert!(parse_repo_url("https://example.com/only-one").is_err());
}

#[test]
fn discovery_uses_api_base_and_falls_back_to_the_origin() {
    let body = r#"{"api_base":"https://api.example"}"#;
    let leaked: &'static str = Box::leak(body.to_owned().into_boxed_str());
    let origin = canned_server(200, leaked);
    assert_eq!(discover_api_base(&origin), "https://api.example");

    let missing = canned_server(404, "nope");
    assert_eq!(discover_api_base(&missing), missing);
    assert_eq!(resolve_server(&origin), "https://api.example");
}
