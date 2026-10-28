//! Ref-name helpers: short names, canonical `refs/heads/...` form, and lookup.
//!
//! Existing repositories store some refs as `main` and others as
//! `refs/heads/users/<user>/<name>`. Callers pass whichever form is convenient;
//! [`lookup_ref_names`] produces the names to try against stored refs, and
//! [`normalize_ref`] is the canonical name used when creating a new one.

/// Canonical stored name for a branch-like ref.
///
/// `refs/...` is kept as given. `users/x/y` and any other short name become
/// `refs/heads/...`.
#[must_use]
pub fn normalize_ref(name: &str) -> String {
    let name = name.trim().trim_start_matches('/');
    if name.starts_with("refs/") {
        name.to_owned()
    } else {
        format!("refs/heads/{name}")
    }
}

/// Short display name: strips a leading `refs/heads/`.
#[must_use]
pub fn short_ref(name: &str) -> String {
    name.trim()
        .trim_start_matches('/')
        .strip_prefix("refs/heads/")
        .unwrap_or(name.trim().trim_start_matches('/'))
        .to_owned()
}

/// Names to try when looking up `name`, most specific first.
///
/// A short name tries the short form (legacy `main`) then `refs/heads/<name>`.
/// A full `refs/heads/...` name tries that first, then the short form.
#[must_use]
pub fn lookup_ref_names(name: &str) -> Vec<String> {
    let name = name.trim().trim_start_matches('/').to_owned();
    if name.is_empty() {
        return Vec::new();
    }
    let mut names = Vec::with_capacity(2);
    names.push(name.clone());
    if let Some(rest) = name.strip_prefix("refs/heads/") {
        if !rest.is_empty() {
            names.push(rest.to_owned());
        }
    } else if !name.starts_with("refs/") {
        names.push(format!("refs/heads/{name}"));
    }
    names
}

/// Whether `name` is the default branch (`main` or `default`), in any form.
#[must_use]
pub fn is_protected_ref(name: &str) -> bool {
    matches!(short_ref(name).as_str(), "main" | "default")
}

/// Whether `name` is under `refs/heads/users/<username>/`.
#[must_use]
pub fn is_user_namespace_ref(name: &str, username: &str) -> bool {
    let short = short_ref(name);
    let prefix = format!("users/{username}/");
    short.starts_with(&prefix) && short.len() > prefix.len()
}

/// Upstream ref a new local branch should track.
///
/// Members and admins get `refs/heads/<name>`; everyone else gets
/// `refs/heads/users/<username>/<name>`. A name that is already a full ref or
/// already under `users/` is only normalized, not rewritten.
#[must_use]
pub fn branch_upstream(name: &str, username: &str, member: bool) -> String {
    let name = name.trim().trim_start_matches('/');
    if name.starts_with("refs/") {
        return name.to_owned();
    }
    if name.starts_with("users/") {
        return format!("refs/heads/{name}");
    }
    if member {
        format!("refs/heads/{name}")
    } else {
        format!("refs/heads/users/{username}/{name}")
    }
}

#[cfg(test)]
mod test;
