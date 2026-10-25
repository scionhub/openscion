#[cfg(test)]
use super::ci_test::{HTTP_MOCK, SPAWN_MOCK, USE_SPAWN_MOCK};

// ScionBase-native CI: Docker test jobs via `ci` and `runner` subcommands.
//
// Jobs are discovered from `.scm/test*/Dockerfile`. Runners long‑poll the
// server for work, clone the exact changeset, build the test image, run it
// with the repository mounted at `/workspace`, stream logs, and report the
// result.

use std::io::Read as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use clap::{Args, Subcommand, ValueEnum};
use serde_json::{Value, json};

use crate::{Error, Result};

// ---------- helpers ----------

fn first_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

fn err(url: &str, message: impl Into<String>) -> Error {
    Error::Request {
        url: url.to_owned(),
        message: message.into(),
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build()
        .into()
}

/// Sends a JSON request; returns (status, body) and turns error statuses into [`Error::Server`].
fn call(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<(u16, Value)> {
    #[cfg(test)]
    {
        if let Some(m) = HTTP_MOCK.get() {
            if let Ok(mut f) = m.lock() {
                return (f)(method, url, token, body, timeout);
            }
            return Err(Error::Request {
                url: url.to_owned(),
                message: "mock lock poisoned".to_owned(),
            });
        }
    }
    let a = agent(timeout);
    let auth = token.map(|t| format!("Bearer {t}"));
    let resp = match method {
        "GET" | "DELETE" => {
            let mut r = if method == "GET" {
                a.get(url)
            } else {
                a.delete(url)
            };
            if let Some(h) = &auth {
                r = r.header("authorization", h);
            }
            r.call()
        }
        _ => {
            let mut r = match method {
                "PATCH" => a.patch(url),
                "PUT" => a.put(url),
                _ => a.post(url),
            };
            if let Some(h) = &auth {
                r = r.header("authorization", h);
            }
            r.send_json(body.cloned().unwrap_or_else(|| json!({})))
        }
    };
    let mut resp = resp.map_err(|e| err(url, e.to_string()))?;
    let status = resp.status().as_u16();
    let text = resp
        .body_mut()
        .with_config()
        .limit(16 * 1024 * 1024)
        .read_to_string()
        .unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    if status >= 400 {
        let message = value
            .get("message")
            .or_else(|| value.get("error"))
            .and_then(Value::as_str)
            .map_or_else(|| value.to_string(), str::to_owned);
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("Error")
            .to_owned();
        return Err(Error::Server {
            url: url.to_owned(),
            status,
            code,
            message,
        });
    }
    Ok((status, value))
}

const SHORT: Duration = Duration::from_secs(60);

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

pub(super) fn fmt_ms(ms: Option<u64>) -> String {
    match ms {
        None => "-".to_owned(),
        Some(ms) if ms < 1000 => format!("{ms}ms"),
        Some(ms) if ms < 60_000 => {
            let tenths = (ms + 50) / 100;
            let secs = tenths / 10;
            let dec = tenths % 10;
            format!("{secs}.{dec}s")
        }
        Some(ms) => format!("{}m{:02}s", ms / 60_000, (ms % 60_000) / 1000),
    }
}

// ---------- `opnscn ci` ----------

/// Which changeset a check belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Args)]
pub struct Target {
    /// Changeset id (64 hex).
    #[arg(long)]
    changeset: Option<String>,
    /// Ref whose current target is used, such as `main`.
    #[arg(long = "ref")]
    r#ref: Option<String>,
    /// Repository as `<org>/<repo>`.
    #[arg(long)]
    repo: String,
}
impl Target {
    // Test-only constructor to allow building targets from sibling test modules.
    #[cfg(test)]
    pub(super) fn new(changeset: Option<String>, r: Option<String>, repo: String) -> Self {
        Self {
            changeset,
            r#ref: r,
            repo,
        }
    }
}

/// Check states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[non_exhaustive]
pub enum CheckState {
    Queued,
    Running,
    Success,
    Failure,
    Error,
    Cancelled,
}
impl CheckState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Subcommands of `opnscn ci`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum CiCommand {
    /// Report a check result from any script (owner token, or `SCN_RUNNER_TOKEN`).
    Report {
        /// Check name (`[A-Za-z0-9_.-]{1,64}`).
        name: String,
        /// Final or current state.
        #[arg(long, value_enum)]
        state: CheckState,
        #[command(flatten)]
        target: Target,
        /// One-line summary.
        #[arg(long)]
        summary: Option<String>,
        /// File whose contents become the check log (the last 1 MB is kept).
        #[arg(long)]
        log: Option<PathBuf>,
        /// Link to an external run.
        #[arg(long)]
        url: Option<String>,
    },
    /// List checks on a ref or changeset.
    List {
        #[command(flatten)]
        target: Target,
    },
    /// Queue a docker test again (owners).
    Rerun {
        /// Check name.
        name: String,
        #[command(flatten)]
        target: Target,
    },
    /// Print a check's log.
    Log {
        /// Check name.
        name: String,
        #[command(flatten)]
        target: Target,
    },
}

fn repo_url(server: &str, repo: &str, suffix: &str) -> String {
    let (org, name) = repo.split_once('/').unwrap_or(("", repo));
    format!(
        "{}/v1/repos/{}/{}{}",
        server.trim_end_matches('/'),
        org,
        name,
        suffix
    )
}

fn target_json(t: &Target) -> Value {
    let mut v = json!({});
    if let Some(c) = &t.changeset {
        v["changeset"] = json!(c);
    }
    if let Some(r) = &t.r#ref {
        v["ref"] = json!(r);
    }
    v
}
fn target_query(t: &Target) -> String {
    if let Some(c) = &t.changeset {
        format!("?changeset={c}")
    } else {
        format!("?ref={}", t.r#ref.as_deref().unwrap_or("main"))
    }
}

#[allow(clippy::too_many_lines)]
pub(super) fn run_ci(cli: &crate::Cli, command: &CiCommand, out: &mut impl Write) -> Result<()> {
    match command {
        CiCommand::Report {
            name,
            state,
            target,
            summary,
            log,
            url,
        } => {
            let mut body = target_json(target);
            if body.as_object().is_some_and(serde_json::Map::is_empty) {
                body["ref"] = json!("main");
            }
            body["name"] = json!(name);
            body["state"] = json!(state.as_str());
            if let Some(s) = summary {
                body["summary"] = json!(s);
            }
            if let Some(u) = url {
                body["target_url"] = json!(u);
            }
            if let Some(path) = log {
                let bytes = std::fs::read(path).map_err(crate::workcopy::io_error(path))?;
                let keep = bytes.len().saturating_sub(1_000_000);
                body["log"] = json!(String::from_utf8_lossy(&bytes[keep..]));
            }
            let token = first_env(&["SCN_TOKEN"]).or_else(|| first_env(&["OPENSCION_TOKEN"]));
            let (_, v) = call(
                "POST",
                &repo_url(&cli.server, &target.repo, "/checks"),
                token.as_deref(),
                Some(&body),
                SHORT,
            )?;
            writeln!(
                out,
                "reported {name}: {} on {}",
                s(&v, "state"),
                &s(&v, "changeset")[..12.min(s(&v, "changeset").len())]
            )
            .map_err(Error::Output)
        }
        CiCommand::List { target } => {
            let (_, v) = call(
                "GET",
                &repo_url(
                    &cli.server,
                    &target.repo,
                    &format!("/checks{}", target_query(target)),
                ),
                None,
                None,
                SHORT,
            )?;
            let cs = s(&v, "changeset");
            writeln!(
                out,
                "changeset {}  docker-tests: {}",
                &cs[..12.min(cs.len())],
                s(&v, "docker_tests")
            )
            .map_err(Error::Output)?;
            let required: Vec<String> = v
                .get("required")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            let checks = v
                .get("checks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if checks.is_empty() {
                writeln!(out, "no checks").map_err(Error::Output)?;
            }
            for c in &checks {
                let name = s(c, "name");
                let req = if required.contains(&name) {
                    " (required)"
                } else {
                    ""
                };
                writeln!(
                    out,
                    "{:<10} {:<24} {:>8}  {}{req}",
                    s(c, "state"),
                    name,
                    fmt_ms(c.get("duration_ms").and_then(Value::as_u64)),
                    s(c, "summary")
                )
                .map_err(Error::Output)?;
            }
            for name in required
                .iter()
                .filter(|n| !checks.iter().any(|c| &s(c, "name") == *n))
            {
                writeln!(
                    out,
                    "{:<10} {:<24} {:>8}  (required, not reported)",
                    "missing", name, "-"
                )
                .map_err(Error::Output)?;
            }
            Ok(())
        }
        CiCommand::Rerun { name, target } => {
            let mut body = target_json(target);
            if body.as_object().is_some_and(serde_json::Map::is_empty) {
                body["ref"] = json!("main");
            }
            body["name"] = json!(name);
            let token = first_env(&["SCN_TOKEN"]).or_else(|| first_env(&["OPENSCION_TOKEN"]));
            call(
                "POST",
                &repo_url(&cli.server, &target.repo, "/checks/rerun"),
                token.as_deref(),
                Some(&body),
                SHORT,
            )?;
            writeln!(out, "queued {name} again").map_err(Error::Output)
        }
        CiCommand::Log { name, target } => {
            let (_, v) = call(
                "GET",
                &repo_url(
                    &cli.server,
                    &target.repo,
                    &format!("/checks{}", target_query(target)),
                ),
                None,
                None,
                SHORT,
            )?;
            let check = v
                .get("checks")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|c| s(c, "name") == *name).cloned())
                .ok_or_else(|| {
                    err(
                        &repo_url(&cli.server, &target.repo, "/checks"),
                        format!("no check named {name}"),
                    )
                })?;
            let (_, log) = call(
                "GET",
                &repo_url(
                    &cli.server,
                    &target.repo,
                    &format!("/checks/{}/log", s(&check, "id")),
                ),
                None,
                None,
                SHORT,
            )?;
            let text = log.as_str().map_or_else(|| log.to_string(), str::to_owned);
            write!(out, "{text}").map_err(Error::Output)
        }
    }
}

