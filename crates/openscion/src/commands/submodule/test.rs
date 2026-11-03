//! `.scnmodules` parsing, gitlink import, and pin drift.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unreadable_literal
)]

use super::{Module, gitlinks, import_gitlinks, parse_modules, pin_drift_lines, render_modules};
use crate::test_support::scratch;

fn sample() -> Module {
    Module {
        name: "vendor/lib".to_owned(),
        path: "vendor/lib".to_owned(),
        url: "acme/lib".to_owned(),
        changeset: Some("ab".repeat(32)),
        note: None,
    }
}

#[test]
fn modules_round_trip() {
    let text = render_modules(&[sample()]);
    let parsed = parse_modules(&text);
    assert_eq!(parsed, vec![sample()]);
    assert!(!text.contains("piece"));
}

#[test]
fn a_git_index_yields_gitlinks() {
    let sha = [0x11u8; 20];
    let index = git_index("vendor/lib", 0o160000, &sha);
    let links = gitlinks(&index);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].0, "vendor/lib");
    assert_eq!(links[0].1, "11".repeat(20));
    assert!(gitlinks(&git_index("README", 0o100644, &sha)).is_empty());
}

#[test]
fn import_keeps_the_git_url_and_records_a_note() {
    let root = scratch("gitlink-import");
    std::fs::write(
        root.join(".gitmodules"),
        "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = https://git.example/acme/lib.git\n",
    )
    .unwrap();
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(
        root.join(".git/index"),
        git_index("vendor/lib", 0o160000, &[0xab; 20]),
    )
    .unwrap();
    assert!(import_gitlinks(&root).unwrap());
    let text = std::fs::read_to_string(root.join(".scnmodules")).unwrap();
    assert!(text.contains("url = https://git.example/acme/lib.git"));
    assert!(text.contains("note = git "));
    assert!(text.contains(&"ab".repeat(20)));
    assert!(!text.contains("changeset"));
    assert!(!import_gitlinks(&root).unwrap());
}

#[test]
fn a_nested_checkout_pin_is_a_changeset() {
    let root = scratch("gitlink-pin");
    std::fs::write(
        root.join(".gitmodules"),
        "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = acme/lib\n",
    )
    .unwrap();
    let nested = root.join("vendor/lib/.scn");
    std::fs::create_dir_all(&nested).unwrap();
    let pin = "cd".repeat(32);
    std::fs::write(nested.join("state.json"), format!(r#"{{"base":"{pin}"}}"#)).unwrap();
    assert!(import_gitlinks(&root).unwrap());
    let parsed = parse_modules(&std::fs::read_to_string(root.join(".scnmodules")).unwrap());
    assert_eq!(parsed[0].changeset.as_deref(), Some(pin.as_str()));
    assert!(parsed[0].note.is_none());
}

#[test]
fn pin_drift_compares_the_checkout() {
    let root = scratch("pin-drift");
    let pin = "aa".repeat(32);
    let have = "bb".repeat(32);
    std::fs::write(
        root.join(".scnmodules"),
        format!(
            "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = acme/lib\n\tchangeset = {pin}\n"
        ),
    )
    .unwrap();
    let nested = root.join("vendor/lib/.scn");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("state.json"), format!(r#"{{"base":"{have}"}}"#)).unwrap();
    let lines = pin_drift_lines(&root);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains(&pin));
    assert!(lines[0].contains(&have));
}

fn git_index(path: &str, mode: u32, sha: &[u8; 20]) -> Vec<u8> {
    let name = path.as_bytes();
    let mut entry = vec![0u8; 62];
    entry[24..28].copy_from_slice(&mode.to_be_bytes());
    entry[40..60].copy_from_slice(sha);
    let flags = u16::try_from(name.len()).unwrap_or(0x0fff) & 0x0fff;
    entry[60..62].copy_from_slice(&flags.to_be_bytes());
    entry.extend_from_slice(name);
    entry.push(0);
    while entry.len() % 8 != 0 {
        entry.push(0);
    }
    let mut index = b"DIRC".to_vec();
    index.extend_from_slice(&2u32.to_be_bytes());
    index.extend_from_slice(&1u32.to_be_bytes());
    index.extend(entry);
    index
}
