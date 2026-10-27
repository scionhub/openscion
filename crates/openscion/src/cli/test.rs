//! Unit tests for command parsing and dispatch.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{self, Write};

use clap::Parser;
use openscion_core::PROTOCOL_VERSION;

use super::{
    BoardCommand, BranchCommand, Cli, Command, DEFAULT_AUTHOR, DEFAULT_REF, DEFAULT_SERVER,
    DEFAULT_WEB_UI, IssueCommand, OrgCommand, PrCommand, RepoCommand, UploadWalkArgs,
    pull_request_web_url, run,
};
use crate::CompletionShell;
use crate::Error;
use crate::test_support::{real_server, scratch, unreachable_server};

fn output(cli: &Cli) -> String {
    let mut out = Vec::new();
    run(cli, &mut out).unwrap();
    String::from_utf8(out).unwrap()
}

#[test]
fn the_server_defaults_to_the_public_host() {
    let cli = Cli::try_parse_from(["scn", "version"]).unwrap();
    let expected = std::env::var("SCN_SERVER")
        .or_else(|_| std::env::var("OPENSCION_SERVER"))
        .unwrap_or_else(|_| DEFAULT_SERVER.to_owned());
    assert_eq!(cli.server, expected);
    assert_eq!(cli.command, Command::Version);
}

#[test]
fn server_is_accepted_after_the_subcommand() {
    let cli = Cli::try_parse_from(["scn", "server-info", "--server", "http://h:1"]).unwrap();
    assert_eq!(cli.server, "http://h:1");
    assert_eq!(cli.command, Command::ServerInfo);
}

#[test]
fn an_unknown_command_is_rejected() {
    assert!(Cli::try_parse_from(["scn", "frobnicate"]).is_err());
}

