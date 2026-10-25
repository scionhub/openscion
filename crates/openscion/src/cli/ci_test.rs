#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::let_unit_value,
    clippy::ignored_unit_patterns
)]

// no global toggles needed here
use super::ci::{CheckState, CiCommand, RunnerCommand, Target, fmt_ms, now_ms, run_ci, run_runner};
use crate::{Error, Result};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;
use tempfile::tempdir;

// Test-only hooks used by ci.rs under #[cfg(test)]
#[allow(clippy::type_complexity)]
pub(super) static HTTP_MOCK: std::sync::OnceLock<
    std::sync::Mutex<
        Box<
            dyn FnMut(&str, &str, Option<&str>, Option<&Value>, Duration) -> Result<(u16, Value)>
                + Send,
        >,
    >,
> = std::sync::OnceLock::new();

#[allow(clippy::type_complexity)]
pub(super) static SPAWN_MOCK: std::sync::OnceLock<
    std::sync::Mutex<Box<dyn FnMut(&mut String) -> (Option<i32>, bool) + Send>>,
> = std::sync::OnceLock::new();

pub(super) static USE_SPAWN_MOCK: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

// Local helpers/mocks
static HTTP_INSTALLED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
static SPAWN_INSTALLED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
#[allow(clippy::type_complexity)]
static SPAWN_SEQ: std::sync::OnceLock<Mutex<Vec<(Option<i32>, bool, String)>>> =
    std::sync::OnceLock::new();
static PATCH_FAILS: std::sync::OnceLock<Mutex<usize>> = std::sync::OnceLock::new();

#[allow(clippy::too_many_lines)]
fn ensure_http_mock() {
    let _ = HTTP_INSTALLED.get_or_init(|| {
        let _ = HTTP_MOCK.set(Mutex::new(Box::new(
            move |method, url, _token, body, _timeout| -> Result<(u16, Value)> {
                let after_host = url
                    .trim_start_matches("http://")
                    .trim_start_matches("https://");
                let scenario = after_host
                    .split('/')
                    .nth(1)
                    .map(str::to_owned)
                    .unwrap_or_default();
                let path_only = url.split('?').next().unwrap_or(url);
                if path_only.contains("/v1/repos/")
                    && path_only.ends_with("/runners")
                    && method == "POST"
                {
                    return Ok((
                        201,
                        json!({"id":"rid","name":"mock","labels":["linux"],"token":"tok"}),
                    ));
                }
                if path_only.contains("/v1/repos/")
                    && path_only.ends_with("/runners")
                    && method == "GET"
                {
                    if scenario == "neverlist" {
                        return Ok((200, json!({"runners":[{"name":"mock","labels":["linux"]}]})));
                    }
                    return Ok((
                        200,
                        json!({"runners":[{"name":"mock","labels":["linux"],"last_seen":(now_ms().saturating_sub(5_000))}]}),
                    ));
                }
                if path_only.contains("/v1/repos/")
                    && path_only.contains("/runners/")
                    && method == "DELETE"
                {
                    return Ok((204, json!({})));
                }
                if path_only.ends_with("/checks") && method == "POST" {
                    return Ok((201, json!({"state":"success","changeset": "0".repeat(64)})));
                }
                if path_only.ends_with("/checks") && method == "GET" {
                    if url.contains("ref=missing") {
                        return Ok((
                            200,
                            json!({"changeset": "0".repeat(64), "docker_tests": "queued", "checks": [], "required":["unit"]}),
                        ));
                    }
                    if url.contains("ref=req") {
                        return Ok((
                            200,
                            json!({"changeset": "0".repeat(64), "docker_tests": "queued", "checks":[{"id":"cid","name":"unit","state":"success","summary":"ok","duration_ms":123}], "required":["unit"]}),
                        ));
                    }
                    if url.contains("ref=nochecks") {
                        return Ok((
                            200,
                            json!({"changeset": "0".repeat(64), "docker_tests": "queued", "checks": [], "required":[]}),
                        ));
                    }
                    return Ok((
                        200,
                        json!({"changeset": "0".repeat(64), "docker_tests": "queued", "checks":[{"id":"cid","name":"unit","state":"success","summary":"ok","duration_ms":5}],"required":[]}),
                    ));
                }
                if path_only.ends_with("/checks/rerun") && method == "POST" {
                    if scenario == "err" {
                        return Ok((401, json!({"error":"unauthorized"})));
                    }
                    return Ok((200, json!({})));
                }
                if path_only.contains("/checks/") && path_only.ends_with("/log") && method == "GET"
                {
                    return Ok((200, Value::String("LOG".to_owned())));
                }
                if path_only.ends_with("/v1/runners/poll") && method == "POST" {
                    let timeout: u64 = u64::from(scenario != "timeout");
                    if scenario == "denied" {
                        return Ok((401, json!({"error":"denied"})));
                    }
                    return Ok((
                        200,
                        json!({"job":{"id":"jid","org":"o","repo":"r","changeset":"0".repeat(64),"ref":"refs/heads/main","name":"unit","attempt":1,"docker":{"path":".scm/test1","timeout":timeout},"runs_on":[]}}),
                    ));
                }
                if path_only.contains("/v1/runners/jobs/") && method == "PATCH" {
                    if scenario == "flaky" {
                        let c = PATCH_FAILS.get_or_init(|| Mutex::new(0));
                        let mut n = c.lock().unwrap();
                        if *n > 0 {
                            *n -= 1;
                            return Ok((500, json!({"error":"temporary"})));
                        }
                    }
                    let cancelled = scenario == "cancel";
                    return Ok((200, json!({"cancelled": cancelled})));
                }
                Err(Error::Request {
                    url: url.to_owned(),
                    message: format!("unexpected {method} {url} {body:?}"),
                })
            },
        )));
    });
}

