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
/// `.gitignore` matching is always on and is independent of this flag.
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

/// How a path differs from the recorded working-copy base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChangeKind {
    /// On disk and not in the recorded snapshot.
    Added,
    /// On disk with different bytes or kind than the snapshot.
    Modified,
    /// In the snapshot and missing from disk.
    Deleted,
}

impl ChangeKind {
    /// The lowercase word printed by `scn status` and commit previews.
    #[must_use]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }
}

/// One path that would be recorded by the next commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PathChange {
    /// Repository path, `/`-separated.
    pub(crate) path: String,
    /// Added, modified, or deleted.
    pub(crate) kind: ChangeKind,
}

/// Working-copy changes versus the recorded base, after `.gitignore` and VCS skip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StatusReport {
    /// Short local branch name.
    pub(crate) branch: String,
    /// Remote ref this working copy pushes to.
    pub(crate) upstream: String,
    /// Paths not in the recorded snapshot.
    pub(crate) added: Vec<String>,
    /// Paths whose contents or kind changed.
    pub(crate) modified: Vec<String>,
    /// Recorded paths that are gone from disk.
    pub(crate) deleted: Vec<String>,
    /// Scanned paths that still match the snapshot.
    pub(crate) unchanged: usize,
}

impl StatusReport {
    /// Whether there are no added, modified, or deleted paths.
    #[must_use]
    pub(crate) fn is_clean(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.deleted.is_empty()
    }

    /// Added + modified + deleted.
    #[must_use]
    pub(crate) fn change_count(&self) -> usize {
        self.added.len() + self.modified.len() + self.deleted.len()
    }

    /// Every changed path, added then modified then deleted, each group sorted.
    #[must_use]
    pub(crate) fn changes(&self) -> Vec<PathChange> {
        let mut out = Vec::with_capacity(self.change_count());
        out.extend(self.added.iter().cloned().map(|path| PathChange {
            path,
            kind: ChangeKind::Added,
        }));
        out.extend(self.modified.iter().cloned().map(|path| PathChange {
            path,
            kind: ChangeKind::Modified,
        }));
        out.extend(self.deleted.iter().cloned().map(|path| PathChange {
            path,
            kind: ChangeKind::Deleted,
        }));
        out
    }
}

/// An added or modified file whose bytes have already been read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingFile {
    /// Repository path, `/`-separated.
    pub(crate) path: String,
    /// Added versus modified.
    pub(crate) change: ChangeKind,
    /// File, executable, or symlink as scanned.
    pub(crate) kind: EntryKind,
    /// Content hash.
    pub(crate) blob: ObjectId,
    /// File bytes (or symlink target).
    pub(crate) bytes: Vec<u8>,
    /// Size and mtime from the scan.
    pub(crate) scanned: Scanned,
}

/// Full working-copy delta used by status, commit preview, and stash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingChanges {
    /// Summary printed by `scn status`.
    pub(crate) report: StatusReport,
    /// Added and modified files, with contents.
    pub(crate) upserts: Vec<PendingFile>,
    /// Recorded paths that are gone from disk.
    pub(crate) deleted: Vec<String>,
}