#[test]
fn version_prints_the_client_and_protocol_versions() {
    let cli = Cli::try_parse_from(["scn", "version"]).unwrap();
    let (major, minor) = PROTOCOL_VERSION;
    assert_eq!(
        output(&cli),
        format!(
            "scn {} (protocol {major}.{minor})\n",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn server_info_prints_what_the_server_reports() {
    let base = real_server();
    let cli = Cli::try_parse_from(["scn", "--server", &base, "server-info"]).unwrap();
    let (major, minor) = PROTOCOL_VERSION;
    assert_eq!(
        output(&cli),
        format!(
            "{base}: scionbase-server {} (protocol {major}.{minor})\n",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn server_info_fails_when_the_server_is_unreachable() {
    let cli =
        Cli::try_parse_from(["scn", "--server", &unreachable_server(), "server-info"]).unwrap();
    assert!(matches!(
        run(&cli, &mut Vec::new()),
        Err(Error::Request { .. })
    ));
}

struct BrokenPipe;

impl Write for BrokenPipe {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::from(io::ErrorKind::BrokenPipe))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_failed_write_is_an_output_error() {
    let cli = Cli::try_parse_from(["scn", "version"]).unwrap();
    let error = run(&cli, &mut BrokenPipe).unwrap_err();
    assert!(matches!(error, Error::Output(_)));
    assert!(error.to_string().starts_with("cannot write output: "));

    let cli = Cli::try_parse_from(["scn", "--server", &real_server(), "server-info"]).unwrap();
    assert!(matches!(run(&cli, &mut BrokenPipe), Err(Error::Output(_))));
}

#[test]
fn import_commit_and_clone_run_from_the_command_line() {
    let base = real_server();
    let source = scratch("cli-source");
    std::fs::write(source.join("a.txt"), b"a").unwrap();
    let dir = source.to_str().unwrap();

    let cli = Cli::try_parse_from([
        "scn",
        "--server",
        &base,
        "import",
        dir,
        "--repo",
        "local/default",
    ])
    .unwrap();
    assert!(output(&cli).starts_with("imported 1 files as "));

    std::fs::write(source.join("b.txt"), b"b").unwrap();
    let cli = Cli::try_parse_from(["scn", "commit", "-m", "add b", "--dir", dir]).unwrap();
    assert!(output(&cli).starts_with("committed 1 changes as "));

    let dest = scratch("cli-clone").join("copy");
    let dest = dest.to_str().unwrap();
    let cli = Cli::try_parse_from([
        "scn",
        "--server",
        &base,
        "clone",
        "local/default",
        dest,
        "--path",
        "b.txt",
    ])
    .unwrap();
    assert!(output(&cli).starts_with("cloned 1 files of "));
}

#[test]
fn clone_rejects_an_invalid_path() {
    let cli =
        Cli::try_parse_from(["scn", "clone", "local/default", "x", "--path", "../up"]).unwrap();
    assert!(matches!(run(&cli, &mut Vec::new()), Err(Error::Engine(_))));
}

#[test]
fn clone_requires_org_and_repo() {
    let cli = Cli::try_parse_from(["scn", "clone", "lotus"]).unwrap();
    assert!(matches!(run(&cli, &mut Vec::new()), Err(Error::Engine(_))));
}

#[test]
fn signup_and_pr_commands_parse() {
    let cli =
        Cli::try_parse_from(["scn", "signup", "--username", "alice", "--email", "a@b.c"]).unwrap();
    assert_eq!(
        cli.command,
        Command::Signup {
            username: "alice".to_owned(),
            email: Some("a@b.c".to_owned()),
        }
    );

    let cli = Cli::try_parse_from(["scn", "branch", "push", "feature"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Branch {
            command: Some(BranchCommand::Push { name, .. }),
            ..
        } if name == "feature"
    ));

    let cli = Cli::try_parse_from(["scn", "branch"]).unwrap();
    assert!(matches!(cli.command, Command::Branch { command: None, .. }));
    let cli = Cli::try_parse_from(["scn", "branch", "new", "feat", "--from", "main"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Branch {
            command: Some(BranchCommand::New { name, from: Some(from), .. }),
            ..
        } if name == "feat" && from == "main"
    ));
    let cli = Cli::try_parse_from(["scn", "branch", "switch", "main"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Branch {
            command: Some(BranchCommand::Switch { name }),
            ..
        } if name == "main"
    ));
    let cli = Cli::try_parse_from(["scn", "branch", "delete", "feat"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Branch {
            command: Some(BranchCommand::Delete { name }),
            ..
        } if name == "feat"
    ));

    let cli = Cli::try_parse_from([
        "scn",
        "pr",
        "create",
        "--title",
        "Fix",
        "--head",
        "refs/heads/users/alice/feature",
    ])
    .unwrap();
    assert!(matches!(
        cli.command,
        Command::Pr {
            command: PrCommand::Create { title, base, .. }
        } if title == "Fix" && base == "main"
    ));

    let cli = Cli::try_parse_from(["scn", "pr", "list"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Pr {
            command: PrCommand::List { .. }
        }
    ));
    let cli = Cli::try_parse_from(["scn", "pr", "show", "3"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Pr {
            command: PrCommand::Show { number: 3, .. }
        }
    ));
    let cli = Cli::try_parse_from(["scn", "pr", "merge", "3"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Pr {
            command: PrCommand::Merge { number: 3, .. }
        }
    ));
    let cli = Cli::try_parse_from(["scn", "pr", "close", "3"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Pr {
            command: PrCommand::Close { number: 3, .. }
        }
    ));
}

#[test]
fn pr_create_success_url_uses_web_ui_org_repo_and_number() {
    let url = pull_request_web_url("acme", "demo", 17);
    let line = format!("created pull request #17 {url}");
    assert!(line.starts_with("created pull request #17 "));
    assert!(
        url.ends_with("/#/acme/demo/pulls/17"),
        "unexpected pull request url: {url}"
    );
    let web_override = std::env::var("SCN_WEB")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("OPENSCION_WEB")
                .ok()
                .filter(|value| !value.is_empty())
        });
    match web_override {
        Some(base) => {
            assert_eq!(
                url,
                format!("{}/#/acme/demo/pulls/17", base.trim_end_matches('/'))
            );
        }
        None => {
            assert_eq!(DEFAULT_WEB_UI, "https://scionbase.ai");
            assert_eq!(url, "https://scionbase.ai/#/acme/demo/pulls/17");
        }
    }
}

#[test]
fn issue_commands_parse() {
    let cli = Cli::try_parse_from(["scn", "issue", "create", "--title", "Bug"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Issue {
            command: IssueCommand::Create { title, .. }
        } if title == "Bug"
    ));
    let cli =
        Cli::try_parse_from(["scn", "issue", "comment", "3", "--body", "reproduced"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Issue {
            command: IssueCommand::Comment { number: 3, body, .. }
        } if body == "reproduced"
    ));
    let cli = Cli::try_parse_from(["scn", "issue", "comments", "3"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Issue {
            command: IssueCommand::Comments { number: 3, .. }
        }
    ));
}

#[test]
fn fixes_and_board_commands_parse() {
    let cli = Cli::try_parse_from([
        "scn", "pr", "create", "--title", "Fix", "--fixes", "1,2", "--head", "feat",
    ])
    .unwrap();
    assert!(matches!(
        cli.command,
        Command::Pr {
            command: PrCommand::Create { ref fixes, .. }
        } if fixes.as_deref() == Some("1,2")
    ));
    let cli = Cli::try_parse_from([
        "scn",
        "board",
        "create",
        "triage",
        "--org",
        "acme",
        "--tag",
        "bug",
        "--source",
        "filecoin-project",
        "--source",
        "other/lotus",
    ])
    .unwrap();
    assert!(matches!(
        cli.command,
        Command::Board {
            command: BoardCommand::Create { ref name, ref tag, ref org, ref sources, .. }
        } if name == "triage"
            && tag.as_deref() == Some("bug")
            && org.as_deref() == Some("acme")
            && sources == &["filecoin-project".to_owned(), "other/lotus".to_owned()]
    ));
    let cli = Cli::try_parse_from(["scn", "board", "list", "--org", "acme"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Board {
            command: BoardCommand::List { ref org, .. }
        } if org.as_deref() == Some("acme")
    ));
    let cli = Cli::try_parse_from(["scn", "board", "show", "triage", "--org", "acme"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Board {
            command: BoardCommand::Show { ref name, .. }
        } if name == "triage"
    ));
    let cli = Cli::try_parse_from(["scn", "board", "delete", "triage", "--org", "acme"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Board {
            command: BoardCommand::Delete { ref name, .. }
        } if name == "triage"
    ));
}

#[test]
fn commit_accepts_an_explicit_ref() {
    let cli = Cli::try_parse_from([
        "scn",
        "commit",
        "-m",
        "x",
        "--ref",
        "refs/heads/users/alice/x",
    ])
    .unwrap();
    assert!(matches!(
        cli.command,
        Command::Commit { ref ref_name, walk, .. }
            if ref_name.as_deref() == Some("refs/heads/users/alice/x") && !walk.allow_vcs
    ));
}

#[test]
fn upload_commands_accept_allow_vcs() {
    let cli = Cli::try_parse_from(["scn", "import", "--allow-vcs"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Import { walk, .. } if walk.allow_vcs
    ));
    let cli = Cli::try_parse_from(["scn", "commit", "-m", "x", "--allow-vcs"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Commit { walk, .. } if walk.allow_vcs
    ));
    let cli = Cli::try_parse_from(["scn", "push", "--allow-vcs"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Push { walk, .. } if walk.allow_vcs
    ));
}

#[test]
fn commands_default_their_ref_and_author() {
    let cli = Cli::try_parse_from(["scn", "import", "--repo", "local/default"]).unwrap();
    assert_eq!(
        cli.command,
        Command::Import {
            dir: ".".into(),
            repo: "local/default".to_owned(),
            ref_name: DEFAULT_REF.to_owned(),
            message: "import".to_owned(),
            author: std::env::var("SCN_AUTHOR")
                .or_else(|_| std::env::var("OPENSCION_AUTHOR"))
                .unwrap_or_else(|_| DEFAULT_AUTHOR.to_owned()),
            walk: UploadWalkArgs { allow_vcs: false },
        }
    );
}

#[test]
fn merge_pull_push_clone_and_repo_create_parse() {
    let cli = Cli::try_parse_from(["scn", "merge", "main"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Merge { ref r#ref, .. } if r#ref == "main"
    ));
    let cli = Cli::try_parse_from(["scn", "sync"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Sync { ref from, .. } if from == DEFAULT_REF
    ));
    let cli = Cli::try_parse_from(["scn", "sync", "--from", "other", "--dir", "/tmp/x"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Sync { ref from, ref dir } if from == "other" && dir.as_os_str() == "/tmp/x"
    ));
    let cli = Cli::try_parse_from(["scn", "pull"]).unwrap();
    assert!(matches!(cli.command, Command::Pull { .. }));
    let cli = Cli::try_parse_from(["scn", "push", "-m", "msg"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Push { ref message, .. } if message.as_deref() == Some("msg")
    ));
    let cli = Cli::try_parse_from(["scn", "clone", "acme/demo"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Clone { ref repo, dir: None, .. } if repo == "acme/demo"
    ));
    let cli =
        Cli::try_parse_from(["scn", "clone", "acme/demo", "./copy", "--branch", "dev"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Clone { ref repo, ref dir, ref branch, .. }
            if repo == "acme/demo"
                && dir.as_ref().map(|p| p.as_os_str()) == Some(std::ffi::OsStr::new("./copy"))
                && branch.as_deref() == Some("dev")
    ));
    let cli = Cli::try_parse_from(["scn", "completion", "bash"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Completion {
            shell: CompletionShell::Bash
        }
    ));
    let script = output(&cli);
    assert!(script.contains("scn"));
    assert!(script.contains("complete"));

    let cli = Cli::try_parse_from(["scn", "repo", "create", "my.repo_1"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Repo {
            command: RepoCommand::Create { ref name, org: None }
        } if name == "my.repo_1"
    ));
    let cli = Cli::try_parse_from(["scn", "clone", "./copy", "--repo", "acme/demo"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Clone { ref repo, ref repo_flag, .. }
            if repo == "./copy" && repo_flag.as_deref() == Some("acme/demo")
    ));

    let cli = Cli::try_parse_from(["scn", "repo", "create", "demo", "--org", "acme"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Repo {
            command: RepoCommand::Create { ref name, ref org }
        } if name == "demo" && org.as_deref() == Some("acme")
    ));
    let cli = Cli::try_parse_from(["scn", "org", "create", "acme"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Org {
            command: OrgCommand::Create { ref name }
        } if name == "acme"
    ));
    let cli = Cli::try_parse_from(["scn", "org", "list"]).unwrap();
    assert!(matches!(
        cli.command,
        Command::Org {
            command: OrgCommand::List
        }
    ));
}
