//! End-to-end tests for import, commit, and clone against a real server.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use openscion_core::{FrameWriter, ObjectId, ObjectKind, RepoPath, object_id};

use super::diff3;
use super::{clone, commit_ref, import};
use crate::test_support::{real_server, scratch};
use crate::{Error, RepoClient, ServerClient};

/// Every file under `root` except the state directory, with its contents.
fn contents(root: &Path) -> BTreeMap<String, Vec<u8>> {
    crate::workcopy::scan(root)
        .unwrap()
        .into_iter()
        .map(|file| {
            let bytes = crate::workcopy::read_content(root, &file).unwrap();
            (file.path, bytes)
        })
        .collect()
}

fn seed(root: &Path) {
    for (path, body) in [
        ("README.md", "# demo\n"),
        ("src/lib.rs", "pub fn f() {}\n"),
        ("src/bin/main.rs", "fn main() {}\n"),
        ("docs/guide.md", "guide\n"),
        ("docs/copy.md", "guide\n"),
    ] {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
}

fn imported() -> (RepoClient, std::path::PathBuf) {
    let client = ServerClient::new(real_server()).repo("local", "default");
    let root = scratch("source");
    seed(&root);
    let (_, files) = import(&client, &root, "main", "test", "import", false).unwrap();
    assert_eq!(files, 5);
    (client, root)
}

#[test]
fn a_clone_reproduces_the_imported_tree() {
    let (client, root) = imported();
    let dest = scratch("clone").join("copy");
    let (target, files) = clone(&client, "main", &dest, None).unwrap();
    assert_eq!(files, 5);
    assert_eq!(contents(&dest), contents(&root));
    assert_eq!(client.get_ref("main").unwrap().target, target);
}

#[cfg(unix)]
#[test]
fn executables_and_symlinks_survive_a_round_trip() {
    use std::os::unix::fs::PermissionsExt;
    let client = ServerClient::new(real_server()).repo("local", "default");
    let root = scratch("kinds-source");
    fs::write(root.join("run.sh"), b"#!/bin/sh\n").unwrap();
    fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("run.sh", root.join("link")).unwrap();
    import(&client, &root, "main", "t", "m", false).unwrap();
    let dest = scratch("kinds-clone");
    clone(&client, "main", &dest, None).unwrap();
    let kinds: Vec<_> = crate::workcopy::scan(&dest)
        .unwrap()
        .into_iter()
        .map(|file| file.kind)
        .collect();
    let source: Vec<_> = crate::workcopy::scan(&root)
        .unwrap()
        .into_iter()
        .map(|file| file.kind)
        .collect();
    assert_eq!(kinds, source);
}

#[test]
fn commit_to_a_new_ref_creates_that_ref() {
    let (client, root) = imported();
    let main_before = client.get_ref("main").unwrap().target;
    fs::write(root.join("extra.txt"), b"e\n").unwrap();
    let (info, changes) = super::commit_ref(
        &root,
        "test",
        "branch",
        Some("users/alice/extra"),
        None,
        false,
    )
    .unwrap();
    assert_eq!(changes, 1);
    assert_eq!(client.get_ref("users/alice/extra").unwrap().target, info.id);
    assert_eq!(client.get_ref("main").unwrap().target, main_before);
    assert_ne!(info.id, main_before);
}

#[test]
fn commit_records_edits_additions_and_deletions() {
    let (client, root) = imported();
    fs::write(root.join("README.md"), b"# changed\n").unwrap();
    fs::write(root.join("src/new.rs"), b"// new\n").unwrap();
    fs::remove_file(root.join("docs/guide.md")).unwrap();
    let (info, changes) = commit_ref(&root, "test", "edit", None, None, false).unwrap();
    assert_eq!(changes, 3);
    assert_eq!(client.get_ref("main").unwrap().target, info.id);

    let dest = scratch("after-commit");
    clone(&client, "main", &dest, None).unwrap();
    assert_eq!(contents(&dest), contents(&root));
}

#[test]
fn merge_pcid_metadata_carries_forward_replaces_and_drops() {
    let parent = BTreeMap::from([
        ("pcid:keep.txt".to_owned(), "cid-keep".to_owned()),
        ("pcid:edit.txt".to_owned(), "cid-old".to_owned()),
        ("pcid:gone.txt".to_owned(), "cid-gone".to_owned()),
        ("review".to_owned(), "should-not-copy".to_owned()),
    ]);
    let upserts = BTreeMap::from([
        ("edit.txt".to_owned(), "cid-new".to_owned()),
        ("add.txt".to_owned(), "cid-add".to_owned()),
    ]);
    let deleted = ["gone.txt".to_owned()].into_iter().collect();
    let merged = super::merge_pcid_metadata(&parent, &upserts, &deleted);
    assert_eq!(
        merged,
        BTreeMap::from([
            ("pcid:keep.txt".to_owned(), "cid-keep".to_owned()),
            ("pcid:edit.txt".to_owned(), "cid-new".to_owned()),
            ("pcid:add.txt".to_owned(), "cid-add".to_owned()),
        ])
    );
}

#[test]
fn merge_pcid_metadata_from_an_empty_parent_is_just_upserts() {
    let upserts = BTreeMap::from([("a.rs".to_owned(), "cid-a".to_owned())]);
    let deleted = std::collections::HashSet::new();
    let merged = super::merge_pcid_metadata(&BTreeMap::new(), &upserts, &deleted);
    assert_eq!(
        merged,
        BTreeMap::from([("pcid:a.rs".to_owned(), "cid-a".to_owned())])
    );
}

#[test]
fn commit_does_not_write_pcid_changeset_metadata() {
    let (client, root) = imported();
    let parent = client
        .changeset(client.get_ref("main").unwrap().target)
        .unwrap();
    assert!(
        parent
            .changeset
            .metadata
            .keys()
            .all(|k| !k.starts_with("pcid:")),
        "import must not snapshot COMMP into changeset metadata"
    );

    fs::write(root.join("README.md"), b"# changed\n").unwrap();
    fs::write(root.join("src/new.rs"), b"// new\n").unwrap();
    fs::remove_file(root.join("docs/guide.md")).unwrap();
    let (info, _) = commit_ref(&root, "test", "edit", None, None, false).unwrap();
    let after = client.changeset(info.id).unwrap().changeset.metadata;
    assert!(
        after.keys().all(|k| !k.starts_with("pcid:")),
        "commit must not copy or write pcid: metadata"
    );
}

#[test]
fn a_clean_or_merely_touched_tree_has_nothing_to_commit() {
    let (_, root) = imported();
    assert!(matches!(
        commit_ref(&root, "t", "m", None, None, false),
        Err(Error::NothingToCommit)
    ));
    // Rewrite a file with identical bytes: its stat data changes, its
    // content does not.
    fs::write(root.join("README.md"), b"# demo\n").unwrap();
    assert!(matches!(
        commit_ref(&root, "t", "m", None, None, false),
        Err(Error::NothingToCommit)
    ));
}

#[test]
fn a_commit_from_a_clone_is_visible_to_the_next_clone() {
    let (client, _) = imported();
    let work = scratch("work");
    clone(&client, "main", &work, None).unwrap();
    fs::write(work.join("src/new.rs"), b"pub fn g() {}\n").unwrap();
    commit_ref(&work, "agent", "add new", None, None, false).unwrap();
    let check = scratch("check");
    clone(&client, "main", &check, None).unwrap();
    assert_eq!(
        fs::read(check.join("src/new.rs")).unwrap(),
        b"pub fn g() {}\n"
    );
}

#[test]
fn the_second_of_two_racing_commits_loses_the_swap() {
    let (client, _) = imported();
    let first = scratch("race-a");
    let second = scratch("race-b");
    clone(&client, "main", &first, None).unwrap();
    clone(&client, "main", &second, None).unwrap();
    fs::write(first.join("a.txt"), b"a").unwrap();
    fs::write(second.join("b.txt"), b"b").unwrap();
    commit_ref(&first, "a", "first", None, None, false).unwrap();
    let error = commit_ref(&second, "b", "second", None, None, false).unwrap_err();
    assert!(matches!(error, Error::Server { status: 409, ref code, .. } if code == "RefConflict"));
}

#[test]
fn a_sparse_clone_fetches_only_the_named_directory() {
    let (client, _) = imported();
    let dest = scratch("sparse");
    let path = RepoPath::new("src").unwrap();
    let (_, files) = clone(&client, "main", &dest, Some(&path)).unwrap();
    assert_eq!(files, 2);
    let paths: Vec<_> = contents(&dest).into_keys().collect();
    assert_eq!(paths, ["src/bin/main.rs", "src/lib.rs"]);

    let nested = scratch("sparse-nested");
    let path = RepoPath::new("src/bin").unwrap();
    clone(&client, "main", &nested, Some(&path)).unwrap();
    assert_eq!(
        contents(&nested).into_keys().collect::<Vec<_>>(),
        ["src/bin/main.rs"]
    );

    let single = scratch("sparse-file");
    let path = RepoPath::new("README.md").unwrap();
    clone(&client, "main", &single, Some(&path)).unwrap();
    assert_eq!(
        contents(&single).into_keys().collect::<Vec<_>>(),
        ["README.md"]
    );

    let none = scratch("sparse-none");
    let path = RepoPath::new("README.md/inside").unwrap();
    assert_eq!(clone(&client, "main", &none, Some(&path)).unwrap().1, 0);
}

#[test]
fn a_commit_from_a_sparse_clone_keeps_the_rest_of_the_tree() {
    let (client, root) = imported();
    let dest = scratch("sparse-commit");
    let path = RepoPath::new("docs").unwrap();
    clone(&client, "main", &dest, Some(&path)).unwrap();
    fs::write(dest.join("docs/guide.md"), b"better guide\n").unwrap();
    commit_ref(&dest, "agent", "improve the guide", None, None, false).unwrap();

    let full = scratch("sparse-commit-check");
    clone(&client, "main", &full, None).unwrap();
    let mut expected = contents(&root);
    expected.insert("docs/guide.md".to_owned(), b"better guide\n".to_vec());
    assert_eq!(contents(&full), expected);
}

#[test]
fn import_omits_nested_git_directories_from_the_changeset() {
    let client = ServerClient::new(real_server()).repo("local", "default");
    let root = scratch("git-skip-source");
    fs::write(root.join("keep.txt"), b"keep\n").unwrap();
    fs::create_dir_all(root.join("vendor/lib/.git")).unwrap();
    fs::write(root.join("vendor/lib/.git/config"), b"[core]\n").unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/HEAD"), b"ref: refs/heads/main\n").unwrap();
    let (info, files) = import(&client, &root, "main", "test", "import", false).unwrap();
    assert_eq!(files, 1);
    let paths: Vec<_> = client
        .changeset(info.id)
        .unwrap()
        .changeset
        .changes
        .iter()
        .map(|change| change.path().as_str().to_owned())
        .collect();
    assert_eq!(paths, ["keep.txt"]);
}

#[test]
fn import_allow_vcs_includes_nested_git_paths() {
    let client = ServerClient::new(real_server()).repo("local", "default");
    let root = scratch("git-allow-source");
    fs::write(root.join("keep.txt"), b"keep\n").unwrap();
    fs::create_dir_all(root.join("vendor/lib/.git")).unwrap();
    fs::write(root.join("vendor/lib/.git/config"), b"[core]\n").unwrap();
    fs::write(root.join("vendor/lib/code.rs"), b"fn f() {}\n").unwrap();
    let (info, files) = import(&client, &root, "main", "test", "import", true).unwrap();
    assert_eq!(files, 3);
    let mut paths: Vec<_> = client
        .changeset(info.id)
        .unwrap()
        .changeset
        .changes
        .iter()
        .map(|change| change.path().as_str().to_owned())
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        ["keep.txt", "vendor/lib/.git/config", "vendor/lib/code.rs"]
    );
}

