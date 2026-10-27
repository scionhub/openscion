//! Command-line parsing and dispatch.
//!
//! [`Cli`] is the parsed command line; [`run`] executes it and writes the
//! result to any [`Write`], so commands are tested without spawning a process.

use std::io::Write;
use std::path::PathBuf;

use clap::{CommandFactory, Parser, Subcommand, ValueEnum};
use openscion_core::{PROTOCOL_VERSION, RepoPath};

use crate::{Error, Result, ServerClient, commands};

mod ci;

/// Default API host when neither `--server` nor `SCN_SERVER` /
/// `OPENSCION_SERVER` is set.
///
/// Switch to `https://api.scionbase.ai` later.
pub const DEFAULT_SERVER: &str = "https://openscion-filecoin-poc.jolly-bush-400d.workers.dev";

pub(crate) fn first_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

fn default_server() -> String {
    first_env(&["SCN_SERVER", "OPENSCION_SERVER"]).unwrap_or_else(|| DEFAULT_SERVER.to_owned())
}

fn default_author() -> String {
    first_env(&["SCN_AUTHOR", "OPENSCION_AUTHOR"]).unwrap_or_else(|| DEFAULT_AUTHOR.to_owned())
}

/// The parsed `scn` command line.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(
    name = "scn",
    version,
    about = "The ScionBase command-line client",
    long_about = "scn is a git-like client for ScionBase. A working copy in \
.scn/state.json tracks the current branch and the remote ref it pushes to.\n\n\
Typical flow:\n  \
scn clone org/repo\n  \
scn branch new feature\n  \
scn pull\n  \
scn push -m \"my change\"\n  \
scn pr create --title \"my change\""
)]
#[non_exhaustive]
pub struct Cli {
    /// Base URL of the ScionBase server.
    #[arg(long, global = true, env = "SCN_SERVER", default_value_t = default_server())]
    pub server: String,

    /// The command to run.
    #[command(subcommand)]
    pub command: Command,
}

/// The ref commands read and move when `--ref` is not given.
pub const DEFAULT_REF: &str = "main";

/// The author recorded when neither `--author` nor `SCN_AUTHOR` /
/// `OPENSCION_AUTHOR` is set.
pub const DEFAULT_AUTHOR: &str = "scn";