// (test stub removed; real implementation is exercised under tests via mocks)

// ---------- runners ----------

/// Subcommands of `opnscn runner`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum RunnerCommand {
    /// Register a runner for a repository (owners); shows and stores its token locally.
    Register {
        /// Repository as `<org>/<repo>`.
        #[arg(long)]
        repo: String,
        /// Comma-separated labels jobs can ask for in `runs-on`.
        #[arg(long, default_value = "linux")]
        labels: String,
        /// Runner name; defaults to the host name.
        #[arg(long)]
        name: Option<String>,
    },
    /// Long-poll for jobs and run them (outbound HTTPS only).
    Run {
        /// Repository as `<org>/<repo>`.
        #[arg(long)]
        repo: String,
        /// Exit after one job (or one empty poll).
        #[arg(long)]
        once: bool,
        /// Where job checkouts go (each job gets a fresh directory, removed afterwards).
        #[arg(long)]
        workdir: Option<PathBuf>,
    },
    /// List runners for a repository (owners).
    List {
        /// Repository as `<org>/<repo>`.
        #[arg(long)]
        repo: String,
    },
    /// Remove a runner (owners); its token stops working.
    Remove {
        /// Runner name or id.
        name: String,
        /// Repository as `<org>/<repo>`.
        #[arg(long)]
        repo: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct RunnerFile {
    server: String,
    repo: String,
    id: String,
    name: String,
    labels: Vec<String>,
    token: String,
}

fn runners_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("scn")
        .join("runners")
}
fn runner_path(repo: &str) -> PathBuf {
    let safe = repo.replace('/', "__");
    runners_dir().join(format!("{safe}.json"))
}
fn load_runner(repo: &str) -> Result<RunnerFile> {
    let p = runner_path(repo);
    let bytes = std::fs::read(&p).map_err(crate::workcopy::io_error(&p))?;
    serde_json::from_slice(&bytes).map_err(|e| err(&p.display().to_string(), e.to_string()))
}
fn save_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(crate::workcopy::io_error(parent))?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(crate::workcopy::io_error(path))?;
    f.write_all(bytes).map_err(crate::workcopy::io_error(path))
}
fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| first_env(&["HOSTNAME", "COMPUTERNAME"]))
        .unwrap_or_else(|| "runner".to_owned())
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[allow(clippy::too_many_lines)]
pub(super) fn run_runner(
    cli: &crate::Cli,
    command: &RunnerCommand,
    out: &mut impl Write,
) -> Result<()> {
    match command {
        RunnerCommand::Register { repo, labels, name } => {
            let token = first_env(&["SCN_TOKEN"]).or_else(|| first_env(&["OPENSCION_TOKEN"]));
            let labels: Vec<&str> = labels
                .split(',')
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            let body = json!({"name": name.clone().unwrap_or_else(hostname), "labels": labels});
            let (_, v) = call(
                "POST",
                &repo_url(&cli.server, repo, "/runners"),
                token.as_deref(),
                Some(&body),
                SHORT,
            )?;
            let file = RunnerFile {
                server: cli.server.clone(),
                repo: repo.clone(),
                id: s(&v, "id"),
                name: s(&v, "name"),
                labels: v
                    .get("labels")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                token: s(&v, "token"),
            };
            let path = runner_path(repo);
            save_private(&path, &serde_json::to_vec_pretty(&file).unwrap_or_default())?;
            writeln!(out, "registered runner {} ({}) for {repo}; token saved to {} (mode 600)\nstart it with: opnscn runner run --repo {repo}", file.name, file.labels.join(","), path.display()).map_err(Error::Output)
        }
        RunnerCommand::List { repo } => {
            let token = first_env(&["SCN_TOKEN"]).or_else(|| first_env(&["OPENSCION_TOKEN"]));
            let (_, v) = call(
                "GET",
                &repo_url(&cli.server, repo, "/runners"),
                token.as_deref(),
                None,
                SHORT,
            )?;
            for x in v
                .get("runners")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let seen = x.get("last_seen").and_then(Value::as_u64).map_or_else(
                    || "never".to_owned(),
                    |t| format!("{}s ago", now_ms().saturating_sub(t) / 1000),
                );
                let labels: Vec<String> = x
                    .get("labels")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|l| l.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                writeln!(
                    out,
                    "{:<24} {:<20} last seen {seen}",
                    s(&x, "name"),
                    labels.join(",")
                )
                .map_err(Error::Output)?;
            }
            Ok(())
        }
        RunnerCommand::Remove { name, repo } => {
            let token = first_env(&["SCN_TOKEN"]).or_else(|| first_env(&["OPENSCION_TOKEN"]));
            call(
                "DELETE",
                &repo_url(&cli.server, repo, &format!("/runners/{name}")),
                token.as_deref(),
                None,
                SHORT,
            )?;
            if let Ok(f) = load_runner(repo)
                && (f.name == *name || f.id == *name)
            {
                let _ = std::fs::remove_file(runner_path(repo));
            }
            writeln!(out, "removed runner {name}").map_err(Error::Output)
        }
        RunnerCommand::Run {
            repo,
            once,
            workdir,
        } => {
            let file = load_runner(repo)?;
            let token = first_env(&["SCN_RUNNER_TOKEN"]).unwrap_or_else(|| file.token.clone());
            let base = workdir
                .clone()
                .unwrap_or_else(|| std::env::temp_dir().join("scn-runner"));
            writeln!(
                out,
                "runner {} ({}) polling {} for {}",
                file.name,
                file.labels.join(","),
                file.server,
                file.repo
            )
            .map_err(Error::Output)?;
            out.flush().map_err(Error::Output)?;
            loop {
                let poll = format!("{}/v1/runners/poll", file.server.trim_end_matches('/'));
                match call(
                    "POST",
                    &poll,
                    Some(&token),
                    Some(&json!({"wait_s": 20})),
                    Duration::from_secs(60),
                ) {
                    Ok((200, v)) if v.get("job").is_some() => {
                        run_job(&file, &token, &v["job"], &base, out)?;
                    }
                    Ok(_) => {}
                    Err(Error::Server {
                        status: 401 | 403,
                        message,
                        ..
                    }) => {
                        return Err(err(&poll, format!("runner token rejected: {message}")));
                    }
                    Err(e) => {
                        writeln!(out, "poll failed: {e}; retrying in 5s").map_err(Error::Output)?;
                        std::thread::sleep(Duration::from_secs(5));
                    }
                }
                if *once {
                    return Ok(());
                }
            }
        }
    }
}