#[test]
fn import_and_clone_refuse_an_occupied_directory() {
    let (client, root) = imported();
    assert!(matches!(
        import(&client, &root, "main", "t", "m", false),
        Err(Error::AlreadyExists(_))
    ));
    assert!(matches!(
        clone(&client, "main", &root, None),
        Err(Error::AlreadyExists(_))
    ));
}

#[test]
fn commit_outside_a_working_copy_fails() {
    let root = scratch("not-a-copy");
    assert!(matches!(
        commit_ref(&root, "t", "m", None, None, false),
        Err(Error::NotAWorkingCopy(_))
    ));
}

#[test]
fn cloning_a_missing_ref_reports_the_server_error() {
    let client = ServerClient::new(real_server()).repo("local", "default");
    let dest = scratch("no-ref");
    let error = clone(&client, "main", &dest, None).unwrap_err();
    assert!(matches!(error, Error::Server { status: 404, .. }));
}

#[test]
fn fetched_objects_are_verified() {
    let id = object_id(ObjectKind::Blob, b"good");
    let mut frames = FrameWriter::new();
    frames.push(id, b"evil");
    let bytes = frames.finish();
    let error = super::clone::verified(&bytes, ObjectKind::Blob, &[id]).unwrap_err();
    assert!(matches!(
        error,
        Error::Engine(openscion_core::Error::CorruptObject { .. })
    ));

    let missing = ObjectId::from_bytes([9; 32]);
    let error = super::clone::verified(&[], ObjectKind::Blob, &[missing]).unwrap_err();
    assert!(matches!(
        error,
        Error::Engine(openscion_core::Error::NotFound(id)) if id == missing
    ));
}

