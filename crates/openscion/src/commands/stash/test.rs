//! Unit tests for the local stash store and apply/pop rules.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::parse_stash_ref;
use crate::Error;

#[test]
fn parse_stash_ref_accepts_git_style_and_plain_indexes() {
    assert_eq!(parse_stash_ref(None, 2).unwrap(), 0);
    assert_eq!(parse_stash_ref(Some("1"), 2).unwrap(), 1);
    assert_eq!(parse_stash_ref(Some("stash@{0}"), 2).unwrap(), 0);
    assert!(matches!(parse_stash_ref(None, 0), Err(Error::StashEmpty)));
    assert!(matches!(
        parse_stash_ref(Some("3"), 2),
        Err(Error::StashNotFound(_))
    ));
}
