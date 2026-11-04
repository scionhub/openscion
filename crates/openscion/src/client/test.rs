//! Unit tests for the server client, against real and canned servers.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use openscion_core::PROTOCOL_VERSION;

use super::ServerClient;
use crate::Error;
use crate::test_support::{canned_server, real_server, unreachable_server};

#[test]
fn list_orgs_reads_the_catalog() {
    let base = real_server();
    let orgs = ServerClient::new(&base).list_orgs().unwrap();
    assert!(orgs.iter().all(|name| !name.is_empty()));
}

#[test]
fn create_repo_falls_back_to_put_on_the_engine() {
    let base = real_server();
    let client = ServerClient::new(&base);
    let value = client.create_repo("acme", "from-cli").unwrap();
    assert_eq!(value["org"], "acme");
    assert_eq!(value["name"], "from-cli");
    assert_eq!(value["retention"]["freeDays"], 60);
    let (status, body) = {
        let mut response = ureq::get(&format!("{base}/v1/repos/acme/from-cli"))
            .call()
            .unwrap();
        (
            response.status().as_u16(),
            response
                .body_mut()
                .read_json::<serde_json::Value>()
                .unwrap(),
        )
    };
    assert_eq!(status, 200);
    assert_eq!(body["name"], "from-cli");
}

#[test]
fn trailing_slashes_are_dropped_from_the_base_url() {
    assert_eq!(ServerClient::new("http://h:1///").base(), "http://h:1");
}

#[test]
fn info_reads_a_real_server() {
    let info = ServerClient::new(real_server()).info().unwrap();
    assert_eq!(info.protocol_version, PROTOCOL_VERSION);
    assert_eq!(info.server_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(info.name, "scionbase-server");
}

#[test]
fn an_unreachable_server_is_a_request_error() {
    let base = unreachable_server();
    let error = ServerClient::new(&base).info().unwrap_err();
    assert!(matches!(error, Error::Request { url, .. } if url == format!("{base}/v1/version")));
}

#[test]
fn an_error_status_is_a_request_error() {
    let error = ServerClient::new(canned_server(500, "{}"))
        .info()
        .unwrap_err();
    assert!(matches!(error, Error::Request { .. }));
}

#[test]
fn a_body_that_is_not_server_info_is_a_decode_error() {
    let error = ServerClient::new(canned_server(200, r#"{"hello":1}"#))
        .info()
        .unwrap_err();
    assert!(matches!(error, Error::Decode { .. }));
}

#[test]
fn a_server_on_another_major_protocol_is_rejected() {
    let base = canned_server(
        200,
        r#"{"server_version":"9.0.0","protocol_version":[99,0]}"#,
    );
    let error = ServerClient::new(base).info().unwrap_err();
    assert!(matches!(
        error,
        Error::IncompatibleProtocol { server: (99, 0) }
    ));
    assert_eq!(
        error.to_string(),
        format!(
            "server speaks protocol 99.0, which this client ({}.{}) cannot use",
            PROTOCOL_VERSION.0, PROTOCOL_VERSION.1
        )
    );
}

#[test]
fn an_error_body_becomes_a_server_error() {
    let base = canned_server(409, r#"{"code":"RefConflict","message":"lost"}"#);
    let error = ServerClient::new(&base).get_ref("main").unwrap_err();
    assert!(matches!(
        &error,
        Error::Server { status: 409, code, message, .. } if code == "RefConflict" && message == "lost"
    ));
    assert_eq!(
        error.to_string(),
        format!("{base}/v1/refs/main answered 409 RefConflict: lost")
    );
}

#[test]
fn a_fetch_from_an_unreachable_server_is_a_request_error() {
    let client = ServerClient::new(unreachable_server());
    assert!(matches!(
        client.fetch_objects(vec![]),
        Err(Error::Request { .. })
    ));
    assert!(matches!(
        client.upload_blobs(&[]),
        Err(Error::Request { .. })
    ));
}