#[test]
fn uploads_are_split_into_batches() {
    let client = ServerClient::new(real_server()).repo("local", "default");
    let blobs: Vec<_> = [b"aaaa", b"bbbb", b"cccc"]
        .iter()
        .map(|bytes| (object_id(ObjectKind::Blob, *bytes), bytes.to_vec()))
        .collect();
    // Each frame is 40 bytes of header plus 4 of body: two fit in 100 bytes.
    assert_eq!(super::upload_in_batches(&client, &blobs, 100).unwrap(), 2);
    assert_eq!(super::upload_in_batches(&client, &[], 100).unwrap(), 0);
    let ids: Vec<_> = blobs.iter().map(|(id, _)| *id).collect();
    assert_ne!(client.fetch_objects(ids).unwrap(), Vec::<u8>::new());
}

#[test]
fn merge3_takes_the_changed_side_or_marks_a_conflict() {
    let base = b"a\nb\nc\n";
    let local = b"a\nX\nc\n";
    let other = b"a\nb\nY\n";
    let merged = diff3::merge3(base, local, other, "main");
    assert!(!merged.conflict);
    assert_eq!(merged.bytes, b"a\nX\nY\n");

    let both = diff3::merge3(base, b"a\nL\nc\n", b"a\nR\nc\n", "main");
    assert!(both.conflict);
    let text = String::from_utf8(both.bytes).unwrap();
    assert!(text.contains(diff3::local_marker()));
    assert!(text.contains("======="));
    assert!(text.contains(">>>>>>> main"));
    assert!(text.contains('L'));
    assert!(text.contains('R'));

    assert_eq!(diff3::merge3(base, local, local, "main").bytes, local);
    assert_eq!(diff3::merge3(base, base, other, "main").bytes, other);
    assert_eq!(diff3::merge3(base, local, base, "main").bytes, local);

    let binary = diff3::merge3(&[0, 1, 2], &[0, 9, 2], &[0, 8, 2], "main");
    assert!(binary.conflict);
    assert!(diff3::contains_conflict_markers(&binary.bytes));
    assert!(!diff3::contains_conflict_markers(b"no markers\n"));

    // Add / delete against a common ancestor: take the changed side.
    assert_eq!(diff3::merge3(b"a\n", b"a\n", b"", "main").bytes, b"");
    assert_eq!(diff3::merge3(b"a\n", b"", b"a\n", "main").bytes, b"");
    let del = diff3::merge3(b"a\n", b"b\n", b"", "main");
    assert!(del.conflict);
    assert!(diff3::contains_conflict_markers(&del.bytes));
}

