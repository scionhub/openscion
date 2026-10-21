//! The working-copy state types.

use std::collections::BTreeMap;

use openscion_core::{EntryKind, ObjectId};
use serde::{Deserialize, Serialize};

/// What `opnscn` remembers about a working copy, in `.opnscn/state.json`.
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
    /// The ref commits move.
    pub(crate) ref_name: String,
    /// The changeset the files on disk were last synced with.
    pub(crate) base: ObjectId,
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
