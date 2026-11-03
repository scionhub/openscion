//! `scn bisect` over the first-parent changeset chain.
//!
//! State lives in `.scn/bisect`. Each step checks a candidate out into the
//! working copy.

use std::path::Path;
use std::process::Command;

use openscion_core::ObjectId;
use serde::{Deserialize, Serialize};

use super::branch::repo_client;
use super::clone::{checkout_changeset, resolve_checkout};
use crate::workcopy::{self, STATE_DIR};
use crate::{Error, Result};

/// What a step learned about the current candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mark {
    /// The candidate is good (the bug is newer).
    Good,
    /// The candidate is bad (the bug is here or older).
    Bad,
    /// Skip this candidate.
    Skip,
}

/// Persisted bisect range. `steps` is oldest to newest, after good through bad.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct BisectState {
    /// Changeset to restore on `reset`.
    pub original: String,
    /// Upstream ref to restore on `reset`.
    pub upstream: String,
    /// Last known-good changeset.
    pub good: String,
    /// Last known-bad changeset.
    pub bad: String,
    /// Candidates, oldest first.
    pub steps: Vec<String>,
    /// Inclusive index of the oldest remaining candidate.
    pub low: usize,
    /// Inclusive index of the newest remaining candidate.
    pub high: usize,
    /// Candidates the user skipped.
    pub skipped: Vec<String>,
    /// Candidate currently checked out.
    pub current: Option<String>,
}

/// The next checkout, and the first bad commit when the range has collapsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Advance {
    /// Updated state.
    pub state: BisectState,
    /// Set when one commit remains.
    pub found: Option<String>,
    /// Changeset to check out. `None` when there is nothing new to test.
    pub checkout: Option<String>,
}

/// First-parent commits after `good` through `bad`, oldest first.
pub(crate) fn first_parent_range(
    bad: &str,
    good: &str,
    mut parent_of: impl FnMut(&str) -> Option<String>,
) -> Result<Vec<String>> {
    if bad == good {
        return Err(Error::BisectRange);
    }
    let mut newest_first = Vec::new();
    let mut id = bad.to_owned();
    for _ in 0..100_000 {
        if id == good {
            newest_first.reverse();
            return if newest_first.is_empty() {
                Err(Error::BisectRange)
            } else {
                Ok(newest_first)
            };
        }
        newest_first.push(id.clone());
        let Some(parent) = parent_of(&id) else {
            return Err(Error::BisectRange);
        };
        id = parent;
    }
    Err(Error::BisectRange)
}

/// Opens a bisect on `steps` and picks the first candidate.
#[must_use]
pub(crate) fn open(
    original: &str,
    upstream: &str,
    good: &str,
    bad: &str,
    steps: Vec<String>,
) -> Advance {
    let high = steps.len().saturating_sub(1);
    let mut state = BisectState {
        original: original.to_owned(),
        upstream: upstream.to_owned(),
        good: good.to_owned(),
        bad: bad.to_owned(),
        steps,
        low: 0,
        high,
        skipped: Vec::new(),
        current: None,
    };
    pick(&mut state)
}

/// Narrows the range and chooses the next candidate.
pub(crate) fn advance(mut state: BisectState, mark: Mark) -> Result<Advance> {
    let current = state.current.clone().ok_or(Error::NotBisecting)?;
    let index = state
        .steps
        .iter()
        .position(|step| step == &current)
        .ok_or(Error::BisectExhausted)?;
    match mark {
        Mark::Good => {
            state.good.clone_from(&current);
            state.low = index + 1;
        }
        Mark::Bad => {
            state.bad.clone_from(&current);
            state.high = index;
        }
        Mark::Skip => {
            if !state.skipped.contains(&current) {
                state.skipped.push(current);
            }
        }
    }
    if state.low > state.high {
        return Err(Error::BisectRange);
    }
    Ok(pick(&mut state))
}

fn pick(state: &mut BisectState) -> Advance {
    if state.low == state.high {
        let id = state.steps[state.low].clone();
        if state.skipped.iter().any(|skipped| skipped == &id) {
            state.current = None;
            return Advance {
                state: state.clone(),
                found: None,
                checkout: None,
            };
        }
        state.current = Some(id.clone());
        return Advance {
            state: state.clone(),
            found: Some(id.clone()),
            checkout: Some(id),
        };
    }
    let Some(index) = unskipped(state) else {
        state.current = None;
        return Advance {
            state: state.clone(),
            found: None,
            checkout: None,
        };
    };
    let id = state.steps[index].clone();
    state.current = Some(id.clone());
    Advance {
        state: state.clone(),
        found: None,
        checkout: Some(id),
    }
}

fn unskipped(state: &BisectState) -> Option<usize> {
    let mid = state.low + (state.high - state.low) / 2;
    if !state.skipped.iter().any(|id| id == &state.steps[mid]) {
        return Some(mid);
    }
    let span = state.high - state.low;
    for delta in 1..=span {
        let newer = mid + delta;
        if newer <= state.high && !state.skipped.iter().any(|id| id == &state.steps[newer]) {
            return Some(newer);
        }
        if mid >= state.low + delta {
            let older = mid - delta;
            if !state.skipped.iter().any(|id| id == &state.steps[older]) {
                return Some(older);
            }
        }
    }
    None
}