/// The commands `scn` understands.
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
    /// Create an account and store a bearer token for subsequent writes.
    Signup {
        /// User name (`^[a-z0-9][a-z0-9-]{2,31}$`).
        #[arg(long)]
        username: String,
        /// Optional email address.
        #[arg(long)]
        email: Option<String>,
    },
    /// List remote branches, or create, switch, or delete one.
    #[command(subcommand_required = false)]
    Branch {
        /// The branch subcommand. Omit it to list remote branches.
        #[command(subcommand)]
        command: Option<BranchCommand>,
        /// The working copy.
        #[arg(long, global = true, default_value = ".")]
        dir: PathBuf,
    },
    /// Open, list, merge, or close pull requests.
    Pr {
        /// The pull-request subcommand.
        #[command(subcommand)]
        command: PrCommand,
    },
    /// Create, list, show, close, or reopen issues.
    Issue {
        /// The issue subcommand.
        #[command(subcommand)]
        command: IssueCommand,
    },
    /// Create, list, show, or delete issue boards.
    Board {
        /// The board subcommand.
        #[command(subcommand)]
        command: BoardCommand,
    },
    /// Record a directory as the repository's first changeset and create the
    /// ref; the directory becomes a working copy. By default `.git` and nested
    /// git checkouts are skipped; pass `--allow-vcs` to include them.
    Import {
        /// The directory to import.
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// The repository to import into, as `<org>/<repo>`.
        #[arg(long = "repo", default_value = "local/default")]
        repo: String,
        /// The ref to create.
        #[arg(long = "ref", default_value = DEFAULT_REF)]
        ref_name: String,
        /// The changeset message.
        #[arg(short, long, default_value = "import")]
        message: String,
        /// Who the changeset is attributed to.
        #[arg(long, env = "SCN_AUTHOR", default_value_t = default_author())]
        author: String,
        /// How the upload walk treats VCS metadata and nested checkouts.
        #[command(flatten)]
        walk: UploadWalkArgs,
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
        #[arg(long, env = "SCN_AUTHOR", default_value_t = default_author())]
        author: String,
        /// Ref to move; defaults to the working copy's current ref. A missing
        /// ref is created. Logged-in non-members may push
        /// `refs/heads/users/<username>/*` on a public repo.
        #[arg(long = "ref")]
        ref_name: Option<String>,
        /// How the upload walk treats VCS metadata and nested checkouts.
        #[command(flatten)]
        walk: UploadWalkArgs,
    },
    /// Create a repository.
    Repo {
        /// The repository subcommand.
        #[command(subcommand)]
        command: RepoCommand,
    },
    /// Create or list organizations.
    Org {
        /// The organization subcommand.
        #[command(subcommand)]
        command: OrgCommand,
    },
    /// Three-way merge another ref into the working copy.
    #[command(after_help = "Examples:\n  scn merge main\n  scn merge users/alice/feat")]
    Merge {
        /// Ref to merge from.
        r#ref: String,
        /// The working copy.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Hidden alias of `merge --from`.
    #[command(hide = true)]
    Sync {
        /// Ref to merge from.
        #[arg(long = "from", default_value = DEFAULT_REF)]
        from: String,
        /// The working copy.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Fetch the tracked upstream and three-way-merge it into the working copy.
    Pull {
        /// The working copy.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Commit local changes if needed and publish the current branch.
    #[command(after_help = "Examples:\n  scn push\n  scn push -m \"fix the parser\"")]
    Push {
        /// Changeset message; required when the working copy has local changes.
        #[arg(short, long)]
        message: Option<String>,
        /// The working copy.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
        /// Who the changeset is attributed to.
        #[arg(long, env = "SCN_AUTHOR", default_value_t = default_author())]
        author: String,
        /// How the upload walk treats VCS metadata and nested checkouts.
        #[command(flatten)]
        walk: UploadWalkArgs,
    },
    /// Clone a repository into a new working copy.
    #[command(after_help = "Examples:\n  scn clone filecoin-project/lotus\n  \
scn clone filecoin-project/lotus ./lotus --branch main\n  \
scn clone filecoin-project/lotus --path src")]
    Clone {
        /// Repository as `<org>/<repo>`. With hidden `--repo`, this is the destination.
        repo: String,
        /// Destination directory; defaults to the repository name.
        dir: Option<PathBuf>,
        /// Hidden compatibility alias for the repository.
        #[arg(long = "repo", hide = true)]
        repo_flag: Option<String>,
        /// Branch (or ref) to check out.
        #[arg(long)]
        branch: Option<String>,
        /// Hidden compatibility alias for `--branch`.
        #[arg(long = "ref", hide = true)]
        ref_name: Option<String>,
        /// Fetch only this directory (or file) of the snapshot.
        #[arg(long)]
        path: Option<String>,
        /// Check out this exact changeset (64 hex) instead of the branch head.
        #[arg(long)]
        at: Option<String>,
    },
    /// Report, list, and re-run CI checks (ScionBase-native CI).
    #[command(
        after_help = "Jobs come from .scionbase/ci.yml and run on your own runners (scn runner).\n\
Any script can report a result:\n  scn ci report lint --pr 3 --state success --summary ok"
    )]
    Ci {
        /// The CI subcommand.
        #[command(subcommand)]
        command: ci::CiCommand,
    },
    /// Register and run self-hosted CI runners (outbound HTTPS only).
    Runner {
        /// The runner subcommand.
        #[command(subcommand)]
        command: ci::RunnerCommand,
    },
    /// Generate shell completion scripts.
    #[command(after_help = "Install:\n  \
scn completion bash > ~/.local/share/bash-completion/completions/scn\n  \
scn completion zsh  > \"${fpath[1]}/_scn\"\n  \
scn completion fish > ~/.config/fish/completions/scn.fish\n\n\
Bash can complete branch names by also sourcing a wrapper that calls\n  \
`scn __complete-branches` (a hidden command that prints remote branch names).")]
    Completion {
        /// Shell to generate completions for.
        shell: CompletionShell,
    },
    /// Print remote branch names, one per line (for completion scripts).
    #[command(name = "__complete-branches", hide = true)]
    CompleteBranches {
        /// The working copy.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
}

/// Shared flag for commands that walk a directory to upload it.
#[derive(Debug, Clone, PartialEq, Eq, Default, clap::Args)]
pub struct UploadWalkArgs {
    /// Include `.git` and other VCS metadata, and the contents of nested
    /// git checkouts (submodules). Off by default so those are not recorded
    /// as ordinary files. Gitlinks (mode 160000) are not stored yet.
    #[arg(long = "allow-vcs")]
    pub allow_vcs: bool,
}

/// Subcommands of `scn org`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum OrgCommand {
    /// Create an organization. You become its admin. Non-admins may create 3.
    Create {
        /// Organization name (`^[a-z0-9][a-z0-9-]{2,31}$`).
        name: String,
    },
    /// List organizations.
    List,
}

/// Subcommands of `scn repo`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum RepoCommand {
    /// Create a repository in your user namespace or an org you belong to.
    Create {
        /// Repository name (`^[a-z0-9][a-z0-9._-]{0,63}$`).
        name: String,
        /// Org to create in; defaults to your username.
        #[arg(long)]
        org: Option<String>,
    },
}

