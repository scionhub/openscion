//! Unit tests for the repository: validity rules, root-tree derivation, the
//! log, and compare-and-swap refs.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use openscion_proto::{
    Change, ChangesetInfo, CreateChangeset, EntryKind, ObjectId, ObjectKind, RepoPath, UpdateRef,
};

use super::{MAX_CHANGES, MAX_TEXT, Repository};
use crate::{Error, FixedClock, encode_tree, object_id};

fn path(text: &str) -> RepoPath {
    RepoPath::new(text).unwrap()
}

fn upsert(repo: &mut Repository, at: &str, contents: &[u8]) -> Change {
    Change::Upsert {
        path: path(at),
        kind: EntryKind::File,
        blob: repo.put_blob(contents),
    }
}

fn delete(at: &str) -> Change {
    Change::Delete { path: path(at) }
}

fn commit(
    repo: &mut Repository,
    parents: &[ChangesetInfo],
    changes: Vec<Change>,
) -> crate::Result<ChangesetInfo> {
    repo.create_changeset(CreateChangeset::new(
        parents.iter().map(|info| info.id).collect(),
        changes,
        "test",
        "message",
    ))
}

/// Every file in a snapshot as `(path, kind, blob)`, in path order.
fn files(repo: &Repository, tree: ObjectId) -> Vec<(String, EntryKind, ObjectId)> {
    let mut out = Vec::new();
    walk(repo, tree, "", &mut out);
    out
}

fn walk(
    repo: &Repository,
    tree: ObjectId,
    prefix: &str,
    out: &mut Vec<(String, EntryKind, ObjectId)>,
) {
    for entry in repo.tree(tree).unwrap() {
        let full = format!("{prefix}{}", entry.name);
        if entry.kind == EntryKind::Tree {
            walk(repo, entry.id, &format!("{full}/"), out);
        } else {
            out.push((full, entry.kind, entry.id));
        }
    }
}

fn names(repo: &Repository, tree: ObjectId) -> Vec<String> {
    files(repo, tree)
        .into_iter()
        .map(|(name, ..)| name)
        .collect()
}

fn rule(result: crate::Result<ChangesetInfo>) -> &'static str {
    match result.unwrap_err() {
        Error::InvalidChange { rule, .. } => rule,
        other => panic!("unexpected error {other:?}"),
    }
}

fn seeded() -> (Repository, ChangesetInfo) {
    let mut repo = Repository::with_clock(FixedClock(1));
    let changes = vec![
        upsert(&mut repo, "a/x.txt", b"x"),
        upsert(&mut repo, "a/y.txt", b"y"),
        upsert(&mut repo, "b/deep/z.txt", b"z"),
        upsert(&mut repo, "top.txt", b"top"),
    ];
    let root = commit(&mut repo, &[], changes).unwrap();
    (repo, root)
}

#[test]
fn the_first_changeset_builds_a_nested_snapshot() {
    let (repo, root) = seeded();
    assert_eq!(root.lsn, 1);
    assert_eq!(
        names(&repo, root.root_tree),
        ["a/x.txt", "a/y.txt", "b/deep/z.txt", "top.txt"]
    );
    assert_eq!(repo.log_len(), 1);
}

#[test]
fn untouched_subtrees_keep_their_ids() {
    let (mut repo, root) = seeded();
    let before = repo.tree(root.root_tree).unwrap();
    let change = upsert(&mut repo, "a/x.txt", b"x2");
    let next = commit(&mut repo, &[root], vec![change]).unwrap();
    let after = repo.tree(next.root_tree).unwrap();
    assert_eq!(next.lsn, 2);
    assert_ne!(before[0].id, after[0].id, "a/ was rewritten");
    assert_eq!(before[1].id, after[1].id, "b/ is shared");
    assert_eq!(before[2].id, after[2].id, "top.txt is shared");
}

#[test]
fn deleting_the_last_file_removes_its_directories() {
    let (mut repo, root) = seeded();
    let next = commit(&mut repo, &[root], vec![delete("b/deep/z.txt")]).unwrap();
    assert_eq!(
        names(&repo, next.root_tree),
        ["a/x.txt", "a/y.txt", "top.txt"]
    );
}

#[test]
fn deleting_everything_leaves_the_empty_tree() {
    let mut repo = Repository::new();
    let change = upsert(&mut repo, "only.txt", b"1");
    let root = commit(&mut repo, &[], vec![change]).unwrap();
    let next = commit(&mut repo, &[root], vec![delete("only.txt")]).unwrap();
    assert_eq!(next.root_tree, object_id(ObjectKind::Tree, b""));
    assert_eq!(
        repo.tree(next.root_tree).unwrap(),
        [] as [openscion_proto::TreeEntry; 0]
    );
}

#[test]
fn a_file_can_become_a_directory_in_one_changeset() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt/inner", b"i");
    let next = commit(&mut repo, &[root], vec![delete("top.txt"), change]).unwrap();
    assert!(names(&repo, next.root_tree).contains(&"top.txt/inner".to_owned()));
}

