//! `scn`, the ScionBase command-line client.
//!
//! In the full design (`docs/specs/openscion-architecture.md`) `scn` lays out
//! a sparse working copy, watches it for edits, uploads blobs, and wraps the
//! server's history and landing APIs. Today it implements:
//!
//! | Command | What it does |
//! | --- | --- |
//! | `scn version` | prints the client and protocol versions |
//! | `scn server-info` | asks the server for its version and checks the protocol binds |
//! | `scn signup --username U` | creates an account and stores a token |
//! | `scn login --user U` | authenticates and stores a token |
//! | `scn import [DIR]` | records a directory as the first changeset and creates `main` (skips `.git` / nested checkouts unless `--allow-vcs`) |
//! | `scn commit -m MSG [--ref REF]` | records what changed and moves a ref by compare-and-swap |
//! | `scn merge REF` | three-way merge another ref into the working copy |
//! | `scn pull` | merge the tracked upstream into the working copy |
//! | `scn push [-m MSG]` | commit if needed and publish the current branch |
//! | `scn repo create NAME` | create a repository in your user namespace or an org |
//! | `scn org create\|list` | create or list organizations |
//! | `scn branch` | list remote branches; `new` / `switch` / `delete` manage them |
//! | `scn pr create\|list\|show\|merge\|close` | pull requests |
//! | `scn clone ORG/REPO [DIR]` | fetches a snapshot into a new working copy |
//! | `scn completion bash\|zsh\|fish` | prints a shell completion script |
//!
//! A working copy keeps its state in `.scn/state.json`: the server, the ref,
//! the base changeset, and each file's blob id and stat data, so a commit
//! re-reads only files whose size or modification time changed. Older working
//! copies in `.opnscn/` are still read.
//!
//! Every command that talks to a server takes `--server <url>` or the
//! `SCN_SERVER` environment variable (falling back to `OPENSCION_SERVER`),
//! defaulting to [`DEFAULT_SERVER`].
//!
//! # Example
//!
//! ```
//! use clap::Parser;
//! use openscion::{Cli, run};
//!
//! let cli = Cli::parse_from(["scn", "version"]);
//! let mut out = Vec::new();
//! run(&cli, &mut out)?;
//! assert!(String::from_utf8(out).unwrap().starts_with("scn "));
//! # Ok::<(), openscion::Error>(())
//! ```

mod cli;
mod client;
mod commands;
mod error;
#[cfg(test)]
mod test_support;
mod workcopy;

pub use cli::{
    BranchCommand, Cli, Command, CompletionShell, DEFAULT_AUTHOR, DEFAULT_REF, DEFAULT_SERVER,
    OrgCommand, PrCommand, RepoCommand, UploadWalkArgs, run,
};
pub use client::{RepoClient, ServerClient};
pub use error::{Error, Result};