fn bisect_path(root: &Path) -> std::path::PathBuf {
    root.join(STATE_DIR).join("bisect")
}

fn load_state(root: &Path) -> Result<BisectState> {
    let path = bisect_path(root);
    let text = std::fs::read_to_string(&path).map_err(|_| Error::NotBisecting)?;
    serde_json::from_str(&text).map_err(|error| Error::BadState {
        path,
        message: error.to_string(),
    })
}

fn save_state(root: &Path, state: &BisectState) -> Result<()> {
    let path = bisect_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(workcopy::io_error(parent))?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|error| Error::BadState {
        path: path.clone(),
        message: error.to_string(),
    })?;
    std::fs::write(&path, text).map_err(workcopy::io_error(&path))
}

fn parent_chain(client: &crate::RepoClient, bad: ObjectId, good: ObjectId) -> Result<Vec<String>> {
    first_parent_range(&bad.to_string(), &good.to_string(), |id| {
        let Ok(parsed) = id.parse::<ObjectId>() else {
            return None;
        };
        client
            .changeset(parsed)
            .ok()
            .and_then(|record| record.changeset.parents.first().map(ToString::to_string))
    })
}

/// Starts a bisect and checks out the first candidate.
pub(crate) fn start(root: &Path, bad: &str, good: &str, token: Option<String>) -> Result<Advance> {
    if bisect_path(root).exists() {
        return Err(Error::BisectInProgress);
    }
    let (state, client) = repo_client(root, token)?;
    let (_, bad_id) = resolve_checkout(&client, bad)?;
    let (_, good_id) = resolve_checkout(&client, good)?;
    let steps = parent_chain(&client, bad_id, good_id)?;
    let opened = open(
        &state.base.to_string(),
        &state.upstream_ref(),
        &good_id.to_string(),
        &bad_id.to_string(),
        steps,
    );
    if opened.checkout.is_none() && opened.found.is_none() {
        return Err(Error::BisectExhausted);
    }
    if let Some(id) = opened.checkout.as_deref() {
        let parsed = id.parse::<ObjectId>().map_err(|_| Error::BisectRange)?;
        checkout_changeset(&client, root, parsed)?;
    }
    save_state(root, &opened.state)?;
    Ok(opened)
}

/// Records `mark` and checks out the next candidate.
pub(crate) fn mark(root: &Path, mark: Mark, token: Option<String>) -> Result<Advance> {
    let state = load_state(root)?;
    let advanced = advance(state, mark)?;
    if advanced.checkout.is_none() && advanced.found.is_none() {
        return Err(Error::BisectExhausted);
    }
    let (_state, client) = repo_client(root, token)?;
    if let Some(id) = advanced.checkout.as_deref() {
        let parsed = id.parse::<ObjectId>().map_err(|_| Error::BisectRange)?;
        checkout_changeset(&client, root, parsed)?;
    }
    save_state(root, &advanced.state)?;
    Ok(advanced)
}

/// Checks out the original changeset and deletes `.scn/bisect`.
pub(crate) fn reset(root: &Path, token: Option<String>) -> Result<String> {
    let state = load_state(root)?;
    let (_loaded, client) = repo_client(root, token)?;
    let id = state
        .original
        .parse::<ObjectId>()
        .map_err(|_| Error::BisectRange)?;
    checkout_changeset(&client, root, id)?;
    let mut working = workcopy::load(root)?;
    working.set_tracking(openscion_core::short_ref(&state.upstream), &state.upstream);
    workcopy::save(root, &mut working)?;
    let path = bisect_path(root);
    std::fs::remove_file(&path).map_err(workcopy::io_error(&path))?;
    Ok(state.original)
}

/// Repeats checkout and `cmd` until the first bad commit is found.
///
/// Exit 0 is good, 125 is skip, 128 or higher aborts, and any other code is bad.
pub(crate) fn run(root: &Path, cmd: &[String], token: Option<&str>) -> Result<String> {
    let program = cmd.first().ok_or_else(|| {
        Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "bisect run needs a command",
        })
    })?;
    loop {
        let state = load_state(root)?;
        if state.low == state.high
            && let Some(found) = &state.current
            && state.steps.get(state.low) == Some(found)
        {
            return Ok(found.clone());
        }
        let status = Command::new(program)
            .args(&cmd[1..])
            .current_dir(root)
            .status()
            .map_err(workcopy::io_error(root))?;
        let code = status.code().unwrap_or(1);
        if code >= 128 {
            return Err(Error::BisectAbort(code));
        }
        let mark = if code == 0 {
            Mark::Good
        } else if code == 125 {
            Mark::Skip
        } else {
            Mark::Bad
        };
        let advanced = mark_with(root, mark, token.map(str::to_owned))?;
        if let Some(found) = advanced.found {
            return Ok(found);
        }
    }
}

fn mark_with(root: &Path, which: Mark, token: Option<String>) -> Result<Advance> {
    mark(root, which, token)
}

#[cfg(test)]
mod test;
