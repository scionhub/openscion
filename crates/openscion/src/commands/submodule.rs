//! First-class submodules recorded in `.scnmodules`.
//!
//! Each entry maps a path to a remote URL and, when the source is on
//! ScionBase, a pinned changeset. A git import keeps the URL as written and
//! records the gitlink id as a note when it is not a ScionBase changeset.

use std::path::Path;

use openscion_core::ObjectId;

use super::clone::{self, checkout_changeset, materialize};
use crate::remote::{self, parse_repo_url};
use crate::workcopy;
use crate::{Error, Result, ServerClient};

/// One `.scnmodules` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Module {
    /// Section name, usually the path.
    pub name: String,
    /// Working-copy path.
    pub path: String,
    /// Remote URL as given.
    pub url: String,
    /// Pinned changeset, when the submodule is on ScionBase.
    pub changeset: Option<String>,
    /// Git oid, when the source is not a ScionBase changeset.
    pub note: Option<String>,
}

const GITLINK_MODE: u32 = 0o160_000;

/// Parses `.gitmodules` or `.scnmodules`.
#[must_use]
pub(crate) fn parse_modules(text: &str) -> Vec<Module> {
    let mut modules = Vec::new();
    let mut current: Option<Module> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(name) = section_name(trimmed) {
            if let Some(module) = current.take() {
                modules.push(module);
            }
            current = Some(Module {
                name: name.to_owned(),
                path: name.to_owned(),
                url: String::new(),
                changeset: None,
                note: None,
            });
            continue;
        }
        let Some(module) = current.as_mut() else {
            continue;
        };
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "path" => value.clone_into(&mut module.path),
            "url" => value.clone_into(&mut module.url),
            "changeset" if !value.is_empty() => module.changeset = Some(value.to_owned()),
            "note" if !value.is_empty() => module.note = Some(value.to_owned()),
            _ => {}
        }
    }
    if let Some(module) = current {
        modules.push(module);
    }
    modules.retain(|module| !module.path.is_empty() && !module.url.is_empty());
    modules
}

fn section_name(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("[submodule \"")?.strip_suffix("\"]")?;
    if rest.is_empty() { None } else { Some(rest) }
}

/// Renders `.scnmodules`.
#[must_use]
pub(crate) fn render_modules(modules: &[Module]) -> String {
    let mut out = String::new();
    for module in modules {
        super::write_fmt(&mut out, format_args!("[submodule \"{}\"]\n", module.name));
        super::write_fmt(&mut out, format_args!("\tpath = {}\n", module.path));
        super::write_fmt(&mut out, format_args!("\turl = {}\n", module.url));
        if let Some(changeset) = &module.changeset {
            super::write_fmt(&mut out, format_args!("\tchangeset = {changeset}\n"));
        }
        if let Some(note) = &module.note {
            super::write_fmt(&mut out, format_args!("\tnote = {note}\n"));
        }
    }
    out
}

/// Gitlink paths and their git oids from a v2 index.
#[must_use]
pub(crate) fn gitlinks(index: &[u8]) -> Vec<(String, String)> {
    if index.len() < 12 || &index[..4] != b"DIRC" {
        return Vec::new();
    }
    let count = u32::from_be_bytes(index[8..12].try_into().unwrap_or([0, 0, 0, 0]));
    let mut out = Vec::new();
    let mut cursor = 12usize;
    for _ in 0..count {
        if cursor + 62 > index.len() {
            break;
        }
        let mode = u32::from_be_bytes(index[cursor + 24..cursor + 28].try_into().unwrap_or([0; 4]));
        let sha = &index[cursor + 40..cursor + 60];
        let flags =
            u16::from_be_bytes(index[cursor + 60..cursor + 62].try_into().unwrap_or([0, 0]));
        let name_len = usize::from(flags & 0x0fff);
        let name_at = cursor + 62;
        if name_at + name_len > index.len() {
            break;
        }
        let name = String::from_utf8_lossy(&index[name_at..name_at + name_len]).into_owned();
        if (mode & 0o170_000) == GITLINK_MODE {
            let oid = super::hex_encode(sha);
            out.push((name, oid));
        }
        let mut entry_len = 62 + name_len + 1;
        while entry_len % 8 != 0 {
            entry_len += 1;
        }
        cursor += entry_len;
    }
    out
}