#[test]
fn branch_new_tracks_upstream_and_switch_refuses_when_dirty() {
    let (client, _root) = imported();
    let work = scratch("branch-new");
    clone(&client, "main", &work, None).unwrap();
    let state = crate::workcopy::load(&work).unwrap();
    assert_eq!(state.branch_name(), "main");

    let (branch, upstream) =
        super::create_branch(&work, "feat", None, None, "alice", true).unwrap();
    assert_eq!(branch, "feat");
    assert_eq!(upstream, "refs/heads/feat");
    let state = crate::workcopy::load(&work).unwrap();
    assert_eq!(state.branch_name(), "feat");
    assert_eq!(state.upstream_ref(), "refs/heads/feat");

    fs::write(work.join("dirty.txt"), b"nope").unwrap();
    let err = super::switch_branch(&work, "main", None).unwrap_err();
    assert!(matches!(err, Error::DirtyWorkingCopy));
    fs::remove_file(work.join("dirty.txt")).unwrap();

    let (current, branches) = super::list_branches(&work, None).unwrap();
    assert_eq!(current, "feat");
    assert!(branches.iter().any(|b| b.name == "main"));

    super::publish_ref(&work, "refs/heads/feat", None).unwrap();
    let deleted = super::delete_branch(&work, "feat", None).unwrap_err();
    assert!(
        deleted
            .to_string()
            .contains("cannot delete the current branch")
    );
    super::switch_branch(&work, "main", None).unwrap();
    let deleted = super::delete_branch(&work, "feat", None).unwrap();
    assert!(deleted.contains("feat"));
}

