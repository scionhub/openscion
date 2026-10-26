//! Command-line parsing and dispatch.
//!
//! [`Cli`] is the parsed command line; [`run`] executes it and writes the
//! result to any [`Write`], so commands are tested without spawning a process.

use std::io::Write;
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use openscion_core::{PROTOCOL_VERSION, RepoPath};

use crate::{Error, Result, ServerClient, commands};

/// The server `opnscn` talks to when neither `--server` nor `OPENSCION_SERVER`
/// is set: the hosted ScionBase API.
pub const DEFAULT_SERVER: &str = "https://api.scionbase.ai";

/// The parsed `opnscn` command line.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "opnscn", version, about = "The OpenScion command-line client")]
#[non_exhaustive]
pub struct Cli {
    /// Base URL of the OpenScion server.
    #[arg(long, global = true, env = "OPENSCION_SERVER", default_value = DEFAULT_SERVER)]
    pub server: String,

    /// The command to run.
    #[command(subcommand)]
    pub command: Command,
}

/// The ref commands read and move when `--ref` is not given.
pub const DEFAULT_REF: &str = "main";

/// The author recorded when neither `--author` nor `OPENSCION_AUTHOR` is set.
pub const DEFAULT_AUTHOR: &str = "opnscn";

/// The commands `opnscn` understands.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum Command {
    /// Print the client and protocol versions.
    Version,
    /// Ask the server for its version and check that its protocol binds.
    ServerInfo,
    /// Record a directory as the repository's first changeset and create the
    /// ref; the directory becomes a working copy.
    Import {
        /// The directory to import.
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// The ref to create.
        #[arg(long = "ref", default_value = DEFAULT_REF)]
        ref_name: String,
        /// The changeset message.
        #[arg(short, long, default_value = "import")]
        message: String,
        /// Who the changeset is attributed to.
        #[arg(long, env = "OPENSCION_AUTHOR", default_value = DEFAULT_AUTHOR)]
        author: String,
    },
    /// Record every change in a working copy and move its ref by
    /// compare-and-swap. Talks to the server the working copy came from.
    Commit {
        /// The changeset message.
        #[arg(short, long)]
        message: String,
        /// The working copy.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
        /// Who the changeset is attributed to.
        #[arg(long, env = "OPENSCION_AUTHOR", default_value = DEFAULT_AUTHOR)]
        author: String,
    },
    /// Fetch a ref's snapshot into a new working copy, or only one directory
    /// of it with `--path`.
    Clone {
        /// Where to write the working copy; must be absent or empty.
        dest: PathBuf,
        /// The ref to clone.
        #[arg(long = "ref", default_value = DEFAULT_REF)]
        ref_name: String,
        /// Fetch only this directory (or file) of the snapshot.
        #[arg(long)]
        path: Option<String>,
    },
}

/// Runs `cli`, writing its output to `out`.
///
/// # Errors
///
/// Returns the [`ServerClient`] error for commands that reach a server,
/// [`Error::Io`] and the working-copy variants for commands that touch the
/// disk, and [`Error::Output`] when writing to `out` fails.
pub fn run(cli: &Cli, out: &mut impl Write) -> Result<()> {
    match &cli.command {
        Command::Version => {
            let (major, minor) = PROTOCOL_VERSION;
            writeln!(
                out,
                "opnscn {} (protocol {major}.{minor})",
                env!("CARGO_PKG_VERSION")
            )
            .map_err(Error::Output)
        }
        Command::ServerInfo => {
            let info = ServerClient::new(&cli.server).info()?;
            let (major, minor) = info.protocol_version;
            writeln!(
                out,
                "{}: openscion-server {} (protocol {major}.{minor})",
                cli.server, info.server_version
            )
            .map_err(Error::Output)
        }
        Command::Import {
            dir,
            ref_name,
            message,
            author,
        } => {
            let client = ServerClient::new(&cli.server);
            let (info, files) = commands::import(&client, dir, ref_name, author, message)?;
            writeln!(out, "imported {files} files as {} on {ref_name}", info.id)
                .map_err(Error::Output)
        }
        Command::Commit {
            message,
            dir,
            author,
        } => {
            let (info, changes) = commands::commit(dir, author, message)?;
            writeln!(out, "committed {changes} changes as {}", info.id).map_err(Error::Output)
        }
        Command::Clone {
            dest,
            ref_name,
            path,
        } => {
            let sparse = path.as_deref().map(RepoPath::new).transpose()?;
            let client = ServerClient::new(&cli.server);
            let (target, files) = commands::clone(&client, ref_name, dest, sparse.as_ref())?;
            writeln!(
                out,
                "cloned {files} files of {target} into {}",
                dest.display()
            )
            .map_err(Error::Output)
        }
    }
}

#[cfg(test)]
mod test;
