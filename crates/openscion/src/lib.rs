//! `opnscn`, the OpenScion command-line client.
//!
//! In the full design (`docs/specs/openscion-architecture.md`) `opnscn` lays out
//! a sparse working copy, watches it for edits, uploads blobs, and wraps the
//! server's history and landing APIs. Today it implements:
//!
//! | Command | What it does |
//! | --- | --- |
//! | `opnscn version` | prints the client and protocol versions |
//! | `opnscn server-info` | asks the server for its version and checks the protocol binds |
//! | `opnscn import [DIR]` | records a directory as the first changeset and creates `main` |
//! | `opnscn commit -m MSG` | records what changed and moves `main` by compare-and-swap |
//! | `opnscn clone DEST [--path DIR]` | fetches a snapshot, or one directory of it |
//!
//! A working copy keeps its state in `.opnscn/state.json`: the server, the ref,
//! the base changeset, and each file's blob id and stat data, so a commit
//! re-reads only files whose size or modification time changed.
//!
//! Every command that talks to a server takes `--server <url>` or the
//! `OPENSCION_SERVER` environment variable. When neither is set, it defaults
//! to the hosted ScionBase API at [`DEFAULT_SERVER`].
//!
//! # Example
//!
//! ```
//! use clap::Parser;
//! use openscion::{Cli, run};
//!
//! let cli = Cli::parse_from(["opnscn", "version"]);
//! let mut out = Vec::new();
//! run(&cli, &mut out)?;
//! assert!(String::from_utf8(out).unwrap().starts_with("opnscn "));
//! # Ok::<(), openscion::Error>(())
//! ```

mod cli;
mod client;
mod commands;
mod error;
#[cfg(test)]
mod test_support;
mod workcopy;

pub use cli::{Cli, Command, DEFAULT_AUTHOR, DEFAULT_REF, DEFAULT_SERVER, run};
pub use client::ServerClient;
pub use error::{Error, Result};
