//! Runs the `openscion-server` binary the way an operator would.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Command, Stdio};

const BINARY: &str = env!("CARGO_BIN_EXE_openscion-server");

#[cfg(unix)]
#[test]
fn serves_until_sigterm_then_exits_cleanly() {
    let mut child = Command::new(BINARY)
        .args(["--listen", "127.0.0.1:0"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let base = line
        .trim()
        .strip_prefix("openscion-server listening on ")
        .unwrap()
        .to_owned();

    let body = ureq::get(&format!("{base}/healthz"))
        .call()
        .unwrap()
        .body_mut()
        .read_to_string()
        .unwrap();
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["name"], "scionbase-server");
    assert_eq!(json["status"], "ok");

    let killed = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(killed.success());
    assert!(child.wait().unwrap().success());
}

#[test]
fn exits_with_failure_when_the_address_is_taken() {
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = taken.local_addr().unwrap().to_string();

    let output = Command::new(BINARY)
        .args(["--listen", &addr])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with(&format!("openscion-server: cannot listen on {addr}: ")));
}
