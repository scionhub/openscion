//! `scn admin archive`.
//!
//! Owners and site admins move the oldest changesets into immutable `SQLite`
//! pieces. The command prints the plan, or the piece ids that were written.
//! Commit ids are unchanged.

use std::path::Path;

use super::branch::repo_client;
use crate::Result;

/// Asks the server to archive history strictly older than `before`.
///
/// # Errors
///
/// Returns [`crate::Error::NotAWorkingCopy`] when `root` is not a working
/// copy, and [`crate::Error::Server`] when the archive call fails.
pub(crate) fn archive(
    root: &Path,
    before: &str,
    dry_run: bool,
    token: Option<String>,
) -> Result<String> {
    let (_state, client) = repo_client(root, token)?;
    let body = client.archive_history(before, dry_run)?;
    Ok(format_archive(&body))
}

fn format_archive(body: &serde_json::Value) -> String {
    let rows = body
        .get("rows")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let bytes = body
        .get("bytes")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let dry = body
        .get("dry_run")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if dry {
        let chunks = body
            .get("chunks")
            .and_then(serde_json::Value::as_array)
            .map_or(0, Vec::len);
        return format!("would archive {rows} changesets ({bytes} bytes) in {chunks} pieces\n");
    }
    let archives = body.get("archives").and_then(serde_json::Value::as_array);
    let mut out = format!(
        "archived {rows} changesets in {} pieces\n",
        archives.map_or(0, Vec::len)
    );
    if rows == 0
        && let Some(list) = archives
    {
        let total: u64 = list
            .iter()
            .map(|row| {
                row.get("rows")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            })
            .sum();
        if total > 0 {
            out = format!("archived {total} changesets in {} pieces\n", list.len());
        }
    }
    if let Some(list) = archives {
        for row in list {
            if let Some(cid) = row.get("piece_cid").and_then(serde_json::Value::as_str) {
                out.push_str(cid);
                out.push('\n');
            }
        }
    }
    out
}
