//! Tests for the HTTP surface, over a real socket.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use openscion_core::{PROTOCOL_VERSION, ServerInfo};
use tokio::sync::oneshot;

use super::Server;
use crate::{Error, ServerConfig};

async fn start() -> (String, oneshot::Sender<()>, tokio::task::JoinHandle<()>) {
    let server = Server::bind(&ServerConfig::new("127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    let base = format!("http://{}", server.local_addr());
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        server
            .serve(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    (base, stop, task)
}

async fn get(url: String) -> (u16, String) {
    tokio::task::spawn_blocking(move || {
        let mut response = ureq::get(&url).call().unwrap();
        let status = response.status().as_u16();
        (status, response.body_mut().read_to_string().unwrap())
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn healthz_reports_ok() {
    let (base, stop, task) = start().await;
    let (status, body) = get(format!("{base}/healthz")).await;
    assert_eq!(status, 200);
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["name"], "scionbase-server");
    assert_eq!(json["status"], "ok");
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn version_reports_the_package_and_protocol_versions() {
    let (base, stop, task) = start().await;
    let (status, body) = get(format!("{base}/v1/version")).await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_str::<ServerInfo>(&body).unwrap(),
        ServerInfo::new(env!("CARGO_PKG_VERSION"), PROTOCOL_VERSION)
    );
    stop.send(()).unwrap();
    task.await.unwrap();
}

/// Sends the head, waits long enough for the server to schedule a read, then
/// sends the body. That is the split `ureq` produces, and the one that used
/// to reset a keep-alive connection on a `404` or `405`.
fn write_split(stream: &mut TcpStream, head: &str, body: &[u8]) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream.write_all(head.as_bytes()).unwrap();
    std::thread::sleep(Duration::from_millis(80));
    stream.write_all(body).unwrap();
}

fn read_response(stream: &mut TcpStream) -> String {
    let mut buf = [0u8; 4096];
    let mut got = Vec::new();
    loop {
        let n = stream
            .read(&mut buf)
            .unwrap_or_else(|error| panic!("reading the response failed: {error}"));
        assert!(n > 0, "connection closed before a full response");
        got.extend_from_slice(&buf[..n]);
        if let Some(header_end) = got.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = String::from_utf8_lossy(&got[..header_end]);
            let length = header.lines().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            });
            let body_so_far = got.len() - (header_end + 4);
            if length.is_none_or(|length| body_so_far >= length) {
                return String::from_utf8_lossy(&got).into_owned();
            }
        }
    }
}

#[tokio::test]
async fn a_miss_with_a_split_body_keeps_the_connection_usable() {
    let (base, stop, task) = start().await;
    let addr = base.trim_start_matches("http://").to_owned();
    let cases = [
        (
            "POST /v1/repos/local/default/file-map HTTP/1.1",
            r#"{"upserts":{},"deletes":[]}"#,
            "404",
        ),
        (
            "POST /v1/repos HTTP/1.1",
            r#"{"org":"local","name":"default"}"#,
            "404",
        ),
        ("POST /healthz HTTP/1.1", r#"{"nope":true}"#, "405"),
        (
            "POST /v1/repos/local/default HTTP/1.1",
            r#"{"org":"local"}"#,
            "405",
        ),
    ];
    tokio::task::spawn_blocking(move || {
        for (start_line, body, status) in cases {
            let mut stream = TcpStream::connect(&addr).unwrap();
            let head = format!(
                "{start_line}\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            write_split(&mut stream, &head, body.as_bytes());
            let first = read_response(&mut stream);
            assert!(
                first.starts_with(&format!("HTTP/1.1 {status}")),
                "{start_line} answered {first}"
            );
            stream
                .write_all(b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                .unwrap_or_else(|error| {
                    panic!("{start_line} reset the connection before the next request: {error}")
                });
            let second = read_response(&mut stream);
            assert!(
                second.starts_with("HTTP/1.1 200"),
                "{start_line} poisoned keep-alive: {second}"
            );
        }
    })
    .await
    .unwrap();
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test]
async fn binding_an_address_in_use_fails_with_bind() {
    let first = Server::bind(&ServerConfig::new("127.0.0.1:0".parse().unwrap()))
        .await
        .unwrap();
    let taken = ServerConfig::new(first.local_addr());
    let error = Server::bind(&taken).await.unwrap_err();
    assert!(matches!(error, Error::Bind { addr, .. } if addr == first.local_addr()));
}