/// Writes `.scnmodules` from `.gitmodules` and gitlinks. Existing files are kept.
pub(crate) fn import_gitlinks(root: &Path) -> Result<bool> {
    let dest = root.join(".scnmodules");
    if dest.exists() {
        return Ok(false);
    }
    let gitmodules = root.join(".gitmodules");
    if !gitmodules.exists() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&gitmodules).map_err(workcopy::io_error(&gitmodules))?;
    let mut modules = parse_modules(&text);
    if modules.is_empty() {
        return Ok(false);
    }
    let links = std::fs::read(root.join(".git/index"))
        .map(|bytes| gitlinks(&bytes))
        .unwrap_or_default();
    for module in &mut modules {
        if let Some(pin) = read_pin(&root.join(&module.path)) {
            module.changeset = Some(pin);
            module.note = None;
            continue;
        }
        let oid = links
            .iter()
            .find(|(path, _)| path == &module.path)
            .map(|(_, oid)| oid.clone());
        module.changeset = None;
        module.note = Some(match oid {
            Some(oid) => format!("git {oid}"),
            None => "git unknown".to_owned(),
        });
    }
    let rendered = render_modules(&modules);
    std::fs::write(&dest, rendered).map_err(workcopy::io_error(&dest))?;
    Ok(true)
}

fn read_pin(dir: &Path) -> Option<String> {
    for name in [".scn/state.json", ".opnscn/state.json"] {
        let Ok(text) = std::fs::read_to_string(dir.join(name)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(base) = value.get("base").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if base.len() == 64 && base.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Some(base.to_owned());
        }
    }
    None
}

/// Lines for `scn status` / `scn diff` when a checkout does not match its pin.
#[must_use]
pub(crate) fn pin_drift_lines(root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join(".scnmodules")) else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    for module in parse_modules(&text) {
        let Some(pin) = module.changeset else {
            continue;
        };
        let checkout = read_pin(&root.join(&module.path));
        if checkout.as_deref() != Some(pin.as_str()) {
            let have = checkout.unwrap_or_else(|| "missing".to_owned());
            lines.push(format!(
                "submodule {} pin {pin} checkout {have}",
                module.path
            ));
        }
    }
    lines
}

/// `scn submodule add <url> <path>`.
pub(crate) fn add(
    root: &Path,
    url: &str,
    path: &str,
    token_for: &dyn Fn(&str) -> Option<String>,
) -> Result<String> {
    let (server, repo) = locate(url, &workcopy::load(root)?.server)?;
    let (org, name) = split_repo(&repo)?;
    let client = ServerClient::new(&server)
        .with_token(token_for(&server))
        .repo(org, name);
    let dest = root.join(path);
    let (id, _) = clone::clone(&client, "main", &dest, None)?;
    remember(root, path, url, &id.to_string(), None)?;
    Ok(id.to_string())
}

