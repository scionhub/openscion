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
/// is set: a local `openscion-server` on its default port.
pub const DEFAULT_SERVER: &str = "http://127.0.0.1:7878";

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
    /// Authenticate and store a bearer token for subsequent writes.
    Login {
        /// User name.
        #[arg(long)]
        user: String,
        /// Optional org for auth; defaults to filecoin-project.
        #[arg(long, default_value = "filecoin-project")]
        org: String,
    },
    /// Record a directory as the repository's first changeset and create the
    /// ref; the directory becomes a working copy.
    Import {
        /// The directory to import.
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// The repository to import into, as `<org>/<repo>`.
        #[arg(long = "repo")]
        repo: String,
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
        /// The repository to clone from, as `<org>/<repo>`.
        #[arg(long = "repo")]
        repo: String,
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
        Command::Login { user, org } => {
            // Read password from env or prompt
            let password = std::env::var("OPENSCION_PASSWORD").unwrap_or_else(|_| {
                rpassword::prompt_password("Password: ").unwrap_or_default()
            });
            let url = format!("{}/v1/auth/login", cli.server.trim_end_matches('/'));
            let mut req = ureq::post(&url).header("content-type", "application/json");
            req = req.header("x-org", org);
            let body = serde_json::json!({ "name": user, "password": password });
            let mut response = req.send_json(body).map_err(|e| Error::Request {
                url: url.clone(),
                message: e.to_string(),
            })?;
            let token: serde_json::Value = response
                .body_mut()
                .with_config()
                .limit(u64::MAX)
                .read_json()
                .map_err(|e| Error::Decode { url: url.clone(), message: e.to_string() })?;
            let token_str = token.get("token").and_then(|v| v.as_str()).unwrap_or_default();
            if token_str.is_empty() {
                return Err(Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login failed: empty token",
                }));
            }
            let mut creds = load_credentials().unwrap_or_default();
            creds.servers.insert(cli.server.clone(), token_str.to_owned());
            save_credentials(&creds)?;
            writeln!(out, "login ok").map_err(Error::Output)
        }
        Command::Import {
            dir,
            repo,
            ref_name,
            message,
            author,
        } => {
            let (org, repo_name) = repo.split_once('/').ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "repo must be <org>/<repo>",
                })
            })?;
            let token = load_credentials().ok().and_then(|c| c.servers.get(&cli.server).cloned());
            let client = ServerClient::new(&cli.server).with_token(token).repo(org, repo_name);
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
            repo,
            ref_name,
            path,
        } => {
            let sparse = path.as_deref().map(RepoPath::new).transpose()?;
            let (org, repo_name) = repo.split_once('/').ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "repo must be <org>/<repo>",
                })
            })?;
            let token = load_credentials().ok().and_then(|c| c.servers.get(&cli.server).cloned());
            let client = ServerClient::new(&cli.server).with_token(token).repo(org, repo_name);
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

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct Credentials {
    servers: std::collections::BTreeMap<String, String>,
}

fn creds_path() -> std::path::PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("opnscn").join("credentials.json")
}

fn load_credentials() -> std::io::Result<Credentials> {
    let path = creds_path();
    let bytes = std::fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn save_credentials(creds: &Credentials) -> Result<()> {
    let path = creds_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::Io { path: parent.to_path_buf(), source: e })?;
    }
    let bytes = serde_json::to_vec_pretty(creds)
        .map_err(|e| Error::Output(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    std::fs::write(&path, bytes).map_err(|e| Error::Io { path, source: e })?;
    Ok(())
}
#[cfg(test)]
mod test;
