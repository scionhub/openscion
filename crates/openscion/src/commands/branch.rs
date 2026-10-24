//! Branch list, create, switch, and delete.

use std::path::Path;

use openscion_core::{branch_upstream, short_ref};

use super::clone;
use crate::workcopy::{self, State};
use crate::{Error, RepoClient, Result, ServerClient};

/// Lists remote branches. The current working-copy branch is marked by the CLI.
pub(crate) fn list(
    root: &Path,
    token: Option<String>,
) -> Result<(String, Vec<crate::client::BranchInfo>)> {
    let (state, client) = repo_client(root, token)?;
    Ok((state.branch_name(), client.list_branches()?))
}

/// Creates a local branch from `from` (current upstream when `None`) and
/// switches to it. The remote ref is not created until `scn push`.
pub(crate) fn create(
    root: &Path,
    name: &str,
    from: Option<&str>,
    token: Option<String>,
    username: &str,
    member: bool,
) -> Result<(String, String)> {
    let mut state = workcopy::load(root)?;
    let from = from.unwrap_or(&state.ref_name).to_owned();
    let upstream = branch_upstream(name, username, member);
    let branch = short_ref(name);
    if from == state.ref_name || from == state.branch_name() || from == state.upstream_ref() {
        state.set_tracking(&branch, &upstream);
        workcopy::save(root, &mut state)?;
        return Ok((branch, upstream));
    }
    let client = client_for(&state, token)?;
    clone::checkout(&client, root, &from, Some(&branch), Some(&upstream))?;
    Ok((branch, upstream))
}

/// Switches the working copy to `name` by fetching that ref's snapshot.
pub(crate) fn switch(root: &Path, name: &str, token: Option<String>) -> Result<String> {
    let state = workcopy::load(root)?;
    if short_ref(name) == state.branch_name() || name == state.upstream_ref() {
        return Ok(state.branch_name());
    }
    let client = client_for(&state, token)?;
    clone::checkout(&client, root, name, Some(&short_ref(name)), None)?;
    Ok(short_ref(name))
}

/// Deletes `name` on the server. Refuses if it is the current branch.
pub(crate) fn delete(root: &Path, name: &str, token: Option<String>) -> Result<String> {
    let state = workcopy::load(root)?;
    if short_ref(name) == state.branch_name() {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "cannot delete the current branch; switch first",
        }));
    }
    let client = client_for(&state, token)?;
    let deleted = client.delete_ref(name)?;
    Ok(deleted
        .get("deleted")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(name)
        .to_owned())
}

pub(crate) fn repo_client(root: &Path, token: Option<String>) -> Result<(State, RepoClient)> {
    let state = workcopy::load(root)?;
    let client = client_for(&state, token)?;
    Ok((state, client))
}

fn client_for(state: &State, token: Option<String>) -> Result<RepoClient> {
    let (org, repo) = state.repo.split_once('/').ok_or_else(|| Error::BadState {
        path: Path::new(".").join(workcopy::STATE_DIR).join("state.json"),
        message: "missing repo in state".to_owned(),
    })?;
    Ok(ServerClient::new(&state.server)
        .with_token(token)
        .repo(org, repo))
}

/// Whether the logged-in user can write as a member of `org`.
pub(crate) fn org_is_member(
    server: &str,
    org: &str,
    username: &str,
    token: Option<String>,
) -> bool {
    let client = ServerClient::new(server).with_token(token);
    match client.org_membership(org) {
        Ok(info) => info.member || info.admin,
        Err(_) => org == username,
    }
}