/// Subcommands of `scn branch`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum BranchCommand {
    /// Create a local branch from `--from` (default: current) and switch to it.
    New {
        /// Local branch name.
        name: String,
        /// Ref to start from; defaults to the current branch.
        #[arg(long = "from")]
        from: Option<String>,
    },
    /// Switch the working copy to a branch (refuses if the tree is dirty).
    Switch {
        /// Branch or ref to check out.
        name: String,
    },
    /// Delete a branch locally and on the server.
    Delete {
        /// Branch to delete.
        name: String,
    },
    /// Hidden alias of `scn push` for a named user-namespace ref.
    #[command(hide = true)]
    Push {
        /// Branch name. Stored as `refs/heads/users/<you>/<NAME>` unless it
        /// already starts with `refs/`.
        name: String,
        /// The changeset message when there are local changes.
        #[arg(short, long)]
        message: Option<String>,
        /// Who the changeset is attributed to.
        #[arg(long, env = "SCN_AUTHOR", default_value_t = default_author())]
        author: String,
        /// How the upload walk treats VCS metadata and nested checkouts.
        #[command(flatten)]
        walk: UploadWalkArgs,
    },
}

/// Shells `scn completion` can emit scripts for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[non_exhaustive]
pub enum CompletionShell {
    /// Bash.
    Bash,
    /// Zsh.
    Zsh,
    /// Fish.
    Fish,
}

