//! Runs the `scn` binary the way a user would.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::net::TcpListener;
use std::process::Command;

const BINARY: &str = env!("CARGO_BIN_EXE_scn");

#[test]
fn version_succeeds_and_prints_the_client_version() {
    let output = Command::new(BINARY).arg("version").output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with(&format!("scn {} ", env!("CARGO_PKG_VERSION"))));
}

#[test]
fn server_info_fails_with_a_message_when_no_server_is_listening() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);

    let output = Command::new(BINARY)
        .args(["server-info", "--server", &base])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with(&format!("scn: request to {base}/v1/version failed: ")));
}
