//! Integration tests that exercise `opnscn ci` and `opnscn runner` subcommands end-to-end
//! to cover the non-test HTTP path in `cli/ci.rs` (`call` under #[cfg(not(test))]).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use tempfile::tempdir;

const BINARY: &str = env!("CARGO_BIN_EXE_opnscn");

fn start_ci_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        // Respond to a finite sequence of requests; loop ends when a 404 is served.
        for stream in listener.incoming().flatten() {
            let mut s = stream;
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let req = String::from_utf8_lossy(&buf);
            let first = req.lines().next().unwrap_or_default().to_owned();
            // Very small router based on METHOD SP PATH
            let response = if first.starts_with("POST /v1/repos/o/r/checks ") {
                // Report
                let body = format!(r#"{{"state":"success","changeset":"{}"}}"#, "0".repeat(64));
                format!(
                    "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else if first.starts_with("GET /v1/repos/o/r/checks?ref=main ") {
                // List
                let body = r#"{"changeset":"0000000000000000000000000000000000000000000000000000000000000000","docker_tests":"queued","checks":[{"id":"cid","name":"unit","state":"success","summary":"ok","duration_ms":42}], "required":["unit"]}"#;
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else if first.starts_with("GET /v1/repos/o/r/checks/cid/log ") {
                // Log
                let body = "LOG";
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else if first.starts_with("POST /v1/repos/o/r/checks/rerun ") {
                // Rerun
                let body = r"{}";
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else if first.starts_with("POST /v1/repos/o/r/runners ") {
                // Register runner
                let body = r#"{"id":"rid","name":"mock","labels":["linux"],"token":"tok"}"#;
                format!(
                    "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else if first.starts_with("GET /v1/repos/o/r/runners ") {
                // List runners
                // last_seen value does not matter for coverage purposes
                let last_seen = "1000".to_owned();
                let body = format!(
                    r#"{{"runners":[{{"name":"mock","labels":["linux"],"last_seen":{last_seen}}}]}}"#
                );
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else if first.starts_with("DELETE /v1/repos/o/r/runners/mock ") {
                // Remove runner
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n".to_owned()
            } else if first.starts_with("POST /v1/runners/poll ") {
                // Poll: no jobs (exercise Ok(_) branch)
                let body = r"{}";
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
            } else {
                // Unknown: end loop
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_owned()
            };
            let _ = s.write_all(response.as_bytes());
            if response.starts_with("HTTP/1.1 404") {
                break;
            }
        }
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

#[test]
fn ci_and_runner_commands_cover_real_http_path() {
    let tmp = tempdir().unwrap();
    let (base, _h) = start_ci_server();
    // Prepare a small log file for --log
    let log_path = tmp.path().join("log.txt");
    std::fs::write(&log_path, "sample\n").unwrap();

    // ci report
    let status = Command::new(BINARY)
        .args([
            "ci",
            "report",
            "unit",
            "--state",
            "success",
            "--repo",
            "o/r",
            "--ref",
            "main",
            "--summary",
            "ok",
            "--url",
            "https://run.example/1",
            "--log",
            &log_path.display().to_string(),
            "--server",
            &base,
        ])
        .status()
        .unwrap();
    assert!(status.success());

    // ci list
    let status = Command::new(BINARY)
        .args([
            "ci", "list", "--repo", "o/r", "--ref", "main", "--server", &base,
        ])
        .status()
        .unwrap();
    assert!(status.success());

    // ci log
    let output = Command::new(BINARY)
        .args([
            "ci", "log", "unit", "--repo", "o/r", "--ref", "main", "--server", &base,
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout), "LOG");

    // ci rerun
    let status = Command::new(BINARY)
        .args([
            "ci", "rerun", "unit", "--repo", "o/r", "--ref", "main", "--server", &base,
        ])
        .status()
        .unwrap();
    assert!(status.success());

    // runner register/list/remove/run (once) with isolated config dir
    let xdg = tmp.path().join("xdg");
    std::fs::create_dir_all(&xdg).unwrap();
    let base_cmd = || {
        let mut c = Command::new(BINARY);
        c.env("XDG_CONFIG_HOME", &xdg);
        c
    };
    // register
    let status = base_cmd()
        .args([
            "runner", "register", "--repo", "o/r", "--labels", "linux", "--server", &base,
        ])
        .env("SCN_TOKEN", "tok")
        .status()
        .unwrap();
    assert!(status.success());
    // run once (no jobs)
    let workdir: PathBuf = tmp.path().join("jobs");
    let status = base_cmd()
        .args([
            "runner",
            "run",
            "--repo",
            "o/r",
            "--once",
            "--workdir",
            &workdir.display().to_string(),
            "--server",
            &base,
        ])
        // runner run uses SCN_RUNNER_TOKEN falling back to saved token; server ignores it
        .env("SCN_RUNNER_TOKEN", "tok")
        .status()
        .unwrap();
    assert!(status.success());
    // list
    let status = base_cmd()
        .args(["runner", "list", "--repo", "o/r", "--server", &base])
        .env("SCN_TOKEN", "tok")
        .status()
        .unwrap();
    assert!(status.success());
    // remove
    let status = base_cmd()
        .args([
            "runner", "remove", "mock", "--repo", "o/r", "--server", &base,
        ])
        .env("SCN_TOKEN", "tok")
        .status()
        .unwrap();
    assert!(status.success());
    // Do not join the server thread; let it exit with the process.
}
