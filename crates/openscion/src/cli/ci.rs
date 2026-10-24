//! `scn ci` and `scn runner`: ScionBase-native CI. Runners connect outbound
//! only: they long-poll the server for jobs from `.scionbase/ci.yml`, clone the
//! exact changeset, run the steps with bash, and post logs and the result.

use std::io::{Read as _, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use clap::{Subcommand, ValueEnum};
use serde_json::{Value, json};

use super::{Cli, first_env, pr_client, token_for};
use crate::{Error, Result, ServerClient};

/// Subcommands of `scn ci`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum CiCommand {
    /// Report a check result from any script (owner token, or SCN_RUNNER_TOKEN).
    #[command(after_help = "Examples:\n  \
scn ci report lint --pr 3 --state success --summary \"0 warnings\"\n  \
scn ci report e2e --changeset <64-hex> --state failure --log e2e.log --url https://ci.example/run/9")]
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
    /// List checks on a pull request head or changeset.
    List {
        #[command(flatten)]
        target: Target,
    },
    /// Queue a ci.yml job again (owners).
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

/// Which changeset a check belongs to.
#[derive(Debug, Clone, PartialEq, Eq, clap::Args)]
pub struct Target {
    /// Pull request number (its current head changeset).
    #[arg(long, conflicts_with_all = ["changeset", "r#ref"])]
    pr: Option<u32>,
    /// Changeset id (64 hex).
    #[arg(long)]
    changeset: Option<String>,
    /// Ref whose current target is used, such as `main`.
    #[arg(long = "ref")]
    r#ref: Option<String>,
    /// Repository as `<org>/<repo>`; inferred from the working copy.
    #[arg(long)]
    repo: Option<String>,
    /// Working copy used to infer the repository.
    #[arg(long, default_value = ".")]
    dir: PathBuf,
}

/// Check states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
#[non_exhaustive]
pub enum CheckState {
    /// Waiting.
    Queued,
    /// In progress.
    Running,
    /// Passed.
    Success,
    /// Failed.
    Failure,
    /// Could not run.
    Error,
    /// Stopped.
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

/// Subcommands of `scn runner`.
#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
#[non_exhaustive]
pub enum RunnerCommand {
    /// Register a runner for a repository (owners); stores its token locally.
    #[command(
        after_help = "Example:\n  scn runner register --repo filecoin-project/curio --labels linux,x64"
    )]
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
        /// Repository as `<org>/<repo>`; required when several runners are registered here.
        #[arg(long)]
        repo: Option<String>,
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

fn fmt_ms(ms: Option<u64>) -> String {
    match ms {
        None => "-".to_owned(),
        Some(ms) if ms < 1000 => format!("{ms}ms"),
        Some(ms) if ms < 60_000 => format!("{:.1}s", ms as f64 / 1000.0),
        Some(ms) => format!("{}m{:02}s", ms / 60_000, (ms % 60_000) / 1000),
    }
}

struct RepoRef {
    server: String,
    org: String,
    repo: String,
}

impl RepoRef {
    fn url(&self, suffix: &str) -> String {
        format!(
            "{}/v1/repos/{}/{}{suffix}",
            self.server, self.org, self.repo
        )
    }
}

fn resolve_repo(cli: &Cli, dir: &Path, repo: Option<&str>) -> Result<RepoRef> {
    let c = pr_client(cli, dir, repo)?;
    Ok(RepoRef {
        server: c.base().to_owned(),
        org: c.org().to_owned(),
        repo: c.repo().to_owned(),
    })
}

/// A user token (SCN_TOKEN or `scn login`), else a runner token (SCN_RUNNER_TOKEN or a registered runner).
fn write_token(r: &RepoRef) -> Option<String> {
    first_env(&["SCN_TOKEN"])
        .or_else(|| token_for(&r.server))
        .or_else(|| first_env(&["SCN_RUNNER_TOKEN"]))
        .or_else(|| load_runner(r).ok().map(|x| x.token))
}

fn target_json(t: &Target) -> Value {
    let mut v = json!({});
    if let Some(n) = t.pr {
        v["pr"] = json!(n);
    }
    if let Some(c) = &t.changeset {
        v["changeset"] = json!(c);
    }
    if let Some(r) = &t.r#ref {
        v["ref"] = json!(r);
    }
    v
}

