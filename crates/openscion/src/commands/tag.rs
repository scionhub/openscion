//! Tags stored on the server and cached in `.scn/tags.json`.
//!
//! A tag is immutable once created. Fetch merges remote tags into the cache.
//! Push creates any cached tag the destination does not already have.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::branch::repo_client;
use crate::workcopy::{self, STATE_DIR};
use crate::{Error, RepoClient, Result};

/// One tag, annotated when `message` is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Tag {
    /// Tag name.
    pub name: String,
    /// Changeset id.
    pub target: String,
    /// Annotation message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Who created it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Milliseconds since the unix epoch.
    #[serde(default)]
    pub created_at: u64,
    /// True when the tag carries a message.
    #[serde(default)]
    pub annotated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TagFile {
    tags: BTreeMap<String, Tag>,
}

fn tag_path(root: &Path) -> std::path::PathBuf {
    root.join(STATE_DIR).join("tags.json")
}

fn load_file(root: &Path) -> Result<TagFile> {
    let path = tag_path(root);
    if !path.exists() {
        return Ok(TagFile::default());
    }
    let text = std::fs::read_to_string(&path).map_err(workcopy::io_error(&path))?;
    serde_json::from_str(&text).map_err(|error| Error::BadState {
        path,
        message: error.to_string(),
    })
}

fn save_file(root: &Path, file: &TagFile) -> Result<()> {
    let path = tag_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(workcopy::io_error(parent))?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|error| Error::BadState {
        path: path.clone(),
        message: error.to_string(),
    })?;
    std::fs::write(&path, text).map_err(workcopy::io_error(&path))
}

fn parse_tag(value: &serde_json::Value) -> Option<Tag> {
    let name = value.get("name")?.as_str()?.to_owned();
    let target = value.get("target")?.as_str()?.to_owned();
    Some(Tag {
        name,
        target,
        message: value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        author: value
            .get("author")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        created_at: value
            .get("created_at")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        annotated: value
            .get("annotated")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

fn parse_list(value: &serde_json::Value) -> Vec<Tag> {
    value
        .get("tags")
        .and_then(serde_json::Value::as_array)
        .map(|rows| rows.iter().filter_map(parse_tag).collect())
        .unwrap_or_default()
}

fn is_missing(error: &Error) -> bool {
    matches!(error, Error::Server { status: 404, .. })
        || matches!(error, Error::Request { message, .. } if message.contains("404"))
}

/// Creates a tag on the current remote and in the local cache.
pub(crate) fn create(
    root: &Path,
    name: &str,
    changeset: Option<&str>,
    message: Option<&str>,
    token: Option<String>,
) -> Result<Tag> {
    let (state, client) = repo_client(root, token)?;
    let target = match changeset {
        Some(id) => id.to_owned(),
        None => state.base.to_string(),
    };
    let value = client.create_tag(name, &target, message)?;
    let tag = parse_tag(&value).unwrap_or(Tag {
        name: name.to_owned(),
        target,
        message: message.map(str::to_owned),
        author: value
            .get("author")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        created_at: value
            .get("created_at")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        annotated: message.is_some(),
    });
    let mut file = load_file(root)?;
    file.tags.insert(tag.name.clone(), tag.clone());
    save_file(root, &file)?;
    Ok(tag)
}

/// Lists tags, preferring the server and falling back to the cache.
pub(crate) fn list(root: &Path, token: Option<String>) -> Result<Vec<Tag>> {
    let (_state, client) = repo_client(root, token)?;
    match client.list_tags() {
        Ok(value) => {
            let tags = parse_list(&value);
            let mut file = TagFile::default();
            for tag in &tags {
                file.tags.insert(tag.name.clone(), tag.clone());
            }
            let _ = save_file(root, &file);
            Ok(tags)
        }
        Err(error) if is_missing(&error) => Ok(load_file(root)?.tags.into_values().collect()),
        Err(error) => Err(error),
    }
}

/// Deletes a tag on the server and in the cache.
pub(crate) fn delete(root: &Path, name: &str, token: Option<String>) -> Result<()> {
    let (_state, client) = repo_client(root, token)?;
    client.delete_tag(name)?;
    let mut file = load_file(root)?;
    file.tags.remove(name);
    save_file(root, &file)?;
    Ok(())
}

/// Copies tags from `client` into the local cache. A 404 means the server has no tags API.
pub(crate) fn sync_down(root: &Path, client: &RepoClient) -> Result<usize> {
    let value = match client.list_tags() {
        Ok(value) => value,
        Err(error) if is_missing(&error) => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut file = load_file(root)?;
    let mut added = 0;
    for tag in parse_list(&value) {
        match file.tags.get(&tag.name) {
            Some(existing) if existing.target == tag.target => {}
            Some(_) => {}
            None => {
                file.tags.insert(tag.name.clone(), tag);
                added += 1;
            }
        }
    }
    save_file(root, &file)?;
    Ok(added)
}

/// Creates cached tags on `client`. An existing tag with the same target is left alone.
pub(crate) fn sync_up(root: &Path, client: &RepoClient) -> Result<usize> {
    let file = load_file(root)?;
    if file.tags.is_empty() {
        return Ok(0);
    }
    let mut created = 0;
    for tag in file.tags.values() {
        match client.create_tag(&tag.name, &tag.target, tag.message.as_deref()) {
            Ok(_) => created += 1,
            Err(error) if is_missing(&error) => return Ok(created),
            Err(Error::Server { status: 409, .. }) => {
                if let Ok(remote) = client.get_tag(&tag.name)
                    && remote.get("target").and_then(serde_json::Value::as_str)
                        != Some(tag.target.as_str())
                {
                    return Err(Error::Engine(openscion_core::Error::InvalidChange {
                        path: tag.name.clone(),
                        rule: "tag exists with a different target",
                    }));
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(created)
}

/// Formats a tag list the way `scn tag -l` prints it.
#[must_use]
pub(crate) fn format_list(tags: &[Tag]) -> String {
    let mut names: Vec<&Tag> = tags.iter().collect();
    names.sort_by(|left, right| left.name.cmp(&right.name));
    let mut out = String::new();
    for tag in names {
        if tag.annotated {
            let message = tag.message.as_deref().unwrap_or("");
            super::write_fmt(
                &mut out,
                format_args!("{} {} {message}\n", tag.name, tag.target),
            );
        } else {
            super::write_fmt(&mut out, format_args!("{} {}\n", tag.name, tag.target));
        }
    }
    out
}

#[cfg(test)]
mod test;
