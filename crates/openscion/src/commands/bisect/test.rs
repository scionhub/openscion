//! First-parent range and the bisect step machine.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::{Mark, advance, first_parent_range, open};

fn parents(id: &str) -> Option<String> {
    match id {
        "c3" => Some("c2".to_owned()),
        "c2" => Some("c1".to_owned()),
        "c1" => Some("c0".to_owned()),
        _ => None,
    }
}

#[test]
fn range_is_the_commits_after_good_through_bad() {
    let steps = first_parent_range("c3", "c0", parents).unwrap();
    assert_eq!(steps, ["c1", "c2", "c3"]);
}

#[test]
fn a_good_commit_that_is_not_an_ancestor_is_rejected() {
    assert!(first_parent_range("c2", "nope", parents).is_err());
    assert!(first_parent_range("c1", "c1", parents).is_err());
}

#[test]
fn good_and_bad_narrow_to_the_first_bad_commit() {
    let opened = open(
        "c3",
        "refs/heads/main",
        "c0",
        "c3",
        vec!["c1".into(), "c2".into(), "c3".into()],
    );
    assert_eq!(opened.checkout.as_deref(), Some("c2"));
    let after_bad = advance(opened.state, Mark::Bad).unwrap();
    assert_eq!(after_bad.checkout.as_deref(), Some("c1"));
    let found = advance(after_bad.state, Mark::Good).unwrap();
    assert_eq!(found.found.as_deref(), Some("c2"));
}

#[test]
fn skip_moves_to_another_candidate() {
    let opened = open(
        "c3",
        "refs/heads/main",
        "c0",
        "c3",
        vec!["c1".into(), "c2".into(), "c3".into()],
    );
    let skipped = advance(opened.state, Mark::Skip).unwrap();
    assert_ne!(skipped.checkout.as_deref(), Some("c2"));
    assert!(skipped.found.is_none());
}

#[test]
fn marking_every_commit_good_is_an_empty_range() {
    let opened = open("c1", "refs/heads/main", "c0", "c1", vec!["c1".into()]);
    assert_eq!(opened.found.as_deref(), Some("c1"));
    let crossed = advance(opened.state, Mark::Good).unwrap_err();
    assert!(matches!(crossed, crate::Error::BisectRange));
}
