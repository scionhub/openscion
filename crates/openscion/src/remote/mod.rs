//! Clone URLs and API-base discovery.
//!
//! `org/repo` uses the default server. `host[:port]/org/repo` and
//! `https://host/org/repo` name a server. The client asks that origin for
//! `GET /.well-known/scionbase` and uses `api_base` when the document is
//! present; otherwise it uses the origin itself (`https://` when the user
//! omitted a scheme).

use crate::{Error, Result};

/// A repository locator parsed from a clone or remote URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RepoUrl {
    /// Scheme and authority to discover, when the user named a server.
    pub(crate) origin: Option<String>,
    /// Organization name.
    pub(crate) org: String,
    /// Repository name, without a trailing `.git`.
    pub(crate) repo: String,
}

impl RepoUrl {
    /// `<org>/<repo>`.
    #[must_use]
    pub(crate) fn repo_path(&self) -> String {
        format!("{}/{}", self.org, self.repo)
    }
}

/// Parses `org/repo`, `host[:port]/org/repo`, or an `http(s)` URL.
///
/// # Errors
///
/// Returns [`Error::Engine`] when the input is not one of those shapes.
pub(crate) fn parse_repo_url(input: &str) -> Result<RepoUrl> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err(bad_url());
    }
    if let Some(rest) = input.strip_prefix("https://") {
        return parse_absolute("https", rest);
    }
    if let Some(rest) = input.strip_prefix("http://") {
        return parse_absolute("http", rest);
    }
    let parts: Vec<&str> = input.split('/').filter(|part| !part.is_empty()).collect();
    match parts.as_slice() {
        [org, repo] => Ok(RepoUrl {
            origin: None,
            org: (*org).to_owned(),
            repo: strip_git(repo),
        }),
        [host, org, repo] => Ok(RepoUrl {
            origin: Some(format!("https://{host}")),
            org: (*org).to_owned(),
            repo: strip_git(repo),
        }),
        _ => Err(bad_url()),
    }
}

fn parse_absolute(scheme: &str, rest: &str) -> Result<RepoUrl> {
    let (authority, path) = rest.split_once('/').ok_or_else(bad_url)?;
    let authority = authority.split('@').next_back().unwrap_or(authority);
    if authority.is_empty() || authority.contains('/') {
        return Err(bad_url());
    }
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() != 2 {
        return Err(bad_url());
    }
    Ok(RepoUrl {
        origin: Some(format!("{scheme}://{authority}")),
        org: parts[0].to_owned(),
        repo: strip_git(parts[1]),
    })
}

fn strip_git(name: &str) -> String {
    name.strip_suffix(".git").unwrap_or(name).to_owned()
}

fn bad_url() -> Error {
    Error::Engine(openscion_core::Error::InvalidChange {
        path: "cli".to_owned(),
        rule: "repository must be org/repo, host[:port]/org/repo, or https://host/org/repo",
    })
}

/// Asks `origin` for `/.well-known/scionbase` and returns `api_base`.
///
/// Any failure, including a non-success status, falls back to `origin`.
#[must_use]
pub(crate) fn discover_api_base(origin: &str) -> String {
    let origin = origin.trim_end_matches('/').to_owned();
    let url = format!("{origin}/.well-known/scionbase");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let Ok(response) = agent.get(&url).call() else {
        return origin;
    };
    if !response.status().is_success() {
        return origin;
    }
    let Ok(value) = response
        .into_body()
        .with_config()
        .limit(1_048_576)
        .read_json::<serde_json::Value>()
    else {
        return origin;
    };
    value
        .get("api_base")
        .and_then(serde_json::Value::as_str)
        .map(|base| base.trim_end_matches('/').to_owned())
        .filter(|base| !base.is_empty())
        .unwrap_or(origin)
}

/// Resolves a user-typed server (host, `host:port`, or URL) to an API base.
#[must_use]
pub(crate) fn resolve_server(input: &str) -> String {
    let input = input.trim().trim_end_matches('/');
    let origin = if let Some(rest) = input.strip_prefix("https://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        format!("https://{authority}")
    } else if let Some(rest) = input.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        format!("http://{authority}")
    } else {
        format!("https://{input}")
    };
    discover_api_base(&origin)
}

#[cfg(test)]
mod test;