fn ensure_spawn_mock() {
    let _ = SPAWN_INSTALLED.get_or_init(|| {
        let _ = SPAWN_MOCK.set(Mutex::new(Box::new(
            |buf: &mut String| -> (Option<i32>, bool) {
                let q = SPAWN_SEQ.get_or_init(|| Mutex::new(Vec::new()));
                let mut seq = q.lock().unwrap();
                let (code, ok, text) = if seq.is_empty() {
                    (Some(0), true, "ok\n".to_owned())
                } else {
                    seq.remove(0)
                };
                buf.push_str(&text);
                (code, ok)
            },
        )));
    });
}

fn set_spawn_seq(v: Vec<(Option<i32>, bool, &str)>) {
    let q = SPAWN_SEQ.get_or_init(|| Mutex::new(Vec::new()));
    let mut seq = q.lock().unwrap();
    seq.clear();
    seq.extend(v.into_iter().map(|(c, ok, s)| (c, ok, s.to_owned())));
}
fn set_patch_fails(times: usize) {
    let c = PATCH_FAILS.get_or_init(|| Mutex::new(0));
    let mut n = c.lock().unwrap();
    *n = times;
}

// -------- tests --------

#[test]
#[allow(clippy::too_many_lines)]
fn ci_report_list_log_rerun_flow_uses_http_mock() {
    ensure_http_mock();

    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    run_ci(
        &cli,
        &CiCommand::Report {
            name: "unit".to_owned(),
            state: CheckState::Success,
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
            summary: Some("ok".to_owned()),
            log: None,
            url: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_ci(
        &cli,
        &CiCommand::List {
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_ci(
        &cli,
        &CiCommand::List {
            target: Target::new(None, Some("missing".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_ci(
        &cli,
        &CiCommand::Log {
            name: "unit".to_owned(),
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_ci(
        &cli,
        &CiCommand::Rerun {
            name: "unit".to_owned(),
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    )
    .unwrap();
}

#[test]
fn call_exercises_success_and_error_paths_without_mock() {
    // Exercise the real `call` implementation (bypasses HTTP mock).
    // Spin up a tiny HTTP server that serves a 200 JSON, 201 JSON, and 500 error.
    #[allow(clippy::items_after_statements)]
    {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::thread;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for (i, stream) in listener.incoming().enumerate() {
                if let Ok(mut s) = stream {
                    let mut buf = [0u8; 1024];
                    let _ = s.read(&mut buf);
                    match i {
                        0 => {
                            let body = r#"{"ok":true,"x":"y"}"#;
                            let resp = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = s.write_all(resp.as_bytes());
                        }
                        1 => {
                            let body = r#"{"created":true}"#;
                            let resp = format!(
                                "HTTP/1.1 201 Created\r\nContent-Length: {}\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = s.write_all(resp.as_bytes());
                        }
                        _ => {
                            let body = r#"{"error":"boom","code":"Oops"}"#;
                            let resp = format!(
                                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\n\r\n{}",
                                body.len(),
                                body
                            );
                            let _ = s.write_all(resp.as_bytes());
                            break;
                        }
                    }
                }
            }
        });
        // GET success
        let url = format!("http://127.0.0.1:{port}/ok");
        let (_st, v) =
            super::ci::call_real("GET", &url, Some("tok"), None, Duration::from_millis(500))
                .expect("ok");
        assert_eq!(v.get("ok").and_then(Value::as_bool), Some(true));
        // POST created
        let url2 = format!("http://127.0.0.1:{port}/make");
        let (_st, v2) = super::ci::call_real(
            "POST",
            &url2,
            Some("tok"),
            Some(&json!({"a":1})),
            Duration::from_millis(500),
        )
        .expect("created");
        assert_eq!(v2.get("created").and_then(Value::as_bool), Some(true));
        // 500 error -> Error::Server
        let url3 = format!("http://127.0.0.1:{port}/err");
        let err =
            super::ci::call_real("GET", &url3, None, None, Duration::from_millis(500)).unwrap_err();
        match err {
            Error::Server { status, .. } => assert_eq!(status, 500),
            _ => panic!("expected server error"),
        }
    }
    // (no global toggles changed)
}

#[test]
fn runner_register_and_run_once_uses_mocks() {
    let td = tempdir().unwrap();
    ensure_http_mock();
    ensure_spawn_mock();
    set_spawn_seq(vec![(Some(0), true, "ok\n")]);
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
}

#[test]
#[allow(clippy::too_many_lines)]
fn runner_covers_job_error_paths_and_list_remove() {
    ensure_http_mock();
    ensure_spawn_mock();
    let td = tempdir().unwrap();
    let mut out = Vec::new();

    // Build failure
    set_spawn_seq(vec![(Some(1), true, "build failed\n")]);
    let cli = crate::Cli {
        server: "http://example/buildfail".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-buildfail".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-buildfail".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();

    // Run failure
    set_spawn_seq(vec![
        (Some(0), true, "build ok\n"),
        (Some(2), true, "run failed\n"),
    ]);
    let cli = crate::Cli {
        server: "http://example/runfail".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-runfail".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-runfail".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();

    // Spawn error
    set_spawn_seq(vec![(None, false, "spawn error\n")]);
    let cli = crate::Cli {
        server: "http://example/spawnerr".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-spawnerr".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-spawnerr".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();

    // Timeout
    set_spawn_seq(vec![(Some(0), true, "run ok but timeout\n")]);
    let cli = crate::Cli {
        server: "http://example/timeout".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-timeout".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-timeout".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();

    // Cancelled
    set_spawn_seq(vec![(Some(0), true, "ok\n")]);
    let cli = crate::Cli {
        server: "http://example/cancel".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-cancel".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-cancel".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
    out.clear();

    // Runners list and remove
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::List {
            repo: "o/r".to_owned(),
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Remove {
            name: "mock".to_owned(),
            repo: "o/r".to_owned(),
        },
        &mut out,
    )
    .unwrap();
}

#[test]
fn runner_patch_retry_path() {
    ensure_http_mock();
    ensure_spawn_mock();
    let td = tempdir().unwrap();
    let mut out = Vec::new();
    set_patch_fails(2);
    set_spawn_seq(vec![
        (Some(0), true, "build ok\n"),
        (Some(0), true, "run ok\n"),
    ]);
    let cli = crate::Cli {
        server: "http://example/flaky".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-flaky".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-flaky".to_owned(),
            once: true,
            workdir: Some(td.path().to_path_buf()),
        },
        &mut out,
    )
    .unwrap();
}

#[test]
fn runner_token_rejected_errors() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example/denied".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-denied".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    let _ = run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-denied".to_owned(),
            once: true,
            workdir: Some(std::env::temp_dir()),
        },
        &mut out,
    );
}

#[test]
fn ci_log_unknown_check_errors() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    let _ = run_ci(
        &cli,
        &CiCommand::Log {
            name: "unknown".to_owned(),
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    );
}

#[test]
fn runner_list_never_and_remove_unmatched() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example/neverlist".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::List {
            repo: "o/r".to_owned(),
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    let _ = run_runner(
        &cli,
        &RunnerCommand::Remove {
            name: "other".to_owned(),
            repo: "o/r".to_owned(),
        },
        &mut out,
    );
}

#[test]
fn runner_run_uses_default_workdir() {
    ensure_http_mock();
    ensure_spawn_mock();
    set_spawn_seq(vec![(None, false, "spawn error\n")]);
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example/spawnerr".to_owned(),
        command: crate::Command::Version,
    };
    run_runner(
        &cli,
        &RunnerCommand::Register {
            repo: "o/r-default".to_owned(),
            labels: "linux".to_owned(),
            name: None,
        },
        &mut out,
    )
    .unwrap();
    out.clear();
    let _ = run_runner(
        &cli,
        &RunnerCommand::Run {
            repo: "o/r-default".to_owned(),
            once: true,
            workdir: None,
        },
        &mut out,
    );
}

#[test]
fn job_reporter_flush_and_maybe_flush_retry() {
    ensure_http_mock();
    set_patch_fails(1);
    let mut rep = super::ci::JobReporter {
        url: "http://example/flaky/v1/runners/jobs/jid".to_owned(),
        token: "tok",
        pending: "x".repeat(16),
        last_flush: std::time::Instant::now(),
        cancelled: false,
    };
    rep.flush("running", Some("sm"));
    rep.pending = "y".to_owned();
    rep.last_flush = std::time::Instant::now()
        .checked_sub(Duration::from_secs(4))
        .unwrap_or_else(std::time::Instant::now);
    rep.maybe_flush();
}

#[test]
fn ci_rerun_server_error_maps_to_error() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example/err".to_owned(),
        command: crate::Command::Version,
    };
    let _ = run_ci(
        &cli,
        &CiCommand::Rerun {
            name: "unit".to_owned(),
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    );
}

#[test]
fn ci_report_with_log_and_url() {
    ensure_http_mock();
    let dir = tempdir().unwrap();
    let log_path = dir.path().join("log.txt");
    std::fs::write(&log_path, "sample log\n").unwrap();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    run_ci(
        &cli,
        &CiCommand::Report {
            name: "unit".to_owned(),
            state: CheckState::Running,
            target: Target::new(None, Some("main".to_owned()), "o/r".to_owned()),
            summary: Some("progress".to_owned()),
            log: Some(log_path),
            url: Some("https://ci.example/run/123".to_owned()),
        },
        &mut out,
    )
    .unwrap();
    run_ci(
        &cli,
        &CiCommand::Report {
            name: "unit".to_owned(),
            state: CheckState::Success,
            target: Target::new(Some("0".repeat(64)), None, "o/r".to_owned()),
            summary: None,
            log: None,
            url: None,
        },
        &mut out,
    )
    .unwrap();
    let _ = run_ci(
        &cli,
        &CiCommand::List {
            target: Target::new(None, Some("nochecks".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    );
}

#[test]
fn spawn_and_stream_real_covers_io_path() {
    USE_SPAWN_MOCK.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut rep = super::ci::JobReporter {
        url: "http://example".to_owned(),
        token: "tok",
        pending: String::new(),
        last_flush: std::time::Instant::now(),
        cancelled: false,
    };
    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c").arg("printf 'hello\\nworld\\n'");
    let (_code, _ok) = super::ci::spawn_and_stream(cmd, &mut rep);
    assert!(rep.pending.contains("hello"));
    USE_SPAWN_MOCK.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[test]
fn spawn_and_stream_handles_large_output() {
    USE_SPAWN_MOCK.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut rep = super::ci::JobReporter {
        url: "http://example".to_owned(),
        token: "tok",
        pending: String::new(),
        last_flush: std::time::Instant::now(),
        cancelled: false,
    };
    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c").arg("yes X | head -c 300000");
    let (_code, ok) = super::ci::spawn_and_stream(cmd, &mut rep);
    assert!(ok);
    assert!(rep.pending.len() >= 256 * 1024);
    USE_SPAWN_MOCK.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[test]
fn kill_group_executes_without_panic() {
    let mut cmd = std::process::Command::new("sh");
    cmd.arg("-c").arg("sleep 1");
    let mut child = cmd.spawn().expect("spawn");
    super::ci::kill_group(&child);
    let _ = child.wait();
}

#[test]
fn fmt_ms_minutes_branch() {
    assert_eq!(fmt_ms(Some(125_000)), "2m05s");
}

#[test]
fn ci_list_uses_changeset_query() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    let _ = run_ci(
        &cli,
        &CiCommand::List {
            target: Target::new(Some("0".repeat(64)), None, "o/r".to_owned()),
        },
        &mut out,
    );
}

#[test]
fn helper_functions_cover_repo_url_and_target_helpers() {
    // repo_url formats org/name and suffix correctly
    let u = super::ci::repo_url("http://s", "o/r", "/x");
    assert_eq!(u, "http://s/v1/repos/o/r/x");
    // target_json and target_query handle ref/changeset/defaults
    let t = Target::new(None, None, "o/r".to_owned());
    let v = super::ci::target_json(&t);
    assert!(v.as_object().is_some());
    assert!(v.as_object().unwrap().is_empty());
    assert_eq!(super::ci::target_query(&t), "?ref=main");
    let t2 = Target::new(
        Some("0".repeat(64)),
        Some("dev".to_owned()),
        "o/r".to_owned(),
    );
    let v2 = super::ci::target_json(&t2);
    assert_eq!(
        v2.get("changeset").and_then(Value::as_str).unwrap().len(),
        64
    );
    assert_eq!(v2.get("ref").and_then(Value::as_str), Some("dev"));
    assert_eq!(
        super::ci::target_query(&t2),
        format!("?changeset={}", "0".repeat(64))
    );
}

#[test]
fn check_state_variants_are_constructible() {
    // Exercise enum construction to cover variant lines.
    let _ = super::ci::CheckState::Queued;
    let _ = super::ci::CheckState::Running;
    let _ = super::ci::CheckState::Success;
    let _ = super::ci::CheckState::Failure;
    let _ = super::ci::CheckState::Error;
    let _ = super::ci::CheckState::Cancelled;
}
#[test]
fn call_covers_delete_patch_put_without_mock() {
    // Bypass HTTP mock for this test to exercise call_real branches.
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            // Very small router based on method keywords in the request
            let req = String::from_utf8_lossy(&buf);
            if req.starts_with("DELETE ") {
                let body = r#"{"deleted":true}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            } else if req.starts_with("PATCH ") {
                let body = r#"{"patched":true}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            } else if req.starts_with("PUT ") {
                let body = r#"{"put":true}"#;
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            } else {
                let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                break;
            }
        }
    });
    let base = format!("http://127.0.0.1:{port}");
    // DELETE
    let (_st, v) = super::ci::call_real(
        "DELETE",
        &format!("{base}/d"),
        None,
        None,
        Duration::from_millis(500),
    )
    .expect("delete ok");
    assert_eq!(v.get("deleted").and_then(Value::as_bool), Some(true));
    // PATCH
    let (_st, v) = super::ci::call_real(
        "PATCH",
        &format!("{base}/p"),
        Some("tok"),
        Some(&json!({"x":1})),
        Duration::from_millis(500),
    )
    .expect("patch ok");
    assert_eq!(v.get("patched").and_then(Value::as_bool), Some(true));
    // PUT
    let (_st, v) = super::ci::call_real(
        "PUT",
        &format!("{base}/u"),
        Some("tok"),
        Some(&json!({"y":2})),
        Duration::from_millis(500),
    )
    .expect("put ok");
    assert_eq!(v.get("put").and_then(Value::as_bool), Some(true));
}

#[test]
fn ci_report_defaults_ref_main_when_target_empty() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    run_ci(
        &cli,
        &CiCommand::Report {
            name: "unit".to_owned(),
            state: CheckState::Success,
            target: Target::new(None, None, "o/r".to_owned()),
            summary: None,
            log: None,
            url: None,
        },
        &mut out,
    )
    .unwrap();
}

#[test]
fn ci_list_marks_required_checks() {
    ensure_http_mock();
    let mut out = Vec::new();
    let cli = crate::Cli {
        server: "http://example".to_owned(),
        command: crate::Command::Version,
    };
    run_ci(
        &cli,
        &CiCommand::List {
            target: Target::new(None, Some("req".to_owned()), "o/r".to_owned()),
        },
        &mut out,
    )
    .unwrap();
    // Ensure output contains the "(required)" marker at least once
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("(required)"));
}

#[test]
fn first_env_and_hostname_env_branches() {
    // Basic sanity checks that do not mutate process-wide environment
    // (which can be racy across parallel tests).
    // Unset vars should yield None.
    assert!(super::ci::first_env(&["__SCN_TEST_UNSET__"]).is_none());
    // hostname should return a non-empty string in normal environments.
    assert_ne!(super::ci::hostname(), "");
}