fn target_query(t: &Target) -> String {
    if let Some(n) = t.pr {
        format!("?pr={n}")
    } else if let Some(c) = &t.changeset {
        format!("?changeset={c}")
    } else {
        format!("?ref={}", t.r#ref.as_deref().unwrap_or("main"))
    }
}

/// Runs `scn ci ...`.
pub(super) fn run_ci(cli: &Cli, command: &CiCommand, out: &mut impl Write) -> Result<()> {
    match command {
        CiCommand::Report {
            name,
            state,
            target,
            summary,
            log,
            url,
        } => {
            let r = resolve_repo(cli, &target.dir, target.repo.as_deref())?;
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
            let token = write_token(&r);
            let (_, v) = call(
                "POST",
                &r.url("/checks"),
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
            let r = resolve_repo(cli, &target.dir, target.repo.as_deref())?;
            let (_, v) = call(
                "GET",
                &r.url(&format!("/checks{}", target_query(target))),
                None,
                None,
                SHORT,
            )?;
            let cs = s(&v, "changeset");
            writeln!(
                out,
                "changeset {}  ci.yml: {}",
                &cs[..12.min(cs.len())],
                s(&v, "ci_yml")
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
            let r = resolve_repo(cli, &target.dir, target.repo.as_deref())?;
            let mut body = target_json(target);
            if body.as_object().is_some_and(serde_json::Map::is_empty) {
                body["ref"] = json!("main");
            }
            body["name"] = json!(name);
            let token = first_env(&["SCN_TOKEN"]).or_else(|| token_for(&r.server));
            call(
                "POST",
                &r.url("/checks/rerun"),
                token.as_deref(),
                Some(&body),
                SHORT,
            )?;
            writeln!(out, "queued {name} again").map_err(Error::Output)
        }
        CiCommand::Log { name, target } => {
            let r = resolve_repo(cli, &target.dir, target.repo.as_deref())?;
            let (_, v) = call(
                "GET",
                &r.url(&format!("/checks{}", target_query(target))),
                None,
                None,
                SHORT,
            )?;
            let check = v
                .get("checks")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|c| s(c, "name") == *name).cloned())
                .ok_or_else(|| err(&r.url("/checks"), format!("no check named {name}")))?;
            let (_, log) = call(
                "GET",
                &r.url(&format!("/checks/{}/log", s(&check, "id"))),
                None,
                None,
                SHORT,
            )?;
            let text = log.as_str().map_or_else(|| log.to_string(), str::to_owned);
            write!(out, "{text}").map_err(Error::Output)
        }
    }
}

// ---------- runners ----------

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

fn runner_path(org: &str, repo: &str) -> PathBuf {
    runners_dir().join(format!("{org}__{repo}.json"))
}

fn load_runner(r: &RepoRef) -> Result<RunnerFile> {
    let p = runner_path(&r.org, &r.repo);
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

fn split_repo(spec: &str) -> Result<(String, String)> {
    spec.split_once('/')
        .filter(|(o, r)| !o.is_empty() && !r.is_empty())
        .map(|(o, r)| (o.to_owned(), r.to_owned()))
        .ok_or_else(|| err("cli", "repo must be <org>/<repo>"))
}

fn hostname() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .or_else(|| first_env(&["HOSTNAME", "COMPUTERNAME"]))
        .unwrap_or_else(|| "runner".to_owned())
}

/// Runs `scn runner ...`.
pub(super) fn run_runner(cli: &Cli, command: &RunnerCommand, out: &mut impl Write) -> Result<()> {
    match command {
        RunnerCommand::Register { repo, labels, name } => {
            let (org, name_r) = split_repo(repo)?;
            let r = RepoRef {
                server: cli.server.clone(),
                org,
                repo: name_r,
            };
            let token = first_env(&["SCN_TOKEN"]).or_else(|| token_for(&r.server));
            let labels: Vec<&str> = labels
                .split(',')
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            let body = json!({"name": name.clone().unwrap_or_else(hostname), "labels": labels});
            let (_, v) = call(
                "POST",
                &r.url("/runners"),
                token.as_deref(),
                Some(&body),
                SHORT,
            )?;
            let file = RunnerFile {
                server: r.server.clone(),
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
            let path = runner_path(&r.org, &r.repo);
            save_private(&path, &serde_json::to_vec_pretty(&file).unwrap_or_default())?;
            writeln!(
                out,
                "registered runner {} ({}) for {repo}; token saved to {} (mode 600)\nstart it with: scn runner run --repo {repo}",
                file.name,
                file.labels.join(","),
                path.display()
            )
            .map_err(Error::Output)
        }
        RunnerCommand::List { repo } => {
            let (org, name_r) = split_repo(repo)?;
            let r = RepoRef {
                server: cli.server.clone(),
                org,
                repo: name_r,
            };
            let token = first_env(&["SCN_TOKEN"]).or_else(|| token_for(&r.server));
            let (_, v) = call("GET", &r.url("/runners"), token.as_deref(), None, SHORT)?;
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
            let (org, name_r) = split_repo(repo)?;
            let r = RepoRef {
                server: cli.server.clone(),
                org,
                repo: name_r,
            };
            let token = first_env(&["SCN_TOKEN"]).or_else(|| token_for(&r.server));
            call(
                "DELETE",
                &r.url(&format!("/runners/{name}")),
                token.as_deref(),
                None,
                SHORT,
            )?;
            if let Ok(f) = load_runner(&r) {
                if f.name == *name || f.id == *name {
                    let _ = std::fs::remove_file(runner_path(&r.org, &r.repo));
                }
            }
            writeln!(out, "removed runner {name}").map_err(Error::Output)
        }
        RunnerCommand::Run {
            repo,
            once,
            workdir,
        } => {
            let file = match repo {
                Some(spec) => {
                    let (org, name_r) = split_repo(spec)?;
                    load_runner(&RepoRef {
                        server: cli.server.clone(),
                        org,
                        repo: name_r,
                    })?
                }
                None => {
                    let mut found: Vec<PathBuf> = std::fs::read_dir(runners_dir())
                        .map(|d| {
                            d.filter_map(|e| e.ok().map(|e| e.path()))
                                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                                .collect()
                        })
                        .unwrap_or_default();
                    if found.len() != 1 {
                        return Err(err(
                            "cli",
                            "pass --repo (zero or several runners registered on this machine)",
                        ));
                    }
                    let p = found.remove(0);
                    let bytes = std::fs::read(&p).map_err(crate::workcopy::io_error(&p))?;
                    serde_json::from_slice(&bytes)
                        .map_err(|e| err(&p.display().to_string(), e.to_string()))?
                }
            };
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
                let poll = format!("{}/v1/runners/poll", file.server);
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

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

struct JobReporter<'a> {
    url: String,
    token: &'a str,
    pending: String,
    last_flush: Instant,
    cancelled: bool,
}

impl JobReporter<'_> {
    fn push(&mut self, text: &str) {
        self.pending.push_str(text);
    }
    fn flush(&mut self, state: &str, summary: Option<&str>) {
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
    fn maybe_flush(&mut self) {
        if self.last_flush.elapsed() >= Duration::from_secs(3) && !self.pending.is_empty() {
            self.flush("running", None);
        }
    }
}

fn kill_group(child: &std::process::Child) {
    let _ = std::process::Command::new("kill")
        .args(["-KILL", &format!("-{}", child.id())])
        .status();
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
    let (org, repo) = (s(job, "org"), s(job, "repo"));
    let timeout = Duration::from_secs(job.get("timeout").and_then(Value::as_u64).unwrap_or(600));
    let steps = job
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut rep = JobReporter {
        url: format!("{}/v1/runners/jobs/{id}", file.server),
        token,
        pending: String::new(),
        last_flush: Instant::now(),
        cancelled: false,
    };
    let started = Instant::now();
    writeln!(
        out,
        "job {name} on {} ({} steps)",
        &cs[..12.min(cs.len())],
        steps.len()
    )
    .map_err(Error::Output)?;
    out.flush().map_err(Error::Output)?;
    rep.push(&format!(
        "runner {} ({}) · {org}/{repo} @ {cs}\n",
        file.name,
        file.labels.join(",")
    ));

    let dir = base.join(format!("job-{}", &id[..8.min(id.len())]));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(base).map_err(crate::workcopy::io_error(base))?;
    let user_token = first_env(&["SCN_TOKEN"]).or_else(|| token_for(&file.server));
    let client = ServerClient::new(&file.server)
        .with_token(user_token)
        .repo(&org, &repo);
    let at: Option<openscion_core::ObjectId> = cs.parse().ok();
    let ref_name = job
        .get("ref")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_owned();
    let cloned = crate::commands::clone_at(&client, &ref_name, at, &dir, None)
        .or_else(|_| crate::commands::clone_at(&client, "main", at, &dir, None));
    match cloned {
        Ok((_, n)) => rep.push(&format!("== checkout: {n} files at {cs}\n")),
        Err(e) => {
            rep.push(&format!("== checkout failed: {e}\n"));
            rep.flush("error", Some("checkout failed"));
            let _ = std::fs::remove_dir_all(&dir);
            writeln!(out, "  error: checkout failed: {e}").map_err(Error::Output)?;
            return Ok(());
        }
    }
    rep.flush("running", None);

    let mut final_state = "success";
    let mut summary = format!("{} step(s) passed", steps.len());
    for (k, step) in steps.iter().enumerate() {
        let sname = step
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("step")
            .to_owned();
        let run = step
            .get("run")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        rep.push(&format!(
            "\n== step {}/{}: {sname}\n$ {}\n",
            k + 1,
            steps.len(),
            run.trim_end().replace('\n', "\n$ ")
        ));
        let step_start = Instant::now();
        let mut cmd = std::process::Command::new("bash");
        cmd.arg("-c")
            .arg(format!("exec 2>&1\nset -eo pipefail\n{run}"))
            .current_dir(&dir)
            .env("CI", "true")
            .env("SCN_CI", "1")
            .env("SCN_JOB", &name)
            .env("SCN_CHANGESET", &cs)
            .env("SCN_REPO", format!("{org}/{repo}"))
            .env_remove("SCN_RUNNER_TOKEN")
            .env_remove("SCN_TOKEN")
            .env_remove("SCN_PASSWORD")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                rep.push(&format!("could not start bash: {e}\n"));
                final_state = "error";
                summary = format!("step '{sname}' could not start");
                break;
            }
        };
        let mut stdout = child.stdout.take().expect("piped stdout");
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut timed_out = false;
        let status = loop {
            while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(300)) {
                rep.push(&String::from_utf8_lossy(&chunk));
                if rep.pending.len() > 256 * 1024 {
                    break;
                }
            }
            rep.maybe_flush();
            if rep.cancelled {
                kill_group(&child);
            }
            if started.elapsed() > timeout {
                timed_out = true;
                kill_group(&child);
            }
            match child.try_wait() {
                Ok(Some(st)) => break Some(st),
                Ok(None) => {}
                Err(_) => break None,
            }
        };
        let _ = reader.join();
        while let Ok(chunk) = rx.try_recv() {
            rep.push(&String::from_utf8_lossy(&chunk));
        }
        let code = status.and_then(|s| s.code());
        rep.push(&format!(
            "== step {sname}: exit {} in {}\n",
            code.map_or_else(|| "signal".to_owned(), |c| c.to_string()),
            fmt_ms(Some(
                u64::try_from(step_start.elapsed().as_millis()).unwrap_or(0)
            ))
        ));
        if rep.cancelled {
            final_state = "cancelled";
            summary = "cancelled".to_owned();
            break;
        }
        if timed_out {
            final_state = "failure";
            summary = format!("timed out after {}s in step '{sname}'", timeout.as_secs());
            break;
        }
        if code != Some(0) {
            final_state = "failure";
            summary = format!(
                "step '{sname}' failed (exit {})",
                code.map_or_else(|| "signal".to_owned(), |c| c.to_string())
            );
            break;
        }
    }
    let took = fmt_ms(Some(
        u64::try_from(started.elapsed().as_millis()).unwrap_or(0),
    ));
    let summary = format!("{summary} in {took}");
    rep.push(&format!("\n== {final_state}: {summary}\n"));
    if !rep.cancelled {
        rep.flush(final_state, Some(&summary));
    }
    let _ = std::fs::remove_dir_all(&dir);
    writeln!(out, "  {final_state}: {summary}").map_err(Error::Output)?;
    out.flush().map_err(Error::Output)
}
