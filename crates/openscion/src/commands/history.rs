//! `scn log`, `scn blame`, and `scn show`.
//!
//! The server walks changeset parents. Blame and the unified diff are
//! computed there; this module prints them.

use std::path::Path;

use super::branch::repo_client;
use crate::{Error, Result};

/// Filters for one page of `scn log`.
#[derive(Debug)]
pub(crate) struct LogFilter<'a> {
    /// Path the changeset must touch.
    pub path: Option<&'a str>,
    /// Page size.
    pub limit: u32,
    /// Branch or ref.
    pub branch: Option<&'a str>,
    /// Author substring.
    pub author: Option<&'a str>,
    /// Inclusive start.
    pub since: Option<&'a str>,
    /// Inclusive end.
    pub until: Option<&'a str>,
    /// Message substring.
    pub grep: Option<&'a str>,
}

/// One page of `scn log`.
pub(crate) fn log(root: &Path, filter: &LogFilter<'_>, token: Option<String>) -> Result<String> {
    let (_state, client) = repo_client(root, token)?;
    let mut pairs: Vec<(&str, &str)> = Vec::new();
    let limit_text = filter.limit.to_string();
    pairs.push(("n", limit_text.as_str()));
    if let Some(path) = filter.path {
        pairs.push(("path", path));
    }
    if let Some(branch) = filter.branch {
        pairs.push(("branch", branch));
    }
    if let Some(author) = filter.author {
        pairs.push(("author", author));
    }
    let since_text = filter.since.map(parse_time).transpose()?;
    let until_text = filter.until.map(parse_time).transpose()?;
    let since_owned = since_text.as_ref().map(ToString::to_string);
    let until_owned = until_text.as_ref().map(ToString::to_string);
    if let Some(value) = since_owned.as_deref() {
        pairs.push(("since", value));
    }
    if let Some(value) = until_owned.as_deref() {
        pairs.push(("until", value));
    }
    if let Some(grep) = filter.grep {
        pairs.push(("grep", grep));
    }
    let body = client.log(&pairs)?;
    let commits = body
        .get("commits")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = String::new();
    if commits.is_empty() {
        out.push_str("no changesets\n");
        return Ok(out);
    }
    for commit in &commits {
        let id = text_field(commit, "id");
        let author = text_field(commit, "author");
        let message = text_field(commit, "message");
        let when = commit
            .get("created_at")
            .and_then(serde_json::Value::as_u64)
            .map_or_else(|| "0".to_owned(), format_time);
        super::write_fmt(
            &mut out,
            format_args!("changeset {id}\nAuthor: {author}\nDate: {when}\n\n"),
        );
        for line in message.lines() {
            super::write_fmt(&mut out, format_args!("    {line}\n"));
        }
        out.push('\n');
    }
    if let Some(cursor) = body.get("next_cursor").and_then(serde_json::Value::as_str) {
        super::write_fmt(&mut out, format_args!("next {cursor}\n"));
    }
    Ok(out)
}

/// `scn blame <path>`.
pub(crate) fn blame(
    root: &Path,
    path: &str,
    branch: Option<&str>,
    token: Option<String>,
) -> Result<String> {
    let (_state, client) = repo_client(root, token)?;
    let body = client.blame(path, branch)?;
    let lines = body
        .get("lines")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = String::new();
    for line in &lines {
        let id = text_field(line, "changeset");
        let short = &id[..id.len().min(12)];
        let author = text_field(line, "author");
        let number = line
            .get("line")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let text = text_field(line, "text");
        super::write_fmt(
            &mut out,
            format_args!("{short} ({author} {number}) {text}\n"),
        );
    }
    Ok(out)
}

/// `scn show <changeset>` including the server's unified diff.
pub(crate) fn show(root: &Path, changeset: &str, token: Option<String>) -> Result<String> {
    let (_state, client) = repo_client(root, token)?;
    let body = client.show_diff(changeset)?;
    let id = text_field(&body, "id");
    let author = text_field(&body, "author");
    let message = text_field(&body, "message");
    let when = body
        .get("created_at")
        .and_then(serde_json::Value::as_u64)
        .map_or_else(|| "0".to_owned(), format_time);
    let diff = text_field(&body, "diff");
    let mut out = format!("changeset {id}\nAuthor: {author}\nDate: {when}\n\n");
    for line in message.lines() {
        super::write_fmt(&mut out, format_args!("    {line}\n"));
    }
    if !diff.is_empty() {
        out.push('\n');
        out.push_str(&diff);
        if !diff.ends_with('\n') {
            out.push('\n');
        }
    }
    Ok(out)
}

fn text_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// Parses a unix timestamp or `YYYY-MM-DD` as milliseconds.
pub(crate) fn parse_time(text: &str) -> Result<u64> {
    let text = text.trim();
    if text.is_empty() {
        return Err(bad_time(text));
    }
    if text.bytes().all(|byte| byte.is_ascii_digit()) {
        let raw = text.parse::<u64>().map_err(|_| bad_time(text))?;
        return Ok(if raw < 1_000_000_000_000 {
            raw * 1000
        } else {
            raw
        });
    }
    let date = text.split('T').next().unwrap_or(text);
    let mut parts = date.split('-');
    let year = parts
        .next()
        .and_then(|part| part.parse::<i32>().ok())
        .ok_or_else(|| bad_time(text))?;
    let month = parts
        .next()
        .and_then(|part| part.parse::<u32>().ok())
        .ok_or_else(|| bad_time(text))?;
    let day = parts
        .next()
        .and_then(|part| part.split([' ', 'T']).next())
        .and_then(|part| part.parse::<u32>().ok())
        .ok_or_else(|| bad_time(text))?;
    if parts.next().is_some() {
        return Err(bad_time(text));
    }
    let days = days_from_civil(year, month, day).ok_or_else(|| bad_time(text))?;
    Ok(days.saturating_mul(86_400).saturating_mul(1000))
}

/// UTC `YYYY-MM-DD HH:MM:SS` from milliseconds.
#[must_use]
pub(crate) fn format_time(ms: u64) -> String {
    let secs = ms / 1000;
    let days = i64::try_from(secs / 86_400).unwrap_or(i64::MAX);
    let tod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
}

fn bad_time(_text: &str) -> Error {
    Error::Engine(openscion_core::Error::InvalidChange {
        path: "cli".to_owned(),
        rule: "cannot parse time",
    })
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<u64> {
    if !(1..=12).contains(&month) || day == 0 || day > 31 {
        return None;
    }
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let year_of_era = u32::try_from(shifted - era * 400).ok()?;
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let ordinal = (153 * month_index + 2) / 5 + day - 1;
    let era_day = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + ordinal;
    let days = i64::from(era) * 146_097 + i64::from(era_day) - 719_468;
    u64::try_from(days).ok()
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let era_day = u32::try_from(z - era * 146_097).unwrap_or(0);
    let year_of_era = (era_day - era_day / 1460 + era_day / 36524 - era_day / 146_096) / 365;
    let shifted = i32::try_from(i64::from(year_of_era) + era * 400).unwrap_or(1970);
    let ordinal = era_day - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * ordinal + 2) / 153;
    let day = ordinal - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = if month <= 2 { shifted + 1 } else { shifted };
    (year, month, day)
}

#[cfg(test)]
mod test;
