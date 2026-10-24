//! Crate-wide error and result types for the client.

use std::path::PathBuf;

use openscion_core::PROTOCOL_VERSION;

/// Errors returned by `scn`.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// The server could not be reached, or answered with an error status and
    /// no error body.
    #[error("request to {url} failed: {message}")]
    Request {
        /// The URL that was requested.
        url: String,
        /// What went wrong, as reported by the HTTP client.
        message: String,
    },
    /// The server answered, but not with the payload the protocol defines.
    #[error("unexpected response from {url}: {message}")]
    Decode {
        /// The URL that was requested.
        url: String,
        /// Why the body could not be decoded.
        message: String,
    },
    /// The server speaks a protocol version this client cannot bind to.
    #[error(
        "server speaks protocol {}.{}, which this client ({}.{}) cannot use",
        server.0, server.1, PROTOCOL_VERSION.0, PROTOCOL_VERSION.1
    )]
    IncompatibleProtocol {
        /// The server's protocol version.
        server: (u32, u32),
    },
    /// The server rejected a request and said why.
    #[error("{url} answered {status} {code}: {message}")]
    Server {
        /// The URL that was requested.
        url: String,
        /// The HTTP status.
        status: u16,
        /// The error code, such as `RefConflict`.
        code: String,
        /// The server's explanation.
        message: String,
    },
    /// The engine rejected local data: a bad path, or an object whose bytes
    /// do not match its id.
    #[error(transparent)]
    Engine(#[from] openscion_core::Error),
    /// A file in the working copy could not be read or written.
    #[error("{}: {source}", path.display())]
    Io {
        /// The file or directory involved.
        path: PathBuf,
        /// The underlying failure.
        #[source]
        source: std::io::Error,
    },
    /// A file name in the working copy is not UTF-8.
    #[error("{} is not a UTF-8 path", .0.display())]
    NonUtf8Path(PathBuf),
    /// The directory is not a `scn` working copy.
    #[error("{} is not a scn working copy (no .scn/state.json)", .0.display())]
    NotAWorkingCopy(PathBuf),
    /// The directory is already a `scn` working copy, or is not empty.
    #[error("{} already holds a working copy or other files", .0.display())]
    AlreadyExists(PathBuf),
    /// The working copy's state file is not valid.
    #[error("{}: corrupt working-copy state: {message}", path.display())]
    BadState {
        /// The state file.
        path: PathBuf,
        /// Why it could not be read.
        message: String,
    },
    /// `scn commit` found no changes.
    #[error("nothing to commit")]
    NothingToCommit,
    /// `scn push` has local changes and needs a message.
    #[error("local changes require a commit message: pass -m")]
    CommitMessageRequired,
    /// `scn branch switch` refuses to overwrite uncommitted edits.
    #[error("working copy has local changes; commit or discard them first")]
    DirtyWorkingCopy,
    /// Working copy still has unresolved conflict markers.
    #[error("unresolved conflicts in {count} files")]
    UnresolvedConflicts {
        /// How many files still contain `<<<<<<< local` markers.
        count: usize,
    },
    /// `scn sync` wrote conflict markers that must be resolved.
    #[error("sync left {count} conflicted files")]
    SyncConflicts {
        /// How many paths were written with conflict markers.
        count: usize,
    },
    /// Writing command output failed.
    #[error("cannot write output: {0}")]
    Output(#[source] std::io::Error),
}

impl From<openscion_core::PathError> for Error {
    fn from(error: openscion_core::PathError) -> Self {
        Self::Engine(error.into())
    }
}

/// The client's standard result type.
pub type Result<T> = std::result::Result<T, Error>;
