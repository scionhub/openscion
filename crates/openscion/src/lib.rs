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
//! | `scn login [HOST] --user U` | authenticates and stores a token for that host |
//! | `scn import [DIR]` | records a directory as the first changeset and creates `main` (honors `.gitignore`; skips `.git` / nested checkouts unless `--allow-vcs`) |
//! | `scn status` | shows working-copy changes versus the recorded base |
//! | `scn diff` | lists added / modified / deleted paths (same scan as status) |
//! | `scn commit -m MSG [--dry-run]` | records what changed and moves a ref by compare-and-swap |
//! | `scn stash` | local stash of uncommitted changes (`.scn/stash/`, not server CAS) |
//! | `scn cherry-pick REF` | apply one commit's tree onto the working copy |
//! | `scn merge REF` | three-way merge another ref into the working copy |
//! | `scn pull [REMOTE] [BRANCH]` | merge a remote branch into the working copy |
//! | `scn fetch [REMOTE] [BRANCH]` | remember a remote tip without changing files |
//! | `scn push [REMOTE] [BRANCH]` | commit if needed and publish; cross-server pushes send missing pieces |
//! | `scn remote` | add, remove, rename, list, or retarget remotes |
//! | `scn repo create NAME` | create a repository in your user namespace or an org |
//! | `scn org create\|list` | create or list organizations |
//! | `scn branch` | list remote branches; `new` / `switch` / `delete` manage them |
//! | `scn pr create\|list\|show\|merge\|close` | pull requests |
//! | `scn issue create\|list\|show\|close\|reopen` | issues |
//! | `scn board create\|list\|show\|delete` | org-owned issue boards |
//! | `scn clone ORG/REPO` or `HOST/ORG/REPO` | fetches a snapshot; a host is discovered via `/.well-known/scionbase` |
//! | `scn log [PATH]` | paginated changeset history (`-n`, `--author`, `--since`, `--until`, `--grep`) |
//! | `scn blame PATH` | last changeset on each line |
//! | `scn show CHANGESET` | one changeset and its unified diff |
//! | `scn tag NAME [-m MSG]` | create a tag; `-l` lists, `-d NAME` deletes |
//! | `scn checkout NAME` | check out a branch, tag, or changeset |
//! | `scn hook add\|list\|remove` | server webhooks (`push`, `pr_opened`, `pr_updated`, `pr_merged`, `tag`) |
//! | `scn bisect start BAD GOOD` | first-parent search; state in `.scn/bisect` |
//! | `scn submodule add\|update\|status\|sync` | pins in `.scnmodules`; `clone --recursive` checks them out |
//! | `scn completion bash\|zsh\|fish` | prints a shell completion script |
//!
//! A working copy keeps its state in `.scn/state.json`: the server, named
//! remotes, the ref, the base changeset, and each file's blob id and stat
//! data, so a commit re-reads only files whose size or modification time
//! changed. Older single-server states become an `origin` remote on load.
//! Older working copies in `.opnscn/` are still read.
//!
//! `org/repo` uses [`DEFAULT_SERVER`]. `host[:port]/org/repo` and
//! `https://host/org/repo` name a server. `--server <url>` overrides the
//! default for commands that do not name a host.
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
mod remote;
#[cfg(test)]
mod test_support;
mod workcopy;

pub use cli::{
    BisectCommand, BoardCommand, BranchCommand, Cli, Command, CompletionShell, DEFAULT_AUTHOR,
    DEFAULT_REF, DEFAULT_SERVER, HookCommand, OrgCommand, PrCommand, RemoteCommand, RepoCommand,
    StashCommand, SubmoduleCommand, UploadWalkArgs, run,
};
pub use client::{RepoClient, ServerClient};
pub use error::{Error, Result};
