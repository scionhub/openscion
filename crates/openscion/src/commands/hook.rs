//! `scn hook add`, `list`, and `remove`.
//!
//! Payloads are HMAC-signed on the server. The secret is printed once when
//! the caller does not pass one.

use std::io::Read;
use std::path::Path;

use super::branch::repo_client;
use crate::{Error, Result};

/// Creates a hook and returns the secret that will sign deliveries.
pub(crate) fn add(
    root: &Path,
    url: &str,
    events: &[String],
    secret: Option<&str>,
    token: Option<String>,
) -> Result<(String, String)> {
    if events.is_empty() {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "hook events are required",
        }));
    }
    let secret = secret.map_or_else(random_secret, str::to_owned);
    if secret.len() < 8 {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "hook secret must be at least 8 characters",
        }));
    }
    let (_state, client) = repo_client(root, token)?;
    let value = client.add_hook(url, &secret, events)?;
    let id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned();
    Ok((id, secret))
}

/// One hook line per row: id, url, events.
pub(crate) fn list(root: &Path, token: Option<String>) -> Result<String> {
    let (_state, client) = repo_client(root, token)?;
    let value = client.list_hooks()?;
    let rows = value
        .get("hooks")
        .or_else(|| value.get("webhooks"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = String::new();
    for row in &rows {
        let id = row
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let url = row
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let events = row
            .get("events")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        super::write_fmt(&mut out, format_args!("{id} {url} {events}\n"));
    }
    Ok(out)
}

/// Removes every hook whose URL matches.
pub(crate) fn remove(root: &Path, url: &str, token: Option<String>) -> Result<usize> {
    let (_state, client) = repo_client(root, token)?;
    let value = client.list_hooks()?;
    let rows = value
        .get("hooks")
        .or_else(|| value.get("webhooks"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut removed = 0;
    for row in &rows {
        if row.get("url").and_then(serde_json::Value::as_str) != Some(url) {
            continue;
        }
        let Some(id) = row.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        client.delete_hook(id)?;
        removed += 1;
    }
    if removed == 0 {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: url.to_owned(),
            rule: "hook not found",
        }));
    }
    Ok(removed)
}

fn random_secret() -> String {
    let mut bytes = [0u8; 16];
    if getrandom(&mut bytes).is_err() {
        let ticks = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(1);
        bytes = ticks.to_le_bytes();
    }
    super::hex_encode(&bytes)
}

fn getrandom(bytes: &mut [u8]) -> std::io::Result<()> {
    std::fs::File::open("/dev/urandom")?.read_exact(bytes)
}

#[cfg(test)]
mod test;
