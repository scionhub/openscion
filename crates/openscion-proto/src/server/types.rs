//! The server description type.

use serde::{Deserialize, Serialize};

/// Name reported by `/v1/version` and `/healthz`.
pub const SERVER_NAME: &str = "scionbase-server";

fn default_server_name() -> String {
    SERVER_NAME.to_owned()
}

/// What a server reports about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ServerInfo {
    /// Product name, always [`SERVER_NAME`] for this implementation.
    #[serde(default = "default_server_name")]
    pub name: String,
    /// The server's package version, for display and diagnostics.
    pub server_version: String,
    /// The protocol version the server speaks, as `(major, minor)`.
    ///
    /// A client passes this to [`crate::is_compatible`] before making any
    /// other call.
    pub protocol_version: (u32, u32),
}

impl ServerInfo {
    /// Builds a description for a server at `server_version` speaking
    /// `protocol_version`.
    ///
    /// # Examples
    ///
    /// ```
    /// # use openscion_proto::{ServerInfo, PROTOCOL_VERSION, server::SERVER_NAME};
    /// let info = ServerInfo::new("0.2.1", PROTOCOL_VERSION);
    /// assert_eq!(info.protocol_version, PROTOCOL_VERSION);
    /// assert_eq!(info.name, SERVER_NAME);
    /// ```
    #[must_use]
    pub fn new(server_version: impl Into<String>, protocol_version: (u32, u32)) -> Self {
        Self {
            name: default_server_name(),
            server_version: server_version.into(),
            protocol_version,
        }
    }
}