/// `scn submodule update`.
pub(crate) fn update(
    root: &Path,
    init: bool,
    recursive: bool,
    token_for: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<String>> {
    let text = std::fs::read_to_string(root.join(".scnmodules")).unwrap_or_default();
    let mut notes = Vec::new();
    for module in parse_modules(&text) {
        let Some(pin) = module.changeset.clone() else {
            let why = module.note.unwrap_or_else(|| "no pin".to_owned());
            notes.push(format!("skip {} ({why})", module.path));
            continue;
        };
        let dest = root.join(&module.path);
        let parent_server = workcopy::load(root)
            .map(|state| state.server)
            .unwrap_or_default();
        let (server, repo) = locate(&module.url, &parent_server)?;
        let (org, name) = split_repo(&repo)?;
        let client = ServerClient::new(&server)
            .with_token(token_for(&server))
            .repo(org, name);
        let id = pin.parse::<ObjectId>().map_err(|_| {
            Error::Engine(openscion_core::Error::InvalidChange {
                path: module.path.clone(),
                rule: "submodule pin must be a 64-hex changeset id",
            })
        })?;
        if workcopy::is_working_copy(&dest) {
            checkout_changeset(&client, &dest, id)?;
        } else if init {
            materialize(&client, &dest, id)?;
        } else {
            notes.push(format!("skip {} (not initialized)", module.path));
            continue;
        }
        retarget(&dest, &server, &repo, &module.url)?;
        notes.push(format!("updated {} {pin}", module.path));
        if recursive {
            notes.extend(update(&dest, init, true, token_for)?);
        }
    }
    Ok(notes)
}

/// `scn submodule status`.
#[must_use]
pub(crate) fn status(root: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(root.join(".scnmodules")) else {
        return Vec::new();
    };
    parse_modules(&text)
        .into_iter()
        .map(|module| {
            if let Some(pin) = module.changeset {
                let checkout =
                    read_pin(&root.join(&module.path)).unwrap_or_else(|| "missing".to_owned());
                let mark = if checkout == pin { " " } else { "U" };
                format!("{mark}{pin} {} ({checkout})", module.path)
            } else {
                let note = module.note.unwrap_or_else(|| "no pin".to_owned());
                format!("? {} ({note})", module.path)
            }
        })
        .collect()
}

/// Points each submodule checkout at the URL in `.scnmodules`.
pub(crate) fn sync(root: &Path) -> Result<Vec<String>> {
    let text = std::fs::read_to_string(root.join(".scnmodules")).unwrap_or_default();
    let parent = workcopy::load(root)
        .map(|state| state.server)
        .unwrap_or_default();
    let mut notes = Vec::new();
    for module in parse_modules(&text) {
        let dest = root.join(&module.path);
        if !workcopy::is_working_copy(&dest) {
            notes.push(format!("skip {} (not initialized)", module.path));
            continue;
        }
        let (server, repo) = locate(&module.url, &parent)?;
        retarget(&dest, &server, &repo, &module.url)?;
        notes.push(format!("synced {} {}", module.path, module.url));
    }
    Ok(notes)
}

fn remember(
    root: &Path,
    path: &str,
    url: &str,
    changeset: &str,
    note: Option<String>,
) -> Result<()> {
    let file = root.join(".scnmodules");
    let mut modules = std::fs::read_to_string(&file)
        .map(|text| parse_modules(&text))
        .unwrap_or_default();
    if let Some(existing) = modules.iter_mut().find(|module| module.path == path) {
        url.clone_into(&mut existing.url);
        existing.changeset = Some(changeset.to_owned());
        existing.note = note;
    } else {
        modules.push(Module {
            name: path.to_owned(),
            path: path.to_owned(),
            url: url.to_owned(),
            changeset: Some(changeset.to_owned()),
            note,
        });
    }
    let rendered = render_modules(&modules);
    std::fs::write(&file, rendered).map_err(workcopy::io_error(&file))
}

fn locate(url: &str, parent_server: &str) -> Result<(String, String)> {
    let parsed = parse_repo_url(url)?;
    let server = match parsed.origin {
        Some(ref origin) => remote::discover_api_base(origin),
        None => parent_server.to_owned(),
    };
    Ok((server, parsed.repo_path()))
}

fn split_repo(repo: &str) -> Result<(&str, &str)> {
    repo.split_once('/').ok_or_else(|| {
        Error::Engine(openscion_core::Error::InvalidChange {
            path: repo.to_owned(),
            rule: "repository must be <org>/<repo>",
        })
    })
}

fn retarget(dest: &Path, server: &str, repo: &str, url: &str) -> Result<()> {
    let mut state = workcopy::load(dest)?;
    state.ensure_origin();
    if let Some(origin) = state.remote_mut("origin") {
        server.clone_into(&mut origin.server);
        repo.clone_into(&mut origin.repo);
        origin.url = Some(url.to_owned());
    }
    state.ensure_origin();
    workcopy::save(dest, &mut state)?;
    Ok(())
}

#[cfg(test)]
mod test;
