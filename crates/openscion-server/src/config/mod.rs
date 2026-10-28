//! Server configuration, read from the command line and the environment.
//!
//! Every option has a flag and an `OPENSCION_*` environment variable, so the
//! same binary runs unchanged from a shell, a container, or a service manager.

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::Parser;

/// The address the server listens on when none is configured.
///
/// Loopback only: exposing a server beyond the machine is a deliberate choice
/// made with `--listen`, never a default.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:7878";

/// How the server is configured.
#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(
    name = "openscion-server",
    version,
    about = "Serve the OpenScion API over HTTP"
)]
#[non_exhaustive]
pub struct ServerConfig {
    /// Address to listen on. Port 0 picks a free port.
    #[arg(long, env = "OPENSCION_LISTEN", default_value = DEFAULT_LISTEN)]
    pub listen: SocketAddr,
    /// Path to a `SQLite` database file. When unset, the server runs entirely
    /// in memory and loses state on restart.
    #[arg(long, env = "OPENSCION_DB")]
    pub db: Option<PathBuf>,
}

impl ServerConfig {
    /// Builds a configuration that listens on `listen`.
    ///
    /// # Examples
    ///
    /// ```
    /// # use openscion_server::ServerConfig;
    /// let config = ServerConfig::new("127.0.0.1:0".parse().unwrap());
    /// assert_eq!(config.listen.port(), 0);
    /// ```
    #[must_use]
    pub fn new(listen: SocketAddr) -> Self {
        Self { listen, db: None }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self::new(SocketAddr::from(([127, 0, 0, 1], 7878)))
    }
}

#[cfg(test)]
mod test;
