//! Time parsing and formatting for `scn log`, plus scripted history reads.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::{LogFilter, blame, format_time, log, parse_time, show};
use crate::test_support::{save_checkout, scratch, scripted_server};

#[test]
fn unix_epoch_formats_and_parses() {
    assert_eq!(format_time(0), "1970-01-01 00:00:00");
    assert_eq!(parse_time("1970-01-01").unwrap(), 0);
    assert_eq!(parse_time("1").unwrap(), 1000);
    assert_eq!(parse_time("1500").unwrap(), 1_500_000);
    assert_eq!(parse_time("1700000000000").unwrap(), 1_700_000_000_000);
}

#[test]
fn a_known_date_is_stable() {
    assert_eq!(format_time(1_700_000_000_000), "2023-11-14 22:13:20");
    assert_eq!(parse_time("2023-11-14").unwrap(), 1_699_920_000_000);
}

#[test]
fn a_bad_date_is_rejected() {
    assert!(parse_time("yesterday").is_err());
    assert!(parse_time("2023-13-01").is_err());
}

#[test]
fn log_blame_and_show_read_the_server() {
    let base = scripted_server(|request| {
        assert_eq!(request.method, "GET");
        assert!(!request.path.contains("piece"));
        if request.path.contains("/log") {
            assert!(request.path.contains("n=2"));
            assert!(request.path.contains("grep=ship"));
            return (
                200,
                r#"{"commits":[{"id":"abcd","author":"ada","message":"ship it","created_at":0}],"next_cursor":null}"#
                    .to_owned(),
            );
        }
        if request.path.contains("/blame") {
            assert!(request.path.contains("path=README.md"));
            return (
                200,
                r#"{"lines":[{"line":1,"changeset":"abcdabcdabcd","author":"ada","text":"hello"}]}"#
                    .to_owned(),
            );
        }
        assert!(request.path.contains("/diff"));
        (
            200,
            r#"{"id":"abcd","author":"ada","message":"ship it","created_at":0,"diff":"--- a/README.md\n+++ b/README.md\n@@ -0,0 +1 @@\n+hello\n"}"#
                .to_owned(),
        )
    });
    let root = scratch("history-scripted");
    save_checkout(&root, &base);
    let logged = log(
        &root,
        &LogFilter {
            path: Some("README.md"),
            limit: 2,
            branch: None,
            author: None,
            since: None,
            until: None,
            grep: Some("ship"),
            cursor: None,
        },
        None,
    )
    .unwrap();
    assert!(logged.contains("changeset abcd"));
    assert!(logged.contains("ship it"));
    assert!(!logged.contains("pcid"));
    let blamed = blame(&root, "README.md", None, None).unwrap();
    assert!(blamed.contains("hello"));
    assert!(blamed.contains("ada"));
    let shown = show(&root, "abcd", None).unwrap();
    assert!(shown.contains("+hello"));
    assert!(shown.contains("changeset abcd"));
}