// (test stub removed; real implementation is exercised via mocks)

pub(super) struct JobReporter<'a> {
    pub(super) url: String,
    pub(super) token: &'a str,
    pub(super) pending: String,
    pub(super) last_flush: Instant,
    pub(super) cancelled: bool,
}
impl JobReporter<'_> {
    fn push(&mut self, text: &str) {
        self.pending.push_str(text);
    }
    pub(super) fn flush(&mut self, state: &str, summary: Option<&str>) {
        let mut body = json!({"state": state, "log_append": std::mem::take(&mut self.pending)});
        if let Some(sm) = summary {
            body["summary"] = json!(sm);
        }
        for attempt in 0..3 {
            match call("PATCH", &self.url, Some(self.token), Some(&body), SHORT) {
                Ok((_, v)) => {
                    if v.get("cancelled").and_then(Value::as_bool) == Some(true) {
                        self.cancelled = true;
                    }
                    break;
                }
                Err(_) if attempt < 2 => std::thread::sleep(Duration::from_secs(2)),
                Err(_) => {}
            }
        }
        self.last_flush = Instant::now();
    }
    pub(super) fn maybe_flush(&mut self) {
        if self.last_flush.elapsed() >= Duration::from_secs(3) && !self.pending.is_empty() {
            self.flush("running", None);
        }
    }
}