#[test]
fn sync_merges_upstream_local_and_conflicts_and_blocks_commit() {
    let (client, root) = imported();
    let feature = scratch("sync-feature");
    clone(&client, "main", &feature, None).unwrap();

    fs::write(root.join("docs/guide.md"), b"upstream guide\n").unwrap();
    fs::write(root.join("only-up.txt"), b"from main\n").unwrap();
    let (main_tip, _) = commit_ref(&root, "test", "move main", None, None, false).unwrap();

    fs::write(feature.join("docs/guide.md"), b"local guide\n").unwrap();
    fs::write(feature.join("only-local.txt"), b"mine\n").unwrap();
    fs::write(feature.join("README.md"), b"# local readme\n").unwrap();

    let summary = super::sync(&feature, "main", None).unwrap();
    assert!(summary.updated.iter().any(|p| p == "only-up.txt"));
    assert!(summary.kept.iter().any(|p| p == "only-local.txt"));
    assert!(summary.conflicted.iter().any(|p| p == "docs/guide.md"));
    let guide = fs::read_to_string(feature.join("docs/guide.md")).unwrap();
    assert!(guide.contains("<<<<<<< local"));
    assert!(guide.contains(">>>>>>> main"));
    assert_eq!(
        fs::read(feature.join("only-up.txt")).unwrap(),
        b"from main\n"
    );
    assert_eq!(fs::read(feature.join("only-local.txt")).unwrap(), b"mine\n");

    let blocked = commit_ref(
        &feature,
        "test",
        "cannot",
        Some("users/alice/feat"),
        None,
        false,
    );
    assert!(matches!(
        blocked,
        Err(Error::UnresolvedConflicts { count: 1 })
    ));

    fs::write(feature.join("docs/guide.md"), b"resolved guide\n").unwrap();
    let (info, _) = commit_ref(
        &feature,
        "test",
        "sync merge",
        Some("users/alice/feat"),
        None,
        false,
    )
    .unwrap();
    let record = client.changeset(info.id).unwrap();
    assert_eq!(record.changeset.parents[0], main_tip.id);
    assert_eq!(
        fs::read(feature.join("docs/guide.md")).unwrap(),
        b"resolved guide\n"
    );
}
