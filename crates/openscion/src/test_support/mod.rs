//! Servers for the client's unit tests: a real `openscion-server`, and a
//! canned one that answers every request with a fixed body.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

use openscion_server::{Server, ServerConfig};

/// Starts a real server on a free loopback port and returns its base URL.
///
/// The server runs on its own runtime thread until the test process exits.
pub(crate) fn real_server() -> String {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let server = Server::bind(&ServerConfig::new("127.0.0.1:0".parse().unwrap()))
                .await
                .unwrap();
            sender.send(server.local_addr()).unwrap();
            server.serve(std::future::pending()).await.unwrap();
        });
    });
    format!("http://{}", receiver.recv().unwrap())
}

/// Starts a server that answers every request with `status` and `body`, and
/// returns its base URL.
///
/// The request body is read before the response is written. Answering a
/// `POST` from the headers alone and then closing the socket races `ureq`,
/// which writes the head and the body separately, and the call fails with
/// `Peer disconnected`.
pub(crate) fn canned_server(status: u16, body: &'static str) -> String {
    scripted_server(move |_request| (status, body.to_owned()))
}

/// One request seen by [`scripted_server`].
pub(crate) struct ScriptedRequest {
    /// HTTP method.
    pub method: String,
    /// Path and query string.
    pub path: String,
    /// Body, decoded as lossy UTF-8.
    pub body: String,
}

/// Answers each request with the status and body the closure returns.
pub(crate) fn scripted_server<F>(handler: F) -> String
where
    F: Fn(ScriptedRequest) -> (u16, String) + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let _ = answer_scripted(stream, &handler);
        }
    });
    format!("http://{addr}")
}

fn answer_scripted<F>(stream: std::net::TcpStream, handler: &F) -> std::io::Result<()>
where
    F: Fn(ScriptedRequest) -> (u16, String),
{
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_owned();
    let path = parts.next().unwrap_or("/").to_owned();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }
    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body_bytes)?;
    }
    let (status, response) = handler(ScriptedRequest {
        method,
        path,
        body: String::from_utf8_lossy(&body_bytes).into_owned(),
    });
    let mut stream = reader.into_inner();
    write!(
        stream,
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
        response.len()
    )
}

/// A base URL nothing is listening on.
pub(crate) fn unreachable_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{addr}")
}

/// Writes a working copy whose origin is `server` and `acme/widgets`.
pub(crate) fn save_checkout(root: &std::path::Path, server: &str) {
    use openscion_core::ObjectId;

    use crate::workcopy::{self, State};
    let mut state = State {
        server: server.to_owned(),
        repo: "acme/widgets".to_owned(),
        ref_name: "refs/heads/main".to_owned(),
        branch: Some("main".to_owned()),
        upstream: Some("refs/heads/main".to_owned()),
        base: ObjectId::from_bytes([0; 32]),
        sync_onto: None,
        sparse: None,
        written_at: 0,
        files: std::collections::BTreeMap::new(),
        remotes: Vec::new(),
        remote_tips: std::collections::BTreeMap::new(),
        upstream_remote: None,
    };
    state.ensure_origin();
    workcopy::save(root, &mut state).unwrap();
}

/// A fresh, empty scratch directory unique to this test.
pub(crate) fn scratch(name: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "openscion-test-{}-{name}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod test;