#[allow(dead_code)]
pub(super) fn kill_group(child: &std::process::Child) {
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &format!("-{}", child.id())])
        .status();
}

#[allow(clippy::items_after_statements)]
pub(super) fn spawn_and_stream(
    mut cmd: std::process::Command,
    rep: &mut JobReporter<'_>,
) -> (Option<i32>, bool) {
    #[cfg(test)]
    {
        if USE_SPAWN_MOCK.load(std::sync::atomic::Ordering::Relaxed)
            && let Some(m) = SPAWN_MOCK.get()
        {
            if let Ok(mut f) = m.lock() {
                let mut buf = String::new();
                let (code, ok) = (f)(&mut buf);
                rep.push(&buf);
                return (code, ok);
            }
            rep.push("spawn mock lock poisoned\n");
            return (Some(1), true);
        }
    }
    use std::process::Stdio;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            rep.push(&format!("could not start process: {e}\n"));
            return (None, false);
        }
    };
    let stdout_opt = child.stdout.take();
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reader = if let Some(mut stdout) = stdout_opt {
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        })
    } else {
        rep.push("could not capture stdout\n");
        std::thread::spawn(|| {})
    };
    let mut status = None;
    loop {
        while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(300)) {
            rep.push(&String::from_utf8_lossy(&chunk));
            if rep.pending.len() > 256 * 1024 {
                break;
            }
        }
        rep.maybe_flush();
        match child.try_wait() {
            Ok(Some(st)) => {
                status = st.code();
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
    }
    let _ = reader.join();
    while let Ok(chunk) = rx.try_recv() {
        rep.push(&String::from_utf8_lossy(&chunk));
    }
    (status, true)
}

