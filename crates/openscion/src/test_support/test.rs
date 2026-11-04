//! The stand-in servers read a request body before they answer.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use super::canned_server;

#[test]
fn canned_server_reads_a_split_body_before_answering() {
    let base = canned_server(200, r#"{"missing":[]}"#);
    let addr = base.trim_start_matches("http://");
    let body = br#"{"pieceCids":["bafy"]}"#;
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let head = format!(
        "POST /v1/repos/local/default/pieces/missing HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    std::thread::sleep(Duration::from_millis(80));
    stream.write_all(body).unwrap();
    let text = read_response(&mut stream);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert!(text.contains(r#"{"missing":[]}"#), "{text}");
}

/// One read can return only `HTTP/1.1` when the suite is busy. Keep going
/// until the headers and `Content-Length` body are both in hand.
fn read_response(stream: &mut TcpStream) -> String {
    let mut buf = [0u8; 1024];
    let mut got = Vec::new();
    loop {
        let n = stream
            .read(&mut buf)
            .unwrap_or_else(|error| panic!("response was reset: {error}"));
        assert!(
            n > 0,
            "connection closed before a full response: {}",
            String::from_utf8_lossy(&got)
        );
        got.extend_from_slice(&buf[..n]);
        if let Some(header_end) = got.windows(4).position(|window| window == b"\r\n\r\n") {
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
