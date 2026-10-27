//! The working-copy state types.

use std::collections::BTreeMap;

use openscion_core::{EntryKind, ObjectId};
use serde::{Deserialize, Serialize};

/// How a working-copy walk treats VCS metadata and nested checkouts.
///
/// The default skips `.git` (and similar) at every depth and does not
/// recurse into a nested directory that contains a `.git` file or
/// directory. That matches git's habit of not adding a submodule's working
/// tree as ordinary files of the parent. [`Self::allow_vcs`] opts back in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ScanOptions {
    /// Include VCS metadata and nested git checkout contents.
    pub(crate) allow_vcs: bool,
}

/// What `scn` remembers about a working copy, in `.scn/state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct State {
    /// The server the working copy came from.
    pub(crate) server: String,
    /// The repository `<org>/<repo>` this working copy is tied to.
    ///
    /// Added with multi-repo support; older states deserialize with the
    /// default value `"local/default"`.
    #[serde(default = "default_repo")]
    pub(crate) repo: String,
    /// The ref commits move. Same as [`Self::upstream`] when that is set;
    /// kept so older working copies still deserialize.
    pub(crate) ref_name: String,
    /// Local branch name (short), such as `feature` or `users/alice/feature`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    /// Remote ref this branch tracks, such as `refs/heads/main`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) upstream: Option<String>,
    /// The changeset the files on disk were last synced with.
    pub(crate) base: ObjectId,
    /// When set, the next commit's first parent is this changeset (the
    /// `--from` tip of a sync) so a pull-request merge can fast-forward.
    /// Compare-and-swap of the working copy's ref still expects [`Self::base`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sync_onto: Option<ObjectId>,
    /// The directory a sparse clone was limited to, if any.
    pub(crate) sparse: Option<String>,
    /// When the state was written, in nanoseconds since the Unix epoch. A
    /// file modified at or after this instant cannot be trusted from its stat
    /// data alone, the same "racily clean" rule git applies to its index.
    pub(crate) written_at: u64,
    /// Every tracked file, by path.
    pub(crate) files: BTreeMap<String, FileState>,
}

fn default_repo() -> String {
    "local/default".to_owned()
}

impl State {
    /// Short local branch name, derived from [`Self::ref_name`] when unset.
    #[must_use]
    pub(crate) fn branch_name(&self) -> String {
        self.branch
            .clone()
            .unwrap_or_else(|| openscion_core::short_ref(&self.ref_name))
    }

    /// Remote ref this working copy pushes to.
    #[must_use]
    pub(crate) fn upstream_ref(&self) -> String {
        self.upstream
            .clone()
            .unwrap_or_else(|| self.ref_name.clone())
    }

    /// Records the current branch and the remote ref it tracks.
    pub(crate) fn set_tracking(&mut self, branch: impl Into<String>, upstream: impl Into<String>) {
        let branch = branch.into();
        let upstream = upstream.into();
        self.branch = Some(branch);
        self.ref_name.clone_from(&upstream);
        self.upstream = Some(upstream);
    }
}

/// One tracked file: its content id and the stat data that lets a scan skip
/// re-hashing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileState {
    /// File, executable, or symlink.
    pub(crate) kind: EntryKind,
    /// The blob holding its contents.
    pub(crate) blob: ObjectId,
    /// Its size in bytes when last hashed.
    pub(crate) size: u64,
    /// Its modification time when last hashed, in nanoseconds since the epoch.
    pub(crate) mtime: u64,
}

/// A file found on disk by a scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Scanned {
    /// The path relative to the working-copy root, `/`-separated.
    pub(crate) path: String,
    /// File, executable, or symlink.
    pub(crate) kind: EntryKind,
    /// Its size in bytes.
    pub(crate) size: u64,
    /// Its modification time, in nanoseconds since the epoch.
    pub(crate) mtime: u64,
}
