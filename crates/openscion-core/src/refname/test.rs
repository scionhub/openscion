//! Unit tests for ref-name normalization and lookup.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::{
    branch_upstream, is_protected_ref, is_user_namespace_ref, lookup_ref_names, normalize_ref,
    short_ref,
};

#[test]
fn short_names_become_refs_heads() {
    assert_eq!(normalize_ref("main"), "refs/heads/main");
    assert_eq!(normalize_ref("users/alice/feat"), "refs/heads/users/alice/feat");
    assert_eq!(normalize_ref("refs/heads/main"), "refs/heads/main");
    assert_eq!(normalize_ref("refs/tags/v1"), "refs/tags/v1");
    assert_eq!(normalize_ref("/main"), "refs/heads/main");
}

#[test]
fn short_ref_strips_the_heads_prefix() {
    assert_eq!(short_ref("refs/heads/main"), "main");
    assert_eq!(short_ref("main"), "main");
    assert_eq!(short_ref("refs/heads/users/alice/x"), "users/alice/x");
    assert_eq!(short_ref("users/alice/x"), "users/alice/x");
}

#[test]
fn lookup_tries_legacy_short_names_and_canonical_forms() {
    assert_eq!(
        lookup_ref_names("main"),
        ["main", "refs/heads/main"]
    );
    assert_eq!(
        lookup_ref_names("refs/heads/main"),
        ["refs/heads/main", "main"]
    );
    assert_eq!(
        lookup_ref_names("users/alice/feat"),
        ["users/alice/feat", "refs/heads/users/alice/feat"]
    );
    assert_eq!(
        lookup_ref_names("refs/heads/users/alice/feat"),
        ["refs/heads/users/alice/feat", "users/alice/feat"]
    );
    assert_eq!(lookup_ref_names("refs/tags/v1"), ["refs/tags/v1"]);
    assert!(lookup_ref_names("").is_empty());
}

#[test]
fn protected_refs_are_main_and_default() {
    assert!(is_protected_ref("main"));
    assert!(is_protected_ref("refs/heads/main"));
    assert!(is_protected_ref("default"));
    assert!(is_protected_ref("refs/heads/default"));
    assert!(!is_protected_ref("feature"));
    assert!(!is_protected_ref("refs/heads/users/alice/main"));
}

#[test]
fn user_namespace_is_under_users_username() {
    assert!(is_user_namespace_ref(
        "refs/heads/users/alice/feat",
        "alice"
    ));
    assert!(is_user_namespace_ref("users/alice/feat", "alice"));
    assert!(!is_user_namespace_ref("refs/heads/users/bob/feat", "alice"));
    assert!(!is_user_namespace_ref("refs/heads/feat", "alice"));
    assert!(!is_user_namespace_ref("users/alice/", "alice"));
}

#[test]
fn branch_upstream_depends_on_membership() {
    assert_eq!(
        branch_upstream("feat", "alice", false),
        "refs/heads/users/alice/feat"
    );
    assert_eq!(branch_upstream("feat", "alice", true), "refs/heads/feat");
    assert_eq!(
        branch_upstream("users/alice/feat", "alice", true),
        "refs/heads/users/alice/feat"
    );
    assert_eq!(
        branch_upstream("refs/heads/custom", "alice", false),
        "refs/heads/custom"
    );
}