#[test]
fn a_directory_can_become_a_file_in_one_changeset() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "b", b"now a file");
    let next = commit(&mut repo, &[root], vec![change, delete("b/deep/z.txt")]).unwrap();
    assert_eq!(
        names(&repo, next.root_tree),
        ["a/x.txt", "a/y.txt", "b", "top.txt"]
    );
}

#[test]
fn kinds_are_recorded_and_can_change() {
    let (mut repo, root) = seeded();
    let blob = repo.put_blob(b"top");
    let change = Change::Upsert {
        path: path("top.txt"),
        kind: EntryKind::Executable,
        blob,
    };
    let next = commit(&mut repo, &[root], vec![change]).unwrap();
    let top = files(&repo, next.root_tree).pop().unwrap();
    assert_eq!(top, ("top.txt".to_owned(), EntryKind::Executable, blob));
}

#[test]
fn rejects_a_second_parentless_changeset() {
    let (mut repo, _) = seeded();
    let change = upsert(&mut repo, "n", b"n");
    assert_eq!(
        rule(commit(&mut repo, &[], vec![change])),
        "only the first changeset may have no parents"
    );
}

#[test]
fn rejects_a_missing_parent() {
    let mut repo = Repository::new();
    let change = upsert(&mut repo, "n", b"n");
    let ghost = ObjectId::from_bytes([7; 32]);
    let result = repo.create_changeset(CreateChangeset::new(vec![ghost], vec![change], "t", "m"));
    assert_eq!(result.unwrap_err(), Error::NotFound(ghost));
}

#[test]
fn rejects_an_empty_non_merge() {
    let (mut repo, root) = seeded();
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![])),
        "only a merge may have no changes"
    );
}

#[test]
fn accepts_an_empty_merge() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "side", b"s");
    let side = commit(&mut repo, &[root], vec![change]).unwrap();
    let merge = commit(&mut repo, &[root, side], vec![]).unwrap();
    assert_eq!(merge.root_tree, root.root_tree);
}

#[test]
fn rejects_too_many_changes() {
    let (mut repo, root) = seeded();
    let changes = (0..=MAX_CHANGES)
        .map(|i| delete(&format!("f{i}")))
        .collect();
    assert_eq!(
        rule(commit(&mut repo, &[root], changes)),
        "too many changes"
    );
}

#[test]
fn rejects_oversized_text() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"new");
    let mut request = CreateChangeset::new(vec![root.id], vec![change], "t", "m");
    request.message = "m".repeat(MAX_TEXT + 1);
    assert_eq!(
        rule(repo.create_changeset(request)),
        "text or metadata too large"
    );
}

#[test]
fn accepts_pcid_path_metadata() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"new");
    let mut request = CreateChangeset::new(vec![root.id], vec![change], "t", "m");
    request.metadata = BTreeMap::from([
        ("pcid:top.txt".to_owned(), "bafk2bzaceanew".to_owned()),
        ("pcid:a/x.txt".to_owned(), "bafk2bzaceax".to_owned()),
    ]);
    let info = repo.create_changeset(request).unwrap();
    let record = repo.changeset(info.id).unwrap();
    assert_eq!(
        record
            .changeset
            .metadata
            .get("pcid:top.txt")
            .map(String::as_str),
        Some("bafk2bzaceanew")
    );
    assert_eq!(
        record
            .changeset
            .metadata
            .get("pcid:a/x.txt")
            .map(String::as_str),
        Some("bafk2bzaceax")
    );
}

#[test]
fn accepts_more_pcid_metadata_entries_than_changes() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"new");
    let mut request = CreateChangeset::new(vec![root.id], vec![change], "t", "m");
    // A commit changes few files but carries a PieceCID for every path in the
    // snapshot, which can exceed MAX_CHANGES as the tree grows.
    request.metadata = (0..=MAX_CHANGES)
        .map(|i| (format!("pcid:f{i}"), "cid".to_owned()))
        .collect();
    assert_eq!(request.metadata.len(), MAX_CHANGES + 1);
    repo.create_changeset(request).unwrap();
}

#[test]
fn rejects_a_path_changed_twice() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"new");
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![change, delete("top.txt")])),
        "path changed twice"
    );
}

#[test]
fn rejects_an_upsert_of_a_tree_kind() {
    let (mut repo, root) = seeded();
    let blob = repo.put_blob(b"t");
    let change = Change::Upsert {
        path: path("t"),
        kind: EntryKind::Tree,
        blob,
    };
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![change])),
        "upsert of a tree"
    );
}

#[test]
fn rejects_an_upsert_of_a_missing_blob() {
    let (mut repo, root) = seeded();
    let ghost = ObjectId::from_bytes([8; 32]);
    let change = Change::Upsert {
        path: path("t"),
        kind: EntryKind::File,
        blob: ghost,
    };
    assert_eq!(
        commit(&mut repo, &[root], vec![change]).unwrap_err(),
        Error::NotFound(ghost)
    );
}

#[test]
fn rejects_deleting_a_missing_file() {
    let (mut repo, root) = seeded();
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![delete("nope")])),
        "deletes a missing file"
    );
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![delete("nope/deeper")])),
        "deletes a missing file"
    );
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![delete("top.txt/under")])),
        "deletes a missing file"
    );
}