/// Subcommands of `scn pr`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum PrCommand {
    /// Open a pull request from `--head` into `--base`.
    Create {
        /// Pull request title.
        #[arg(long)]
        title: String,
        /// Optional description.
        #[arg(long)]
        body: Option<String>,
        /// Comma-separated list of issue numbers to auto-close on merge.
        #[arg(long)]
        fixes: Option<String>,
        /// Create as draft (cannot merge until ready).
        #[arg(long)]
        draft: bool,
        /// Head ref (the branch to merge from). Defaults to the current
        /// branch's upstream.
        #[arg(long)]
        head: Option<String>,
        /// Base ref (the branch to merge into).
        #[arg(long, default_value = "main")]
        base: String,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// List pull requests.
    List {
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Show one pull request, including current head and base targets.
    Show {
        /// Pull request number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Merge a pull request (org member or admin).
    Merge {
        /// Pull request number.
        number: u32,
        /// Use squash merge.
        #[arg(long)]
        squash: bool,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Close a pull request (author or admin).
    Close {
        /// Pull request number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Mark a pull request as draft.
    Draft {
        /// Pull request number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Mark a pull request as ready for review.
    Ready {
        /// Pull request number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Submit a review on a pull request.
    Review {
        /// Pull request number.
        number: u32,
        /// Approve the pull request.
        #[arg(long)]
        approve: bool,
        /// Request changes.
        #[arg(long = "request-changes")]
        request_changes: bool,
        /// Optional comment body.
        #[arg(long)]
        comment: Option<String>,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
}

/// Subcommands of `scn issue`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum IssueCommand {
    /// Create an issue.
    Create {
        /// Title.
        #[arg(long)]
        title: String,
        /// Optional body.
        #[arg(long)]
        body: Option<String>,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// List issues.
    List {
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Show one issue.
    Show {
        /// Issue number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Close an issue.
    Close {
        /// Issue number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Reopen an issue.
    Reopen {
        /// Issue number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Post a comment on an issue (any signed-in user).
    Comment {
        /// Issue number.
        number: u32,
        /// Comment body.
        #[arg(long)]
        body: String,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// List comments on an issue.
    Comments {
        /// Issue number.
        number: u32,
        /// Repository as `<org>/<repo>`; inferred from the working copy.
        #[arg(long)]
        repo: Option<String>,
        /// Working copy used to infer the repository.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
}

/// Subcommands of `scn board`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum BoardCommand {
    /// Create a board owned by an org.
    Create {
        /// Board name.
        name: String,
        /// Optional tag filter; omit for all tags.
        #[arg(long)]
        tag: Option<String>,
        /// Issue source: `org` or `org/repo`. Repeatable. Omit for all visible orgs.
        #[arg(long = "source")]
        sources: Vec<String>,
        /// Owning org; inferred from the working copy.
        #[arg(long)]
        org: Option<String>,
        /// Working copy used to infer the org.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// List boards owned by an org.
    List {
        /// Owning org; inferred from the working copy.
        #[arg(long)]
        org: Option<String>,
        /// Working copy used to infer the org.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Show one board and its matching issues (any org/repo).
    Show {
        /// Board name or id.
        name: String,
        /// Owning org; inferred from the working copy.
        #[arg(long)]
        org: Option<String>,
        /// Working copy used to infer the org.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
    /// Delete a board.
    Delete {
        /// Board name or id.
        name: String,
        /// Owning org; inferred from the working copy.
        #[arg(long)]
        org: Option<String>,
        /// Working copy used to infer the org.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
    },
}

/// Runs `cli`, writing its output to `out`.
///
/// # Errors
///
/// Returns the [`ServerClient`] error for commands that reach a server,
/// [`Error::Io`] and the working-copy variants for commands that touch the
/// disk, and [`Error::Output`] when writing to `out` fails.
#[allow(clippy::too_many_lines)] // Top-level dispatcher for a CLI is expected to be longer
pub fn run(cli: &Cli, out: &mut impl Write) -> Result<()> {
    match &cli.command {
        Command::Version => {
            let (major, minor) = PROTOCOL_VERSION;
            writeln!(
                out,
                "scn {} (protocol {major}.{minor})",
                env!("CARGO_PKG_VERSION")
            )
            .map_err(Error::Output)
        }
        Command::ServerInfo => {
            let info = ServerClient::new(&cli.server).info()?;
            let (major, minor) = info.protocol_version;
            writeln!(
                out,
                "{}: {} {} (protocol {major}.{minor})",
                cli.server, info.name, info.server_version
            )
            .map_err(Error::Output)
        }
        Command::Login { user, org } => {
            let url = format!("{}/v1/auth/login", cli.server.trim_end_matches('/'));
            auth_token(
                &url,
                org,
                &serde_json::json!({ "name": user, "password": read_password() }),
                &cli.server,
                user,
            )?;
            writeln!(out, "login ok").map_err(Error::Output)
        }
        Command::Signup { username, email } => {
            let url = format!("{}/v1/auth/signup", cli.server.trim_end_matches('/'));
            let mut body = serde_json::json!({
                "username": username,
                "password": read_password(),
            });
            if let Some(email) = email {
                body["email"] = serde_json::Value::String(email.clone());
            }
            auth_token(&url, "filecoin-project", &body, &cli.server, username)?;
            writeln!(out, "signup ok").map_err(Error::Output)
        }
        Command::Branch { command, dir } => run_branch(cli, command.as_ref(), dir, out),
        Command::Merge { r#ref, dir } => run_merge(cli, r#ref, dir, out),
        Command::Pull { dir } => {
            let state = crate::workcopy::load(dir)?;
            run_merge(cli, &state.upstream_ref(), dir, out)
        }
        Command::Push {
            message,
            dir,
            author,
            walk,
        } => run_push(cli, message.as_deref(), dir, author, walk.allow_vcs, out),
        Command::Completion { shell } => {
            write_completion(*shell, out);
            Ok(())
        }
        Command::CompleteBranches { dir } => {
            let token = token_for(&effective_server(cli, dir));
            let (_, branches) = commands::list_branches(dir, token)?;
            for branch in branches {
                writeln!(out, "{}", branch.name).map_err(Error::Output)?;
            }
            Ok(())
        }
        Command::Pr { command } => run_pr(cli, command, out),
        Command::Issue { command } => run_issue(cli, command, out),
        Command::Board { command } => run_board(cli, command, out),
        Command::Ci { command } => ci::run_ci(cli, command, out),
        Command::Runner { command } => ci::run_runner(cli, command, out),
        Command::Import {
            dir,
            repo,
            ref_name,
            message,
            author,
            walk,
        } => {
            let (org, repo_name) = repo.split_once('/').ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "repo must be <org>/<repo>",
                })
            })?;
            let token = load_credentials()
                .ok()
                .and_then(|c| c.servers.get(&cli.server).cloned());
            let client = ServerClient::new(&cli.server)
                .with_token(token)
                .repo(org, repo_name);
            let (info, files) =
                commands::import(&client, dir, ref_name, author, message, walk.allow_vcs)?;
            writeln!(out, "imported {files} files as {} on {ref_name}", info.id)
                .map_err(Error::Output)
        }
        Command::Commit {
            message,
            dir,
            author,
            ref_name,
            walk,
        } => {
            let token = token_for(&effective_server(cli, dir));
            let (info, changes) = commands::commit_ref(
                dir,
                author,
                message,
                ref_name.as_deref(),
                token,
                walk.allow_vcs,
            )?;
            writeln!(out, "committed {changes} changes as {}", info.id).map_err(Error::Output)
        }
        Command::Clone {
            repo,
            dir,
            repo_flag,
            branch,
            ref_name,
            path,
            at,
        } => {
            let (repo, dest) = clone_dest(repo, dir.as_ref(), repo_flag.as_deref())?;
            let ref_name = branch
                .as_deref()
                .or(ref_name.as_deref())
                .unwrap_or(DEFAULT_REF);
            let sparse = path.as_deref().map(RepoPath::new).transpose()?;
            let (org, repo_name) = repo.split_once('/').ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "repo must be <org>/<repo>",
                })
            })?;
            let token = load_credentials()
                .ok()
                .and_then(|c| c.servers.get(&cli.server).cloned());
            let client = ServerClient::new(&cli.server)
                .with_token(token)
                .repo(org, repo_name);
            let at = match at {
                Some(id) => Some(id.parse::<openscion_core::ObjectId>().map_err(|_| {
                    Error::Engine(openscion_core::Error::InvalidChange {
                        path: "cli".to_owned(),
                        rule: "--at must be a 64-hex changeset id",
                    })
                })?),
                None => None,
            };
            let (target, files) =
                commands::clone_at(&client, ref_name, at, &dest, sparse.as_ref())?;
            writeln!(
                out,
                "cloned {files} files of {target} into {}",
                dest.display()
            )
            .map_err(Error::Output)
        }
        Command::Sync { from, dir } => run_merge(cli, from, dir, out),
        Command::Repo {
            command: RepoCommand::Create { name, org },
        } => {
            let token = token_for(&cli.server).ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login or signup first",
                })
            })?;
            let username = username_for(&cli.server).ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login or signup first",
                })
            })?;
            let org = org.clone().unwrap_or(username);
            let client = ServerClient::new(&cli.server).with_token(Some(token));
            let value = client.create_repo(&org, name)?;
            let shown_org = value
                .get("org")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&org);
            let shown_name = value
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(name);
            writeln!(out, "created {shown_org}/{shown_name}").map_err(Error::Output)
        }
        Command::Org { command } => run_org(cli, command, out),
    }
}

