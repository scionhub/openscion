//! `scn remote`: named remotes in the working copy.

use std::path::Path;

use crate::remote::{self, RepoUrl};
use crate::workcopy::{self, Remote};
use crate::{Error, Result};

/// Remotes in `root`, after migrating a single-server state to `origin`.
///
/// # Errors
///
/// Returns [`Error::NotAWorkingCopy`] when `root` has no state file.
pub(crate) fn list(root: &Path) -> Result<Vec<Remote>> {
    let mut state = workcopy::load(root)?;
    state.ensure_origin();
    Ok(state.remotes)
}

/// Adds `name` pointing at `url`.
///
/// # Errors
///
/// Returns [`Error::InvalidRemoteName`] when the name is empty or already
/// used, and [`Error::Engine`] when `url` is not a repository URL.
pub(crate) fn add(root: &Path, name: &str, url: &str) -> Result<Remote> {
    let mut state = workcopy::load(root)?;
    check_name(name)?;
    if state.remote(name).is_some() {
        return Err(Error::InvalidRemoteName(name.to_owned()));
    }
    let remote = remote_from_url(name, url)?;
    state.remotes.push(remote.clone());
    workcopy::save(root, &mut state)?;
    Ok(remote)
}

/// Removes `name`.
///
/// # Errors
///
/// Returns [`Error::UnknownRemote`] when `name` is not configured.
pub(crate) fn remove(root: &Path, name: &str) -> Result<()> {
    let mut state = workcopy::load(root)?;
    if state.remote(name).is_none() {
        return Err(Error::UnknownRemote(name.to_owned()));
    }
    state.remotes.retain(|remote| remote.name != name);
    state.remote_tips.remove(name);
    if state.upstream_remote.as_deref() == Some(name) {
        state.upstream_remote = state.remotes.first().map(|remote| remote.name.clone());
    }
    workcopy::save(root, &mut state)?;
    Ok(())
}

/// Renames a remote and its remembered tips.
///
/// # Errors
///
/// Returns [`Error::UnknownRemote`] or [`Error::InvalidRemoteName`].
pub(crate) fn rename(root: &Path, from: &str, to: &str) -> Result<()> {
    let mut state = workcopy::load(root)?;
    check_name(to)?;
    if state.remote(from).is_none() {
        return Err(Error::UnknownRemote(from.to_owned()));
    }
    if from != to && state.remote(to).is_some() {
        return Err(Error::InvalidRemoteName(to.to_owned()));
    }
    if let Some(remote) = state.remote_mut(from) {
        to.clone_into(&mut remote.name);
    }
    if let Some(tips) = state.remote_tips.remove(from) {
        state.remote_tips.insert(to.to_owned(), tips);
    }
    if state.upstream_remote.as_deref() == Some(from) {
        state.upstream_remote = Some(to.to_owned());
    }
    workcopy::save(root, &mut state)?;
    Ok(())
}

/// Points `name` at a new URL.
///
/// # Errors
///
/// Returns [`Error::UnknownRemote`] when `name` is not configured.
pub(crate) fn set_url(root: &Path, name: &str, url: &str) -> Result<Remote> {
    let mut state = workcopy::load(root)?;
    if state.remote(name).is_none() {
        return Err(Error::UnknownRemote(name.to_owned()));
    }
    let updated = remote_from_url(name, url)?;
    if let Some(remote) = state.remote_mut(name) {
        *remote = updated.clone();
    }
    if name == "origin" {
        state.server.clone_from(&updated.server);
        state.repo.clone_from(&updated.repo);
    }
    workcopy::save(root, &mut state)?;
    Ok(updated)
}

fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.contains([' ', '\t', '/']) {
        return Err(Error::InvalidRemoteName(name.to_owned()));
    }
    Ok(())
}

fn remote_from_url(name: &str, url: &str) -> Result<Remote> {
    let spec: RepoUrl = remote::parse_repo_url(url)?;
    let server = match &spec.origin {
        Some(origin) => remote::discover_api_base(origin),
        None => {
            return Err(Error::Engine(openscion_core::Error::InvalidChange {
                path: "cli".to_owned(),
                rule: "remote url must name a host, as host/org/repo or https://host/org/repo",
            }));
        }
    };
    let mut remote = Remote::new(name, server, spec.repo_path());
    remote.url = Some(url.to_owned());
    Ok(remote)
}