#[test]
fn rejects_deleting_a_directory() {
    let (mut repo, root) = seeded();
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![delete("a")])),
        "deletes a directory"
    );
}

#[test]
fn rejects_a_no_op_upsert() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"top");
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![change])),
        "upsert does not change the file"
    );
}

#[test]
fn rejects_a_file_under_a_file() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt/inner", b"i");
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![change])),
        "a parent is a file"
    );
}

#[test]
fn rejects_a_file_over_a_directory() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "a", b"file");
    assert_eq!(
        rule(commit(&mut repo, &[root], vec![change])),
        "path is a directory"
    );
}

#[test]
fn a_corrupt_base_tree_is_reported() {
    // The API never writes a tree that points at a blob as a directory, so
    // build one by hand and derive from it directly.
    let mut repo = Repository::new();
    let blob = repo.put_blob(b"not a tree");
    assert!(matches!(repo.tree(blob), Err(Error::Malformed { .. })));
    let entry = openscion_proto::TreeEntry::new("d", EntryKind::Tree, blob);
    let bogus_bytes = encode_tree(&[entry]);
    let bogus = crate::object_id(ObjectKind::Tree, &bogus_bytes);
    repo.put_object_verified(ObjectKind::Tree, bogus, &bogus_bytes)
        .unwrap();
    let error =
        super::derive::derive_root_tree(&mut repo.objects, bogus, &[delete("d/f")]).unwrap_err();
    assert!(matches!(error, Error::Malformed { .. }));
}

#[test]
fn an_identical_request_returns_the_existing_changeset() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"v2");
    let first = commit(&mut repo, &[root], vec![change.clone()]).unwrap();
    let again = commit(&mut repo, &[root], vec![change]).unwrap();
    assert_eq!(first, again);
    assert_eq!(repo.log_len(), 2);
}

#[test]
fn changesets_read_back_with_sorted_changes() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "a/new", b"n");
    let next = commit(&mut repo, &[root], vec![delete("top.txt"), change]).unwrap();
    let record = repo.changeset(next.id).unwrap();
    assert_eq!(record.info, next);
    assert_eq!(record.changeset.created_at, 1);
    let paths: Vec<_> = record
        .changeset
        .changes
        .iter()
        .map(|c| c.path().as_str())
        .collect();
    assert_eq!(paths, ["a/new", "top.txt"]);
    let ghost = ObjectId::from_bytes([9; 32]);
    assert_eq!(repo.changeset(ghost).unwrap_err(), Error::NotFound(ghost));
}

#[test]
fn objects_and_statistics_are_readable() {
    let (repo, root) = seeded();
    assert!(repo.object(root.root_tree).is_ok());
    assert!(repo.objects().len() >= 4);
    assert!(Repository::default().objects().is_empty());
}

#[test]
fn blobs_uploaded_with_an_id_are_verified() {
    let mut repo = Repository::new();
    let id = object_id(ObjectKind::Blob, b"data");
    repo.put_blob_verified(id, b"data").unwrap();
    assert!(matches!(
        repo.put_blob_verified(id, b"other"),
        Err(Error::CorruptObject { .. })
    ));
}

#[test]
fn refs_move_only_by_compare_and_swap() {
    let (mut repo, root) = seeded();
    let change = upsert(&mut repo, "top.txt", b"v2");
    let next = commit(&mut repo, &[root], vec![change]).unwrap();

    assert_eq!(
        repo.get_ref("main").unwrap_err(),
        Error::NoSuchRef("main".to_owned())
    );
    let created = repo
        .update_ref("main", UpdateRef::new(None, root.id))
        .unwrap();
    assert_eq!((created.target, created.version), (root.id, 1));

    let stale = repo
        .update_ref("main", UpdateRef::new(None, next.id))
        .unwrap_err();
    assert_eq!(
        stale,
        Error::RefConflict {
            name: "main".to_owned(),
            current: Some(root.id)
        }
    );
    let moved = repo
        .update_ref("main", UpdateRef::new(Some(root.id), next.id))
        .unwrap();
    assert_eq!((moved.target, moved.version), (next.id, 2));
    assert_eq!(repo.get_ref("main").unwrap(), moved);
}

#[test]
fn refs_reject_bad_names_and_unknown_targets() {
    let (mut repo, root) = seeded();
    assert!(matches!(
        repo.get_ref("../main"),
        Err(Error::InvalidPath(_))
    ));
    assert!(matches!(
        repo.update_ref("", UpdateRef::new(None, root.id)),
        Err(Error::InvalidPath(_))
    ));
    let ghost = ObjectId::from_bytes([6; 32]);
    assert_eq!(
        repo.update_ref("main", UpdateRef::new(None, ghost))
            .unwrap_err(),
        Error::NotFound(ghost)
    );
    let missing = repo
        .update_ref("main", UpdateRef::new(Some(root.id), root.id))
        .unwrap_err();
    assert_eq!(
        missing,
        Error::RefConflict {
            name: "main".to_owned(),
            current: None
        }
    );
}