fn run_org(cli: &Cli, command: &OrgCommand, out: &mut impl Write) -> Result<()> {
    match command {
        OrgCommand::Create { name } => {
            let token = token_for(&cli.server).ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login or signup first",
                })
            })?;
            let client = ServerClient::new(&cli.server).with_token(Some(token));
            let value = client.create_org(name)?;
            let shown = value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .or_else(|| value.get("name").and_then(serde_json::Value::as_str))
                .unwrap_or(name);
            writeln!(out, "created {shown}").map_err(Error::Output)
        }
        OrgCommand::List => {
            let token = token_for(&cli.server);
            let client = ServerClient::new(&cli.server).with_token(token);
            for org in client.list_orgs()? {
                writeln!(out, "{org}").map_err(Error::Output)?;
            }
            Ok(())
        }
    }
}

fn run_merge(cli: &Cli, from: &str, dir: &std::path::Path, out: &mut impl Write) -> Result<()> {
    let token = token_for(&effective_server(cli, dir));
    let summary = commands::sync(dir, from, token)?;
    write_sync_summary(out, &summary)?;
    if summary.conflicted.is_empty() {
        Ok(())
    } else {
        Err(Error::SyncConflicts {
            count: summary.conflicted.len(),
        })
    }
}

fn run_push(
    cli: &Cli,
    message: Option<&str>,
    dir: &std::path::Path,
    author: &str,
    allow_vcs: bool,
    out: &mut impl Write,
) -> Result<()> {
    let token = token_for(&effective_server(cli, dir));
    match commands::push(dir, author, message, token, allow_vcs)? {
        commands::PushOutcome::Committed {
            id,
            changes,
            upstream,
        } => writeln!(out, "committed {changes} changes as {id} on {upstream}")
            .map_err(Error::Output),
        commands::PushOutcome::Published { id, upstream } => {
            writeln!(out, "published {id} on {upstream}").map_err(Error::Output)
        }
    }
}

fn run_branch(
    cli: &Cli,
    command: Option<&BranchCommand>,
    dir: &std::path::Path,
    out: &mut impl Write,
) -> Result<()> {
    let token = token_for(&effective_server(cli, dir));
    match command {
        None => {
            let (current, branches) = commands::list_branches(dir, token)?;
            for branch in branches {
                let mark = if branch.name == current { "*" } else { " " };
                writeln!(out, "{mark} {}", branch.name).map_err(Error::Output)?;
            }
            Ok(())
        }
        Some(BranchCommand::New { name, from }) => {
            let server = effective_server(cli, dir);
            let username = username_for(&server).ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login or signup first",
                })
            })?;
            let org = crate::workcopy::load(dir)?
                .repo
                .split_once('/')
                .map(|(o, _)| o.to_owned())
                .unwrap_or_default();
            let member = commands::org_is_member(&server, &org, &username, token.clone());
            let (branch, upstream) =
                commands::create_branch(dir, name, from.as_deref(), token, &username, member)?;
            writeln!(out, "switched to {branch} (upstream {upstream})").map_err(Error::Output)
        }
        Some(BranchCommand::Switch { name }) => {
            let branch = commands::switch_branch(dir, name, token)?;
            writeln!(out, "switched to {branch}").map_err(Error::Output)
        }
        Some(BranchCommand::Delete { name }) => {
            let deleted = commands::delete_branch(dir, name, token)?;
            writeln!(out, "deleted {deleted}").map_err(Error::Output)
        }
        Some(BranchCommand::Push {
            name,
            message,
            author,
            walk,
        }) => {
            let username = username_for(&effective_server(cli, dir)).ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login or signup first",
                })
            })?;
            let ref_name = user_branch_ref(name, &username);
            let msg = message.clone().unwrap_or_else(|| format!("push {name}"));
            match commands::commit_ref(
                dir,
                author,
                &msg,
                Some(&ref_name),
                token.clone(),
                walk.allow_vcs,
            ) {
                Ok((info, changes)) => writeln!(
                    out,
                    "committed {changes} changes as {} on {ref_name}",
                    info.id
                )
                .map_err(Error::Output),
                Err(Error::NothingToCommit) => {
                    let id = commands::publish_ref(dir, &ref_name, token)?;
                    writeln!(out, "published {id} on {ref_name}").map_err(Error::Output)
                }
                Err(error) => Err(error),
            }
        }
    }
}