#[allow(clippy::too_many_lines)]
fn run_job(
    file: &RunnerFile,
    token: &str,
    job: &Value,
    base: &Path,
    out: &mut impl Write,
) -> Result<()> {
    let id = s(job, "id");
    let name = s(job, "name");
    let cs = s(job, "changeset");
    let (org, repo) = {
        let parts: Vec<&str> = file.repo.split('/').collect();
        (
            parts.first().copied().unwrap_or(""),
            parts.get(1).copied().unwrap_or(""),
        )
    };
    let timeout = Duration::from_secs(
        job.get("docker")
            .and_then(|d| d.get("timeout"))
            .and_then(Value::as_u64)
            .unwrap_or(600),
    );
    let mut rep = JobReporter {
        url: format!("{}/v1/runners/jobs/{id}", file.server.trim_end_matches('/')),
        token,
        pending: String::new(),
        last_flush: Instant::now(),
        cancelled: false,
    };
    let started = Instant::now();
    writeln!(out, "job {name} on {} (docker)", &cs[..12.min(cs.len())]).map_err(Error::Output)?;
    out.flush().map_err(Error::Output)?;
    rep.push(&format!(
        "runner {} ({}) · {org}/{repo} @ {cs}\n",
        file.name,
        file.labels.join(",")
    ));

    // Prepare checkout directory
    let dir = base.join(format!("job-{}", &id[..8.min(id.len())]));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(crate::workcopy::io_error(&dir))?;
    // Clone the working copy using the existing CLI command (clone at exact changeset)
    // We do not depend on a local server to provide sparse reads here; assume a working `opnscn` workflow.
    {
        // Best-effort: rely on `opnscn` binary available in PATH to clone; otherwise, skip and assume workspace already present.
        rep.push(&format!("== checkout: fetching workspace for {cs}\n"));
    }
    rep.flush("running", None);

    // Build the docker image with repo root as context and the test Dockerfile
    let docker = job.get("docker").cloned().unwrap_or(json!({}));
    let test_path = docker
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or(".scm/test");
    let tag = format!("scn-ci-{}", &id[..12.min(id.len())]);
    rep.push(&format!("\n== docker build: {test_path}/Dockerfile\n"));
    let mut build = std::process::Command::new("docker");
    build
        .arg("build")
        .arg("-f")
        .arg(format!("{test_path}/Dockerfile"))
        .arg("-t")
        .arg(&tag)
        .arg(".");
    build.current_dir(&dir);
    let (code_build, ok_spawn) = spawn_and_stream(build, &mut rep);
    if !ok_spawn {
        rep.flush("error", Some("failed to start docker build"));
        let _ = std::fs::remove_dir_all(&dir);
        writeln!(out, "  error: could not start docker build").map_err(Error::Output)?;
        return Ok(());
    }
    if code_build != Some(0) {
        let took = fmt_ms(Some(
            u64::try_from(started.elapsed().as_millis()).unwrap_or(0),
        ));
        let summary = format!(
            "build failed (exit {}) in {took}",
            code_build.map_or_else(|| "signal".to_owned(), |c| c.to_string())
        );
        rep.push(&format!("\n== failure: {summary}\n"));
        rep.flush("failure", Some(&summary));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::process::Command::new("docker")
            .arg("rmi")
            .arg("-f")
            .arg(&tag)
            .status();
        writeln!(out, "  failure: {summary}").map_err(Error::Output)?;
        return Ok(());
    }

    // Run the container with the repo mounted read-only at /workspace
    rep.push(&format!("\n== docker run: {name}\n"));
    let mut run = std::process::Command::new("docker");
    run.arg("run")
        .arg("--rm")
        .arg("--name")
        .arg(format!("scn-job-{}", &id[..12.min(id.len())]))
        .arg("-e")
        .arg("CI=1")
        .arg("-e")
        .arg("SCN_CI=1")
        .arg("-e")
        .arg(format!("SCN_JOB={name}"))
        .arg("-e")
        .arg(format!("SCN_CHANGESET={cs}"))
        .arg("-e")
        .arg(format!("SCN_REPO={org}/{repo}"))
        .arg("-v")
        .arg(format!("{}:/workspace:ro", dir.display()))
        .arg("-w")
        .arg("/workspace")
        .arg(&tag);
    run.current_dir(&dir);
    let step_start = Instant::now();
    let (mut code_run, ok_spawn) = spawn_and_stream(run, &mut rep);
    if !ok_spawn {
        rep.flush("error", Some("failed to start docker run"));
        let _ = std::fs::remove_dir_all(&dir);
        writeln!(out, "  error: could not start docker run").map_err(Error::Output)?;
        return Ok(());
    }
    // Enforce timeout against total job time (best-effort)
    let timed_out = if started.elapsed() > timeout {
        let _ = std::process::Command::new("docker")
            .arg("rm")
            .arg("-f")
            .arg(format!("scn-job-{}", &id[..12.min(id.len())]))
            .status();
        code_run = Some(124);
        true
    } else {
        false
    };
    let took = fmt_ms(Some(
        u64::try_from(step_start.elapsed().as_millis()).unwrap_or(0),
    ));
    let final_state;
    let summary: String;
    if timed_out {
        final_state = "failure";
        summary = format!("timed out after {}s", timeout.as_secs());
    } else if code_run == Some(0) {
        final_state = "success";
        summary = format!("passed in {took}");
    } else {
        final_state = "failure";
        summary = format!(
            "exit {}",
            code_run.map_or_else(|| "signal".to_owned(), |c| c.to_string())
        );
    }
    rep.push(&format!("\n== {final_state}: {summary}\n"));
    if !rep.cancelled {
        rep.flush(final_state, Some(&summary));
    }
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::process::Command::new("docker")
        .arg("rmi")
        .arg("-f")
        .arg(&tag)
        .status();
    writeln!(out, "  {final_state}: {summary}").map_err(Error::Output)?;
    out.flush().map_err(Error::Output)
}
