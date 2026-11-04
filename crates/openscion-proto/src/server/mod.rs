//! The payload a server returns to describe itself.
//!
//! Every client — `scn`, the web GUI, a CI job — asks a server for this before
//! anything else, so it can refuse to talk to a server whose protocol it does
//! not speak. The HTTP API serves it at `GET /v1/version`.

mod types;

pub use types::{SERVER_NAME, ServerInfo};

#[cfg(test)]
mod test;
