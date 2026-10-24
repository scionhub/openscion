//! Unit tests for the server description payload.
//!
//! These pin the serde representation, which is the wire form the CLI and the
//! web GUI both decode.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::ServerInfo;

#[test]
fn server_info_serializes_to_its_wire_form() {
    let encoded = serde_json::to_value(ServerInfo::new("0.2.1", (1, 0))).unwrap();
    assert_eq!(
        encoded,
        serde_json::json!({
            "name": "scionbase-server",
            "server_version": "0.2.1",
            "protocol_version": [1, 0]
        })
    );
}

#[test]
fn server_info_round_trips_through_json() {
    let info = ServerInfo::new("1.4.0", (1, 3));
    let encoded = serde_json::to_string(&info).unwrap();
    assert_eq!(serde_json::from_str::<ServerInfo>(&encoded).unwrap(), info);
}

#[test]
fn server_info_missing_its_protocol_version_is_rejected() {
    let decoded =
        serde_json::from_value::<ServerInfo>(serde_json::json!({ "server_version": "0.2.1" }));
    assert!(decoded.is_err());
}

#[test]
fn server_info_without_name_defaults_to_scionbase_server() {
    let info = serde_json::from_value::<ServerInfo>(serde_json::json!({
        "server_version": "0.2.1",
        "protocol_version": [1, 0]
    }))
    .unwrap();
    assert_eq!(info.name, "scionbase-server");
}