fn clone_dest(
    repo: &str,
    dir: Option<&PathBuf>,
    repo_flag: Option<&str>,
) -> Result<(String, PathBuf)> {
    if let Some(flag) = repo_flag {
        return Ok((flag.to_owned(), PathBuf::from(repo)));
    }
    if !looks_like_repo(repo) {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "repo must be <org>/<repo>",
        }));
    }
    let dest = dir
        .cloned()
        .unwrap_or_else(|| PathBuf::from(repo.rsplit('/').next().unwrap_or(repo)));
    Ok((repo.to_owned(), dest))
}

fn looks_like_repo(spec: &str) -> bool {
    let Some((org, name)) = spec.split_once('/') else {
        return false;
    };
    !org.is_empty() && !name.is_empty() && !org.starts_with('.') && !name.contains('/')
}

fn write_completion(shell: CompletionShell, out: &mut impl Write) {
    let mut cmd = Cli::command();
    match shell {
        CompletionShell::Bash => {
            clap_complete::generate(clap_complete::shells::Bash, &mut cmd, "scn", out);
            let _ = writeln!(
                out,
                "\n# Remote branch names: scn __complete-branches --dir ."
            );
        }
        CompletionShell::Zsh => {
            clap_complete::generate(clap_complete::shells::Zsh, &mut cmd, "scn", out);
        }
        CompletionShell::Fish => {
            clap_complete::generate(clap_complete::shells::Fish, &mut cmd, "scn", out);
        }
    }
}

fn write_sync_summary(out: &mut impl Write, summary: &commands::SyncSummary) -> Result<()> {
    if summary.updated.is_empty() && summary.kept.is_empty() && summary.conflicted.is_empty() {
        writeln!(out, "already up to date with {}", summary.from).map_err(Error::Output)?;
        return Ok(());
    }
    for path in &summary.updated {
        writeln!(out, "updated {path}").map_err(Error::Output)?;
    }
    for path in &summary.kept {
        writeln!(out, "kept {path}").map_err(Error::Output)?;
    }
    for path in &summary.conflicted {
        writeln!(out, "conflicted {path}").map_err(Error::Output)?;
    }
    Ok(())
}

fn parse_fixes_csv(raw: Option<&str>) -> Option<Vec<u32>> {
    raw.map(|s| {
        s.split(',')
            .filter_map(|p| p.trim().parse::<u32>().ok())
            .collect::<Vec<u32>>()
    })
}

fn run_pr_create(cli: &Cli, command: &PrCommand, out: &mut impl Write) -> Result<()> {
    let PrCommand::Create {
        title,
        body,
        fixes,
        draft,
        head,
        base,
        repo,
        dir,
    } = command
    else {
        unreachable!("run_pr_create requires PrCommand::Create");
    };
    let client = pr_client(cli, dir, repo.as_deref())?;
    let head = match head {
        Some(head) => head.clone(),
        None => crate::workcopy::load(dir)?.upstream_ref(),
    };
    let fixes_vec = parse_fixes_csv(fixes.as_deref());
    let value = client.create_pull(title, body.as_deref(), &head, base, fixes_vec.as_deref())?;
    let number = value
        .get("number")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if *draft {
        if let Ok(n) = u32::try_from(number) {
            if n > 0 {
                // best-effort toggle; ignore failure on servers without drafts
                let _ = client.set_pull_draft(n, true);
            }
        }
    }
    writeln!(out, "created pull request #{number}").map_err(Error::Output)
}

fn run_pr(cli: &Cli, command: &PrCommand, out: &mut impl Write) -> Result<()> {
    match command {
        PrCommand::Create { .. } => run_pr_create(cli, command, out),
        PrCommand::List { repo, dir } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let value = client.list_pulls()?;
            let pulls = value
                .get("pulls")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            for pull in pulls {
                let number = pull
                    .get("number")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let title = pull
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let state = pull
                    .get("state")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let head = pull
                    .get("head_ref")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                writeln!(out, "#{number} {state} {head} {title}").map_err(Error::Output)?;
            }
            Ok(())
        }
        PrCommand::Show { number, repo, dir } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let value = client.get_pull(*number)?;
            writeln!(
                out,
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            )
            .map_err(Error::Output)
        }
        PrCommand::Merge {
            number,
            squash,
            repo,
            dir,
        } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let value = if *squash {
                client.merge_pull_with_method(*number, Some("squash"))?
            } else {
                client.merge_pull(*number)?
            };
            let state = value
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("merged");
            writeln!(out, "pull request #{number} {state}").map_err(Error::Output)
        }
        PrCommand::Close { number, repo, dir } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let _ = client.close_pull(*number)?;
            writeln!(out, "pull request #{number} closed").map_err(Error::Output)
        }
        PrCommand::Draft { number, repo, dir } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let _ = client.set_pull_draft(*number, true)?;
            writeln!(out, "pull request #{number} marked draft").map_err(Error::Output)
        }
        PrCommand::Ready { number, repo, dir } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let _ = client.set_pull_draft(*number, false)?;
            writeln!(out, "pull request #{number} marked ready").map_err(Error::Output)
        }
        PrCommand::Review {
            number,
            approve,
            request_changes,
            comment,
            repo,
            dir,
        } => {
            let client = pr_client(cli, dir, repo.as_deref())?;
            let state = if *approve {
                "approved"
            } else if *request_changes {
                "changes_requested"
            } else {
                "commented"
            };
            let _ = client.review_pull(*number, state, comment.as_deref())?;
            writeln!(out, "reviewed pull request #{number} ({state})").map_err(Error::Output)
        }
    }
}

