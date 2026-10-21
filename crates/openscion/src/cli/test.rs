//! Unit tests for command parsing and dispatch.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{self, Write};

use clap::Parser;
use openscion_core::PROTOCOL_VERSION;

use super::{Cli, Command, DEFAULT_AUTHOR, DEFAULT_REF, DEFAULT_SERVER, run};
use crate::Error;
use crate::test_support::{real_server, scratch, unreachable_server};

fn output(cli: &Cli) -> String {
    let mut out = Vec::new();
    run(cli, &mut out).unwrap();
    String::from_utf8(out).unwrap()
}

#[test]
fn the_server_defaults_to_a_local_openscion_server() {
    let cli = Cli::try_parse_from(["opnscn", "version"]).unwrap();
    assert_eq!(cli.server, DEFAULT_SERVER);
    assert_eq!(cli.command, Command::Version);
}

#[test]
fn server_is_accepted_after_the_subcommand() {
    let cli = Cli::try_parse_from(["opnscn", "server-info", "--server", "http://h:1"]).unwrap();
    assert_eq!(cli.server, "http://h:1");
    assert_eq!(cli.command, Command::ServerInfo);
}

#[test]
fn an_unknown_command_is_rejected() {
    assert!(Cli::try_parse_from(["opnscn", "frobnicate"]).is_err());
}

#[test]
fn version_prints_the_client_and_protocol_versions() {
    let cli = Cli::try_parse_from(["opnscn", "version"]).unwrap();
    let (major, minor) = PROTOCOL_VERSION;
    assert_eq!(
        output(&cli),
        format!(
            "opnscn {} (protocol {major}.{minor})\n",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn server_info_prints_what_the_server_reports() {
    let base = real_server();
    let cli = Cli::try_parse_from(["opnscn", "--server", &base, "server-info"]).unwrap();
    let (major, minor) = PROTOCOL_VERSION;
    assert_eq!(
        output(&cli),
        format!(
            "{base}: openscion-server {} (protocol {major}.{minor})\n",
            env!("CARGO_PKG_VERSION")
        )
    );
}

#[test]
fn server_info_fails_when_the_server_is_unreachable() {
    let cli =
        Cli::try_parse_from(["opnscn", "--server", &unreachable_server(), "server-info"]).unwrap();
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
    let cli = Cli::try_parse_from(["opnscn", "version"]).unwrap();
    let error = run(&cli, &mut BrokenPipe).unwrap_err();
    assert!(matches!(error, Error::Output(_)));
    assert!(error.to_string().starts_with("cannot write output: "));

    let cli = Cli::try_parse_from(["opnscn", "--server", &real_server(), "server-info"]).unwrap();
    assert!(matches!(run(&cli, &mut BrokenPipe), Err(Error::Output(_))));
}

#[test]
fn import_commit_and_clone_run_from_the_command_line() {
    let base = real_server();
    let source = scratch("cli-source");
    std::fs::write(source.join("a.txt"), b"a").unwrap();
    let dir = source.to_str().unwrap();

    let cli = Cli::try_parse_from([
        "opnscn",
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
    let cli = Cli::try_parse_from(["opnscn", "commit", "-m", "add b", "--dir", dir]).unwrap();
    assert!(output(&cli).starts_with("committed 1 changes as "));

    let dest = scratch("cli-clone").join("copy");
    let dest = dest.to_str().unwrap();
    let cli = Cli::try_parse_from([
        "opnscn",
        "--server",
        &base,
        "clone",
        dest,
        "--repo",
        "local/default",
        "--path",
        "b.txt",
    ])
    .unwrap();
    assert!(output(&cli).starts_with("cloned 1 files of "));
}

#[test]
fn clone_rejects_an_invalid_path() {
    let cli = Cli::try_parse_from([
        "opnscn",
        "clone",
        "x",
        "--repo",
        "local/default",
        "--path",
        "../up",
    ])
    .unwrap();
    assert!(matches!(run(&cli, &mut Vec::new()), Err(Error::Engine(_))));
}

#[test]
fn commands_default_their_ref_and_author() {
    let cli = Cli::try_parse_from(["opnscn", "import", "--repo", "local/default"]).unwrap();
    assert_eq!(
        cli.command,
        Command::Import {
            dir: ".".into(),
            repo: "local/default".to_owned(),
            ref_name: DEFAULT_REF.to_owned(),
            message: "import".to_owned(),
            author: std::env::var("OPENSCION_AUTHOR").unwrap_or_else(|_| DEFAULT_AUTHOR.to_owned()),
        }
    );
}
