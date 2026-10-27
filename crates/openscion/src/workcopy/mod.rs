//! The working copy: files on disk plus the state that ties them to a
//! changeset.
//!
//! A working copy is a directory with a `.scn/state.json` recording the
//! server, the ref, the base changeset, and every tracked file's blob id and
//! stat data. A scan walks the directory and reports every file with its
//! kind, size, and modification time; a file whose stat data matches the
//! state is not re-read, which is what keeps `scn commit` proportional to
//! what changed rather than to the size of the tree. Older working copies in
//! `.opnscn/` are still read. By default a scan skips VCS metadata (`.git`
//! and similar) at every depth and does not recurse into nested git
//! checkouts (a directory that contains a `.git` file or directory, the way
//! git submodules appear on disk). `--allow-vcs` on import, commit, and
//! push opts back in. Gitlinks (mode 160000) are not recorded yet.
//!
//! Symlinks are stored as their target. On Unix a file with any execute bit
//! is an executable. Paths that are not UTF-8 are rejected.

mod types;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use openscion_core::{EntryKind, ObjectId, ObjectKind, object_id};

use crate::{Error, Result};
pub(crate) use types::{FileState, ScanOptions, Scanned, State};

/// The directory `scn` keeps its state in, at the working-copy root.
pub(crate) const STATE_DIR: &str = ".scn";
/// Older working copies wrote here; still accepted on read.
pub(crate) const LEGACY_STATE_DIR: &str = ".opnscn";
const STATE_FILE: &str = "state.json";

fn modern_state_path(root: &Path) -> PathBuf {
    root.join(STATE_DIR).join(STATE_FILE)
}

fn legacy_state_path(root: &Path) -> PathBuf {
    root.join(LEGACY_STATE_DIR).join(STATE_FILE)
}

fn load_state_path(root: &Path) -> PathBuf {
    let modern = modern_state_path(root);
    if modern.exists() {
        modern
    } else {
        legacy_state_path(root)
    }
}

fn is_state_dir_name(name: &str) -> bool {
    name == STATE_DIR || name == LEGACY_STATE_DIR
}

/// Directory or file names treated as VCS metadata.
fn is_vcs_metadata_name(name: &str) -> bool {
    matches!(name, ".git" | ".svn" | ".hg")
}

/// Whether `dir` looks like a git checkout or submodule work tree.
///
/// Git records a submodule as a gitlink (mode 160000) plus `.gitmodules`.
/// On disk the checkout is a directory whose `.git` is a gitfile (`gitdir:
/// …`) or a nested `.git` directory. Either marker is enough to skip the
/// checkout contents unless [`ScanOptions::allow_vcs`] is set.
fn is_vcs_checkout(dir: &Path) -> bool {
    dir.join(".git").symlink_metadata().is_ok()
}

/// Whether a directory entry is omitted from a default upload walk.
///
/// VCS metadata names are skipped at every depth. Working-copy state
/// directories are skipped only at the repository root. This is the default,
/// not a hard ban: [`ScanOptions::allow_vcs`] includes the VCS names.
fn skip_upload_entry(name: &str, at_root: bool, allow_vcs: bool) -> bool {
    (at_root && is_state_dir_name(name)) || (!allow_vcs && is_vcs_metadata_name(name))
}

pub(crate) fn io_error(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Whether `root` already holds a working copy.
pub(crate) fn is_working_copy(root: &Path) -> bool {
    modern_state_path(root).exists() || legacy_state_path(root).exists()
}

/// Reads the state of the working copy at `root`.
pub(crate) fn load(root: &Path) -> Result<State> {
    let path = load_state_path(root);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Error::NotAWorkingCopy(root.to_path_buf()));
        }
        Err(source) => return Err(Error::Io { path, source }),
    };
    serde_json::from_slice(&bytes).map_err(|error| Error::BadState {
        path,
        message: error.to_string(),
    })
}

/// Writes `state`, stamping `written_at` with the current time.
pub(crate) fn save(root: &Path, state: &mut State) -> Result<()> {
    let dir = root.join(STATE_DIR);
    fs::create_dir_all(&dir).map_err(io_error(&dir))?;
    state.written_at = now();
    let path = modern_state_path(root);
    let bytes = serde_json::to_vec(state).map_err(|error| Error::BadState {
        path: path.clone(),
        message: error.to_string(),
    })?;
    fs::write(&path, bytes).map_err(io_error(&path))
}

fn now() -> u64 {
    nanos(SystemTime::now())
}

fn nanos(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |elapsed| {
        u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX)
    })
}

/// Every file under `root` except the state directory, using the default
/// VCS skip, sorted by path.
pub(crate) fn scan(root: &Path) -> Result<Vec<Scanned>> {
    scan_with(root, ScanOptions::default())
}