fn run_issue(cli: &Cli, command: &IssueCommand, out: &mut impl Write) -> Result<()> {
    match command {
        IssueCommand::Create {
            title,
            body,
            repo,
            dir,
        } => {
            let token = token_for(&effective_server(cli, dir)).ok_or_else(|| {
                Error::Engine(openscion_core::Error::InvalidChange {
                    path: "cli".to_owned(),
                    rule: "login or signup first",
                })
            })?;
            let client = issue_client(cli, dir, repo.as_deref())?.with_token(Some(token));
            let value = client.create_issue(title, body.as_deref())?;
            let number = value
                .get("number")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            writeln!(out, "created issue #{number}").map_err(Error::Output)
        }
        IssueCommand::List { repo, dir } => {
            let client = issue_client(cli, dir, repo.as_deref())?;
            let value = client.list_issues()?;
            let issues = value
                .get("issues")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            for it in issues {
                let number = it
                    .get("number")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0);
                let title = it
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let state = it
                    .get("state")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                writeln!(out, "#{number} {state} {title}").map_err(Error::Output)?;
            }
            Ok(())
        }
        IssueCommand::Show { number, repo, dir } => {
            let client = issue_client(cli, dir, repo.as_deref())?;
            let value = client.get_issue(*number)?;
            writeln!(
                out,
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            )
            .map_err(Error::Output)
        }
        IssueCommand::Close { number, repo, dir } => {
            let client = issue_client(cli, dir, repo.as_deref())?;
            let _ = client.issue_action(*number, "close")?;
            writeln!(out, "issue #{number} closed").map_err(Error::Output)
        }
        IssueCommand::Reopen { number, repo, dir } => {
            let client = issue_client(cli, dir, repo.as_deref())?;
            let _ = client.issue_action(*number, "reopen")?;
            writeln!(out, "issue #{number} reopened").map_err(Error::Output)
        }
        IssueCommand::Comment {
            number,
            body,
            repo,
            dir,
        } => {
            let client = issue_client(cli, dir, repo.as_deref())?;
            let _ = client.create_issue_comment(*number, body)?;
            writeln!(out, "commented on issue #{number}").map_err(Error::Output)
        }
        IssueCommand::Comments { number, repo, dir } => {
            let client = issue_client(cli, dir, repo.as_deref())?;
            let value = client.list_issue_comments(*number)?;
            let comments = value
                .get("comments")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            for c in comments {
                let author = c
                    .get("author")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let body = c
                    .get("body")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                writeln!(out, "{author}: {body}").map_err(Error::Output)?;
            }
            Ok(())
        }
    }
}

pub(crate) fn pr_client(
    cli: &Cli,
    dir: &std::path::Path,
    repo_flag: Option<&str>,
) -> Result<crate::RepoClient> {
    let state = crate::workcopy::load(dir).ok();
    let spec = repo_flag
        .map(str::to_owned)
        .or_else(|| state.as_ref().map(|s| s.repo.clone()))
        .ok_or_else(|| {
            Error::Engine(openscion_core::Error::InvalidChange {
                path: "cli".to_owned(),
                rule: "repo must be <org>/<repo> (pass --repo or run from a working copy)",
            })
        })?;
    let (org, repo_name) = spec.split_once('/').ok_or_else(|| {
        Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "repo must be <org>/<repo>",
        })
    })?;
    let server = match &state {
        Some(s) if cli.server == DEFAULT_SERVER => s.server.clone(),
        _ => cli.server.clone(),
    };
    let token = token_for(&server);
    Ok(crate::ServerClient::new(&server)
        .with_token(token)
        .repo(org, repo_name))
}

fn issue_client(
    cli: &Cli,
    dir: &std::path::Path,
    repo_flag: Option<&str>,
) -> Result<crate::RepoClient> {
    pr_client(cli, dir, repo_flag)
}

fn effective_server(cli: &Cli, dir: &std::path::Path) -> String {
    match crate::workcopy::load(dir) {
        Ok(state) if cli.server == DEFAULT_SERVER => state.server,
        _ => cli.server.clone(),
    }
}

fn user_branch_ref(name: &str, username: &str) -> String {
    if name.starts_with("refs/") {
        name.to_owned()
    } else if name.starts_with("users/") {
        format!("refs/heads/{name}")
    } else {
        format!("refs/heads/users/{username}/{name}")
    }
}

fn read_password() -> String {
    first_env(&["SCN_PASSWORD", "OPNSCN_PASSWORD", "OPENSCION_PASSWORD"])
        .unwrap_or_else(|| rpassword::prompt_password("Password: ").unwrap_or_default())
}

