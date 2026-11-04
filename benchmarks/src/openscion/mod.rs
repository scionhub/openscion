//! The OpenScion backend: each scenario performed with `opnscn` against an
//! `openscion-server`.
//!
//! Both run in this process. A fresh server with an empty in-memory
//! repository starts on a loopback port before each run, outside the timed
//! region, and `opnscn` commands run through [`openscion::run`] exactly as the
//! binary would run them — over real HTTP, but without spawning a process.
//! Git pays a process start per command (about a millisecond); `opnscn` does
//! not. The README states this alongside the results.

use std::net::SocketAddr;
use std::path::Path;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use clap::Parser;
use openscion::Cli;
use openscion_server::{Server, ServerConfig};
use tokio::sync::oneshot;

use crate::{Error, Fixture, Result, Scenario};

/// Runs `scenario` once against `fixture` inside `workdir` and returns how
/// long the measured part took. `workdir` is emptied first.
///
/// # Errors
///
/// Returns [`Error::Io`] when the work directory cannot be prepared,
/// [`Error::Server`] when the server cannot start, and [`Error::OpenScion`]
/// when an `opnscn` command fails.
pub fn run(scenario: Scenario, fixture: &Fixture, workdir: &Path) -> Result<Duration> {
    crate::git::reset(workdir)?;
    let repo = workdir.join("repo");
    fixture.write_to(&repo)?;
    let server = RunningServer::start()?;
    let base = server.base();
    let repo_arg = path_arg(&repo)?;
    let clone_arg = path_arg(&workdir.join("clone"))?;
    let import = || opnscn(&["--server", &base, "import", &repo_arg]);
    match scenario {
        Scenario::Import => timed(import),
        Scenario::CommitOneFile => {
            import()?;
            let changed = repo.join(&fixture.files()[0].path);
            std::fs::write(&changed, b"changed\n").map_err(|source| Error::Io {
                path: changed,
                source,
            })?;
            timed(|| opnscn(&["commit", "-m", "change one file", "--dir", &repo_arg]))
        }
        Scenario::FullClone => {
            import()?;
            timed(|| opnscn(&["--server", &base, "clone", "local/default", &clone_arg]))
        }
        Scenario::SparseClone => {
            let directory = fixture.first_directory().ok_or(Error::NoDirectory)?;
            import()?;
            timed(|| {
                opnscn(&[
                    "--server",
                    &base,
                    "clone",
                    "local/default",
                    &clone_arg,
                    "--path",
                    directory,
                ])
            })
        }
    }
}

fn path_arg(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| Error::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "path is not UTF-8"),
    })
}

fn opnscn(args: &[&str]) -> Result<()> {
    let cli = Cli::parse_from(std::iter::once("opnscn").chain(args.iter().copied()));
    openscion::run(&cli, &mut std::io::sink())?;
    Ok(())
}

fn timed(operation: impl FnOnce() -> Result<()>) -> Result<Duration> {
    let start = Instant::now();
    operation()?;
    Ok(start.elapsed())
}

/// An `openscion-server` on a background runtime, stopped on drop.
struct RunningServer {
    addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl RunningServer {
    fn start() -> Result<Self> {
        let (ready, bound) = std::sync::mpsc::channel();
        let (stop, stopped) = oneshot::channel::<()>();
        let thread = std::thread::spawn(move || {
            let runtime = match tokio::runtime::Runtime::new() {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready.send(Err(error.to_string()));
                    return;
                }
            };
            runtime.block_on(async move {
                let config = ServerConfig::new(SocketAddr::from(([127, 0, 0, 1], 0)));
                let server = match Server::bind(&config).await {
                    Ok(server) => server,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let _ = ready.send(Ok(server.local_addr()));
                let _ = server
                    .serve(async {
                        let _ = stopped.await;
                    })
                    .await;
            });
        });
        let addr = bound
            .recv()
            .map_err(|error| Error::Server(error.to_string()))?
            .map_err(Error::Server)?;
        Ok(Self {
            addr,
            stop: Some(stop),
            thread: Some(thread),
        })
    }

    fn base(&self) -> String {
        format!("http://{}", self.addr)
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
