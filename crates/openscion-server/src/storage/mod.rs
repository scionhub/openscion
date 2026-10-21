//! Storage backends used by the server.
//!
//! The server persists state through a backend that implements the storage
//! traits re-exported by `openscion-core`. The SQLite implementation is the
//! default when `--db`/`OPENSCION_DB` names a file; without one, the server
//! runs purely in memory and loses state on restart.

pub mod sqlite;