fn auth_token(
    url: &str,
    org: &str,
    body: &serde_json::Value,
    server: &str,
    username: &str,
) -> Result<()> {
    let mut req = ureq::post(url).header("content-type", "application/json");
    req = req.header("x-org", org);
    let mut response = req.send_json(body).map_err(|e| Error::Request {
        url: url.to_owned(),
        message: e.to_string(),
    })?;
    let token: serde_json::Value = response
        .body_mut()
        .with_config()
        .limit(u64::MAX)
        .read_json()
        .map_err(|e| Error::Decode {
            url: url.to_owned(),
            message: e.to_string(),
        })?;
    let token_str = token
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if token_str.is_empty() {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "authentication failed: empty token",
        }));
    }
    store_token(server, username, token_str)
}

fn store_token(server: &str, username: &str, token: &str) -> Result<()> {
    let mut creds = load_credentials().unwrap_or_default();
    creds.servers.insert(server.to_owned(), token.to_owned());
    creds.users.insert(server.to_owned(), username.to_owned());
    save_credentials(&creds)
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct Credentials {
    servers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    users: std::collections::BTreeMap<String, String>,
}

pub(crate) fn token_for(server: &str) -> Option<String> {
    load_credentials()
        .ok()
        .and_then(|c| c.servers.get(server).cloned())
}

pub(crate) fn username_for(server: &str) -> Option<String> {
    load_credentials()
        .ok()
        .and_then(|c| c.users.get(server).cloned())
}

fn creds_path() -> std::path::PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let modern = base.join("scn").join("credentials.json");
    if modern.exists() {
        return modern;
    }
    let legacy = base.join("opnscn").join("credentials.json");
    if legacy.exists() {
        return legacy;
    }
    modern
}

fn load_credentials() -> std::io::Result<Credentials> {
    let path = creds_path();
    let bytes = std::fs::read(&path)?;
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn save_credentials(creds: &Credentials) -> Result<()> {
    let path = creds_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Error::Io {
            path: parent.to_path_buf(),
            source: e,
        })?;
    }
    let bytes = serde_json::to_vec_pretty(creds)
        .map_err(|e| Error::Output(std::io::Error::other(e.to_string())))?;
    std::fs::write(&path, bytes).map_err(|e| Error::Io { path, source: e })?;
    Ok(())
}
#[cfg(test)]
mod test;

fn run_board(cli: &Cli, command: &BoardCommand, out: &mut impl Write) -> Result<()> {
    match command {
        BoardCommand::Create {
            name,
            tag,
            sources,
            org,
            dir,
        } => {
            let (org, client) = board_client(cli, dir, org.as_deref(), true)?;
            let value = client.create_board(&org, name, tag.as_deref(), sources)?;
            let shown = value
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(name);
            writeln!(out, "created board {org}/{shown}").map_err(Error::Output)
        }
        BoardCommand::List { org, dir } => {
            let (org, client) = board_client(cli, dir, org.as_deref(), false)?;
            let value = client.list_boards(&org)?;
            let boards = value
                .get("boards")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            for b in boards {
                let name = b
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                let tag = b
                    .get("tag")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if tag.is_empty() {
                    writeln!(out, "{name}").map_err(Error::Output)?;
                } else {
                    writeln!(out, "{name} (tag: {tag})").map_err(Error::Output)?;
                }
            }
            Ok(())
        }
        BoardCommand::Show { name, org, dir } => {
            let (org, client) = board_client(cli, dir, org.as_deref(), false)?;
            let value = client.get_board(&org, name)?;
            writeln!(
                out,
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            )
            .map_err(Error::Output)
        }
        BoardCommand::Delete { name, org, dir } => {
            let (org, client) = board_client(cli, dir, org.as_deref(), true)?;
            let _ = client.delete_board(&org, name)?;
            writeln!(out, "deleted board {org}/{name}").map_err(Error::Output)
        }
    }
}

fn board_client(
    cli: &Cli,
    dir: &std::path::Path,
    org_flag: Option<&str>,
    write: bool,
) -> Result<(String, crate::ServerClient)> {
    let state = crate::workcopy::load(dir).ok();
    let org = org_flag
        .map(str::to_owned)
        .or_else(|| {
            state
                .as_ref()
                .and_then(|s| s.repo.split_once('/').map(|(o, _)| o.to_owned()))
        })
        .ok_or_else(|| {
            Error::Engine(openscion_core::Error::InvalidChange {
                path: "cli".to_owned(),
                rule: "org is required (pass --org or run from a working copy)",
            })
        })?;
    let server = match &state {
        Some(s) if cli.server == DEFAULT_SERVER => s.server.clone(),
        _ => cli.server.clone(),
    };
    let token = token_for(&server);
    if write && token.is_none() {
        return Err(Error::Engine(openscion_core::Error::InvalidChange {
            path: "cli".to_owned(),
            rule: "login or signup first",
        }));
    }
    Ok((org, crate::ServerClient::new(&server).with_token(token)))
}