/// Every file under `root` except the state directory, honoring `options`,
/// sorted by path.
pub(crate) fn scan_with(root: &Path, options: ScanOptions) -> Result<Vec<Scanned>> {
    let mut out = Vec::new();
    walk(root, "", options, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn walk(dir: &Path, prefix: &str, options: ScanOptions, out: &mut Vec<Scanned>) -> Result<()> {
    let at_root = prefix.is_empty();
    for entry in fs::read_dir(dir).map_err(io_error(dir))? {
        let entry = entry.map_err(io_error(dir))?;
        let full = entry.path();
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| Error::NonUtf8Path(full.clone()))?;
        if skip_upload_entry(name, at_root, options.allow_vcs) {
            continue;
        }
        let path = format!("{prefix}{name}");
        let meta = fs::symlink_metadata(&full).map_err(io_error(&full))?;
        let kind = if meta.is_dir() {
            if !options.allow_vcs && !at_root && is_vcs_checkout(&full) {
                continue;
            }
            walk(&full, &format!("{path}/"), options, out)?;
            continue;
        } else if meta.file_type().is_symlink() {
            EntryKind::Symlink
        } else if is_executable(&meta) {
            EntryKind::Executable
        } else {
            EntryKind::File
        };
        out.push(Scanned {
            path,
            kind,
            size: meta.len(),
            mtime: meta.modified().map_or(0, nanos),
        });
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &fs::Metadata) -> bool {
    false
}

/// The bytes a file is stored as: its contents, or a symlink's target.
pub(crate) fn read_content(root: &Path, file: &Scanned) -> Result<Vec<u8>> {
    let full = root.join(&file.path);
    if file.kind == EntryKind::Symlink {
        let target = fs::read_link(&full).map_err(io_error(&full))?;
        Ok(target.as_os_str().as_encoded_bytes().to_vec())
    } else {
        fs::read(&full).map_err(io_error(&full))
    }
}

/// Whether `file` can be trusted to still hold `known` without re-reading
/// it: same kind, size, and modification time, and modified strictly before
/// the state was written.
pub(crate) fn unchanged(file: &Scanned, known: &FileState, written_at: u64) -> bool {
    file.kind == known.kind
        && file.size == known.size
        && file.mtime == known.mtime
        && file.mtime < written_at
}

/// Hashes `bytes` as a blob.
pub(crate) fn blob_id(bytes: &[u8]) -> ObjectId {
    object_id(ObjectKind::Blob, bytes)
}

/// Removes a tracked file; missing paths are ignored.
pub(crate) fn remove_file(root: &Path, path: &str) -> Result<()> {
    let full = root.join(path);
    match fs::remove_file(&full) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(Error::Io { path: full, source }),
    }
}

/// Writes one file of a checkout, creating its parent directories.
pub(crate) fn write_file(root: &Path, path: &str, kind: EntryKind, bytes: &[u8]) -> Result<()> {
    let full = root.join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(io_error(parent))?;
    }
    if full.symlink_metadata().is_ok() {
        let _ = fs::remove_file(&full);
    }
    match kind {
        EntryKind::Symlink => write_symlink(&full, bytes),
        EntryKind::Executable => {
            fs::write(&full, bytes).map_err(io_error(&full))?;
            make_executable(&full)
        }
        EntryKind::File | EntryKind::Tree => fs::write(&full, bytes).map_err(io_error(&full)),
    }
}

#[cfg(unix)]
fn write_symlink(full: &Path, target: &[u8]) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;
    std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(target), full).map_err(io_error(full))
}

#[cfg(not(unix))]
fn write_symlink(full: &Path, target: &[u8]) -> Result<()> {
    fs::write(full, target).map_err(io_error(full))
}

#[cfg(unix)]
fn make_executable(full: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(full, fs::Permissions::from_mode(0o755)).map_err(io_error(full))
}

#[cfg(not(unix))]
fn make_executable(_: &Path) -> Result<()> {
    Ok(())
}

/// Whether the working copy has uncommitted edits relative to its recorded
/// snapshot. Uses the default VCS skip.
///
/// # Errors
///
/// Returns [`Error::NotAWorkingCopy`] or [`Error::Io`] when the working copy
/// cannot be read.
pub(crate) fn is_dirty(root: &Path) -> Result<bool> {
    is_dirty_with(root, ScanOptions::default())
}

/// Whether the working copy has uncommitted edits, honoring `options`.
///
/// # Errors
///
/// Returns [`Error::NotAWorkingCopy`] or [`Error::Io`] when the working copy
/// cannot be read.
pub(crate) fn is_dirty_with(root: &Path, options: ScanOptions) -> Result<bool> {
    let state = load(root)?;
    let scanned = scan_with(root, options)?;
    let mut present = HashSet::with_capacity(scanned.len());
    for file in &scanned {
        present.insert(file.path.clone());
        let Some(known) = state.files.get(&file.path) else {
            return Ok(true);
        };
        if unchanged(file, known, state.written_at) {
            continue;
        }
        let bytes = read_content(root, file)?;
        let blob = blob_id(&bytes);
        if known.kind != file.kind || known.blob != blob {
            return Ok(true);
        }
    }
    Ok(state.files.keys().any(|path| !present.contains(path)))
}

/// The stat data of a file just written, for the state.
pub(crate) fn stat(root: &Path, path: &str) -> Result<(u64, u64)> {
    let full = root.join(path);
    let meta = fs::symlink_metadata(&full).map_err(io_error(&full))?;
    Ok((meta.len(), meta.modified().map_or(0, nanos)))
}

#[cfg(test)]
mod test;
