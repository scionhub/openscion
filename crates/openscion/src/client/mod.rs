//! A blocking HTTP client for the OpenScion server API.
//!
//! Each method maps to one endpoint and returns the decoded protocol payload.
//! The client checks the protocol version on [`ServerClient::info`], so a
//! caller that starts there never talks to a server it cannot understand.
//!
//! One client holds one connection pool, so the many requests of a clone or
//! an import reuse connections instead of opening one each.

use openscion_core::{
    ChangesetInfo, ChangesetRecord, CreateChangeset, ErrorBody, FetchObjects, ObjectId, RefValue,
    ServerInfo, StoredObjects, UpdateRef, is_compatible,
};
use serde::de::DeserializeOwned;
use ureq::Body;
use ureq::http::Response;

use crate::{Error, Result};

/// A client for one OpenScion server.
#[derive(Debug, Clone)]
pub struct ServerClient {
    base: String,
    agent: ureq::Agent,
    token: Option<String>,
}

/// A client scoped to one repository on a server.
#[derive(Debug, Clone)]
pub struct RepoClient {
    base: String,
    agent: ureq::Agent,
    org: String,
    repo: String,
    token: Option<String>,
}

/// One branch from `GET /v1/repos/{org}/{repo}/branches`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchInfo {
    /// Short name, such as `main` or `users/alice/feat`.
    pub name: String,
    /// Changeset id the branch points at, as hex.
    pub target: String,
    /// Stored ref name.
    pub full_ref: String,
}

/// Membership of the logged-in user in an org.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgMembership {
    /// Org id.
    pub org: String,
    /// Whether the caller can write as a member.
    pub member: bool,
    /// Whether the caller is a site admin.
    pub admin: bool,
}

fn ref_missing(error: &Error) -> bool {
    matches!(error, Error::Server { status: 404, .. })
        || matches!(error, Error::Request { message, .. } if message.contains("404"))
}

/// One located object mapping to a storage provider piece and range.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct LocateLocation {
    #[serde(rename = "objectId")]
    pub object_id: String,
    #[serde(rename = "pieceCid")]
    pub piece_cid: String,
    pub offset: u64,
    pub length: u64,
    #[serde(rename = "providerUrl")]
    pub provider_url: Option<String>,
    #[serde(rename = "pieceSize")]
    pub piece_size: Option<u64>,
}

#[derive(serde::Deserialize)]
struct LocateWrap {
    locations: Vec<LocateLocation>,
}
#[derive(serde::Deserialize)]
struct MissingWrap {
    missing: Vec<String>,
}

impl ServerClient {
    /// Creates a client for the server at `base`, such as
    /// `http://127.0.0.1:7878`. A trailing `/` is ignored.
    ///
    /// # Examples
    ///
    /// ```
    /// # use openscion::ServerClient;
    /// let client = ServerClient::new("http://127.0.0.1:7878/");
    /// assert_eq!(client.base(), "http://127.0.0.1:7878");
    /// ```
    #[must_use]
    pub fn new(base: impl Into<String>) -> Self {
        let mut base = base.into();
        while base.ends_with('/') {
            base.pop();
        }
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            base,
            agent,
            token: None,
        }
    }

    /// The server's base URL, without a trailing `/`.
    #[must_use]
    pub fn base(&self) -> &str {
        &self.base
    }

    /// Attaches a bearer token used for write requests.
    #[must_use]
    pub fn with_token(mut self, token: Option<String>) -> Self {
        self.token = token;
        self
    }

    /// Returns a client scoped to `{org}/{repo}`.
    #[must_use]
    pub fn repo(&self, org: &str, repo: &str) -> RepoClient {
        RepoClient {
            base: self.base.clone(),
            agent: self.agent.clone(),
            org: org.to_owned(),
            repo: repo.to_owned(),
            token: self.token.clone(),
        }
    }
    /// Locate a set of object ids at storage providers: piece, offset, length, and provider URL.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// and [`Error::Decode`] when the body cannot be decoded.
    pub fn locate_objects(&self, ids: &[ObjectId]) -> Result<Vec<LocateLocation>> {
        let url = format!("{}/v1/objects/locate", self.base);
        let body = serde_json::json!({
            "ids": ids.iter().map(|id| format!("{id}")).collect::<Vec<_>>()
        });
        let out: LocateWrap = json(&url, self.agent.post(&url).send_json(body))?;
        Ok(out.locations)
    }

    /// Reads org membership with `GET /v1/orgs/{org}/membership`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// [`Error::Server`] when it rejects the call, and [`Error::Decode`]
    /// when its answer is not JSON.
    pub fn org_membership(&self, org: &str) -> Result<OrgMembership> {
        let url = self.url(&format!("/v1/orgs/{org}/membership"));
        let mut req = self.agent.get(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        let value: serde_json::Value = json(&url, req.call())?;
        Ok(OrgMembership {
            org: value
                .get("org")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(org)
                .to_owned(),
            member: value
                .get("member")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            admin: value
                .get("admin")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// Creates an organization with `POST /v1/orgs`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// [`Error::Server`] when it rejects the create, and [`Error::Decode`]
    /// when its answer is not JSON.
    pub fn create_org(&self, name: &str) -> Result<serde_json::Value> {
        let url = self.url("/v1/orgs");
        let payload = serde_json::json!({ "name": name });
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send_json(&payload))
    }

    /// Lists organizations with `GET /v1/orgs`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// [`Error::Server`] when it rejects the call, and [`Error::Decode`]
    /// when its answer is not JSON.
    pub fn list_orgs(&self) -> Result<Vec<String>> {
        let url = self.url("/v1/orgs");
        let mut req = self.agent.get(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        let value: serde_json::Value = json(&url, req.call())?;
        let rows = if let Some(arr) = value.as_array() {
            arr
        } else if let Some(arr) = value.get("orgs").and_then(serde_json::Value::as_array) {
            arr
        } else {
            return Ok(Vec::new());
        };
        Ok(rows
            .iter()
            .filter_map(|row| {
                row.as_str()
                    .map(str::to_owned)
                    .or_else(|| {
                        row.get("id")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .or_else(|| {
                        row.get("name")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
            })
            .collect())
    }

    /// Creates a repository with `POST /v1/repos`, falling back to
    /// `PUT /v1/repos/{org}/{name}` on servers that only implement the latter.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// [`Error::Server`] when it rejects the create, and [`Error::Decode`]
    /// when its answer is not JSON.
    pub fn create_repo(&self, org: &str, name: &str) -> Result<serde_json::Value> {
        let url = self.url("/v1/repos");
        let payload = serde_json::json!({ "org": org, "name": name });
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        match json::<serde_json::Value>(&url, req.send_json(&payload)) {
            Ok(value) => Ok(value),
            Err(Error::Server {
                status: 404 | 405, ..
            }) => self.create_repo_put(org, name),
            Err(Error::Request { message, .. })
                if message.contains("404")
                    || message.contains("405")
                    || message.contains("Not Found") =>
            {
                self.create_repo_put(org, name)
            }
            Err(error) => Err(error),
        }
    }

    fn create_repo_put(&self, org: &str, name: &str) -> Result<serde_json::Value> {
        let url = self.url(&format!("/v1/repos/{org}/{name}"));
        let mut req = self.agent.put(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        let _ = checked(&url, req.send(&[][..]))?;
        Ok(serde_json::json!({
            "org": org,
            "name": name,
            "visibility": "public",
            "retention": {
                "freeDays": 60,
                "payUrl": "https://scionhub.github.io/checkout.html"
            }
        }))
    }

    /// Fetches `GET /v1/version` and checks that the protocol binds.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached or answers
    /// with an error status, [`Error::Decode`] when the body is not a
    /// [`ServerInfo`], and [`Error::IncompatibleProtocol`] when the server's
    /// protocol version does not bind to this client's.
    pub fn info(&self) -> Result<ServerInfo> {
        let url = self.url("/v1/version");
        let info: ServerInfo = json(&url, self.agent.get(&url).call())?;
        if !is_compatible(info.protocol_version) {
            return Err(Error::IncompatibleProtocol {
                server: info.protocol_version,
            });
        }
        Ok(info)
    }

    /// Uploads a frame stream of blobs with `POST /v1/blobs`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// [`Error::Server`] when it rejects the upload, and [`Error::Decode`]
    /// when its answer is not a [`StoredObjects`].
    pub fn upload_blobs(&self, frames: &[u8]) -> Result<StoredObjects> {
        let url = self.url("/v1/blobs");
        let mut req = self
            .agent
            .post(&url)
            .header("content-type", "application/octet-stream");
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send(frames))
    }

    /// Fetches trees and blobs by id with `POST /v1/objects`, returning the
    /// raw frame stream in request order.
    ///
    /// # Errors
    ///
    /// As for [`ServerClient::upload_blobs`].
    pub fn fetch_objects(&self, ids: Vec<ObjectId>) -> Result<Vec<u8>> {
        let url = self.url("/v1/objects");
        let mut response = checked(
            &url,
            self.agent.post(&url).send_json(FetchObjects::new(ids)),
        )?;
        response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|error| decode_error(&url, &error))
    }

    /// Creates a changeset with `POST /v1/changesets`.
    ///
    /// # Errors
    ///
    /// As for [`ServerClient::upload_blobs`].
    pub fn create_changeset(&self, request: &CreateChangeset) -> Result<ChangesetInfo> {
        let url = self.url("/v1/changesets");
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send_json(request))
    }

    /// Reads a changeset with `GET /v1/changesets/{id}`.
    ///
    /// # Errors
    ///
    /// As for [`ServerClient::upload_blobs`].
    pub fn changeset(&self, id: ObjectId) -> Result<ChangesetRecord> {
        let url = self.url(&format!("/v1/changesets/{id}"));
        json(&url, self.agent.get(&url).call())
    }

    /// Reads a ref with `GET /v1/refs/{name}`.
    ///
    /// # Errors
    ///
    /// As for [`ServerClient::upload_blobs`]; a missing ref is
    /// [`Error::Server`] with code `NotFound`.
    pub fn get_ref(&self, name: &str) -> Result<RefValue> {
        let url = self.url(&format!("/v1/refs/{name}"));
        json(&url, self.agent.get(&url).call())
    }

    /// Moves a ref by compare-and-swap with `POST /v1/refs/{name}`.
    ///
    /// # Errors
    ///
    /// As for [`ServerClient::upload_blobs`]; a lost swap is
    /// [`Error::Server`] with code `RefConflict`.
    pub fn update_ref(&self, name: &str, update: UpdateRef) -> Result<RefValue> {
        let url = self.url(&format!("/v1/refs/{name}"));
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send_json(update))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

impl RepoClient {
    #[must_use]
    /// Returns the server base URL.
    pub fn base(&self) -> &str {
        &self.base
    }
    #[must_use]
    /// Returns the organization name.
    pub fn org(&self) -> &str {
        &self.org
    }
    #[must_use]
    /// Returns the repository name.
    pub fn repo(&self) -> &str {
        &self.repo
    }
    fn url(&self, path: &str) -> String {
        format!(
            "{}{}",
            self.base,
            path.replace("{org}", &self.org)
                .replace("{repo}", &self.repo)
        )
    }

    /// Uploads a frame stream of blobs with `POST /v1/repos/{org}/{repo}/blobs`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// [`Error::Server`] when it rejects the upload, and [`Error::Decode`]
    /// when its answer is not a [`StoredObjects`].
    pub fn upload_blobs(&self, frames: &[u8]) -> Result<StoredObjects> {
        let url = self.url("/v1/repos/{org}/{repo}/blobs");
        let mut req = self
            .agent
            .post(&url)
            .header("content-type", "application/octet-stream");
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send(frames))
    }

    /// Fetches trees and blobs by id with `POST /v1/repos/{org}/{repo}/objects`,
    /// returning the raw frame stream in request order.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn fetch_objects(&self, ids: Vec<ObjectId>) -> Result<Vec<u8>> {
        let url = self.url("/v1/repos/{org}/{repo}/objects");
        let mut response = checked(
            &url,
            self.agent.post(&url).send_json(FetchObjects::new(ids)),
        )?;
        response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|error| decode_error(&url, &error))
    }

    /// Creates a changeset with `POST /v1/repos/{org}/{repo}/changesets`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn create_changeset(&self, request: &CreateChangeset) -> Result<ChangesetInfo> {
        let url = self.url("/v1/repos/{org}/{repo}/changesets");
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send_json(request))
    }

    /// Reads a changeset with `GET /v1/repos/{org}/{repo}/changesets/{id}`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn changeset(&self, id: ObjectId) -> Result<ChangesetRecord> {
        let url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/changesets/{id}"));
        json(&url, self.agent.get(&url).call())
    }

    /// Reads a ref with `GET /v1/repos/{org}/{repo}/refs/{name}`.
    ///
    /// Tries short and `refs/heads/` forms so a caller can pass `main` or
    /// `refs/heads/main`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`]; a missing ref is
    /// [`Error::Server`] with code `NotFound`.
    pub fn get_ref(&self, name: &str) -> Result<RefValue> {
        let mut last = None;
        for candidate in openscion_core::lookup_ref_names(name) {
            let url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/refs/{candidate}"));
            match json(&url, self.agent.get(&url).call()) {
                Ok(value) => return Ok(value),
                Err(error) if ref_missing(&error) => last = Some(error),
                Err(error) => return Err(error),
            }
        }
        Err(last.unwrap_or_else(|| Error::Request {
            url: self.url(&format!("/v1/repos/{{org}}/{{repo}}/refs/{name}")),
            message: "ref not found".to_owned(),
        }))
    }

    /// Lists branch refs with `GET /v1/repos/{org}/{repo}/branches`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn list_branches(&self) -> Result<Vec<BranchInfo>> {
        let url = self.url("/v1/repos/{org}/{repo}/branches");
        let value: serde_json::Value = json(&url, self.agent.get(&url).call())?;
        let mut out = Vec::new();
        if let Some(arr) = value.get("branches").and_then(serde_json::Value::as_array) {
            for item in arr {
                let name = item
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let target = item
                    .get("target")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let full = item
                    .get("ref")
                    .and_then(serde_json::Value::as_str)
                    .map_or_else(|| openscion_core::normalize_ref(&name), str::to_owned);
                if !name.is_empty() {
                    out.push(BranchInfo {
                        name,
                        target,
                        full_ref: full,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Deletes a ref with `DELETE /v1/repos/{org}/{repo}/refs/{name}`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn delete_ref(&self, name: &str) -> Result<serde_json::Value> {
        let mut last = None;
        for candidate in openscion_core::lookup_ref_names(name) {
            let url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/refs/{candidate}"));
            let mut req = self.agent.delete(&url);
            if let Some(t) = &self.token {
                req = req.header("authorization", &format!("Bearer {t}"));
            }
            match json(&url, req.call()) {
                Ok(value) => return Ok(value),
                Err(error) if ref_missing(&error) => last = Some(error),
                Err(error) => return Err(error),
            }
        }
        Err(last.unwrap_or_else(|| Error::Request {
            url: self.url(&format!("/v1/repos/{{org}}/{{repo}}/refs/{name}")),
            message: "ref not found".to_owned(),
        }))
    }

    /// Moves a ref by compare-and-swap with
    /// `POST /v1/repos/{org}/{repo}/refs/{name}`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`]; a lost swap is
    /// [`Error::Server`] with code `RefConflict`.
    pub fn update_ref(&self, name: &str, update: UpdateRef) -> Result<RefValue> {
        let url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/refs/{name}"));
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send_json(update))
    }

    /// Returns ids the server reports as missing (no storage mapping).
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// and [`Error::Decode`] when the body cannot be decoded.
    pub fn missing_objects(&self, ids: &[ObjectId]) -> Result<Vec<ObjectId>> {
        let url = self.url("/v1/repos/{org}/{repo}/objects/missing");
        let body = serde_json::json!({
            "ids": ids.iter().map(|id| format!("{id}")).collect::<Vec<_>>()
        });
        let out: MissingWrap = json(&url, self.agent.post(&url).send_json(body))?;
        let mut v = Vec::new();
        for s in out.missing {
            if let Ok(id) = s.parse() {
                v.push(id);
            }
        }
        Ok(v)
    }

    /// Locate a set of object ids at storage providers: piece, offset, length, and provider URL.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] when the server cannot be reached,
    /// and [`Error::Decode`] when the body cannot be decoded.
    pub fn locate_objects(&self, ids: &[ObjectId]) -> Result<Vec<LocateLocation>> {
        // Locate is served at the top-level, not repo-scoped.
        let url = format!("{}/v1/objects/locate", self.base);
        let body = serde_json::json!({
            "ids": ids.iter().map(|id| format!("{id}")).collect::<Vec<_>>()
        });
        let out: LocateWrap = json(&url, self.agent.post(&url).send_json(body))?;
        Ok(out.locations)
    }

    /// Resolve a batch of `PieceCIDs` into SP URLs and byte ranges via server-side `RepoDO` mapping.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] on HTTP failures and [`Error::Decode`] on decode errors.
    pub fn resolve_pieces(&self, piece_cids: &[String]) -> Result<Vec<(String, String, u64, u64)>> {
        let url = self.url("/v1/repos/{org}/{repo}/objects/resolve");
        let body = serde_json::json!({ "ids": piece_cids });
        let v: serde_json::Value = json(&url, self.agent.post(&url).send_json(body))?;
        let mut out = Vec::new();
        if let Some(arr) = v.get("results").and_then(|x| x.as_array()) {
            for r in arr {
                if let (Some(p), Some(u), Some(off), Some(len)) = (
                    r.get("pieceCid").and_then(|x| x.as_str()),
                    r.get("url").and_then(|x| x.as_str()),
                    r.get("offset").and_then(serde_json::Value::as_u64),
                    r.get("length").and_then(serde_json::Value::as_u64),
                ) {
                    out.push((p.to_owned(), u.to_owned(), off, len));
                }
            }
        }
        Ok(out)
    }

    /// Fetch one object by its `PieceCID` via the redirect-compatible endpoint.
    ///
    /// Follows a 302 redirect to the SP, preserving Range when set and never sending Authorization
    /// on the cross-origin hop. When the server returns a JSON hint `{ url, offset, length }`,
    /// performs a client-side Range GET to `url`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Request`] on HTTP failures and [`Error::Decode`] on decode errors.
    pub fn fetch_by_piece_cid(
        &self,
        piece_cid: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Vec<u8>> {
        let mut url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/objects/{piece_cid}"));
        let resp = self.agent.get(&url).call().map_err(|e| Error::Request {
            url: url.clone(),
            message: e.to_string(),
        })?;
        let status = resp.status();
        // Handle redirect
        if status.is_redirection() {
            let loc = resp
                .headers()
                .get("Location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| Error::Decode {
                    url: url.clone(),
                    message: "missing Location".to_owned(),
                })?
                .to_owned();
            url = loc;
            let mut follow = self.agent.get(&url);
            if let Some((start, end)) = range {
                let hdr = match end {
                    Some(e) => format!("bytes={start}-{e}"),
                    None => format!("bytes={start}-"),
                };
                follow = follow.header("Range", &hdr);
            }
            return follow
                .call()
                .map_err(|e| Error::Request {
                    url: url.clone(),
                    message: e.to_string(),
                })?
                .into_body()
                .with_config()
                .limit(u64::MAX)
                .read_to_vec()
                .map_err(|e| Error::Decode {
                    url: url.clone(),
                    message: e.to_string(),
                });
        }
        // JSON hint fallback
        if status.is_success() {
            // Read full body; try JSON hint, else return as bytes
            let body = resp
                .into_body()
                .with_config()
                .limit(u64::MAX)
                .read_to_vec()
                .map_err(|e| Error::Decode {
                    url: url.clone(),
                    message: e.to_string(),
                })?;
            if let Ok(hint) = serde_json::from_slice::<serde_json::Value>(&body) {
                if let (Some(u), Some(off), Some(len)) = (
                    hint.get("url").and_then(|v| v.as_str()),
                    hint.get("offset").and_then(serde_json::Value::as_u64),
                    hint.get("length").and_then(serde_json::Value::as_u64),
                ) {
                    let end = off.saturating_add(len.saturating_sub(1));
                    let mut follow = self.agent.get(u);
                    follow = follow.header("Range", &format!("bytes={off}-{end}"));
                    return follow
                        .call()
                        .map_err(|e| Error::Request {
                            url: u.to_owned(),
                            message: e.to_string(),
                        })?
                        .into_body()
                        .with_config()
                        .limit(u64::MAX)
                        .read_to_vec()
                        .map_err(|e| Error::Decode {
                            url: u.to_owned(),
                            message: e.to_string(),
                        });
                }
            }
            return Ok(body);
        }
        Err(Error::Request {
            url,
            message: format!("unexpected status {}", status.as_u16()),
        })
    }

    /// Creates a pull request with `POST /v1/repos/{org}/{repo}/pulls`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn create_pull(
        &self,
        title: &str,
        body: Option<&str>,
        head: &str,
        base: &str,
    ) -> Result<serde_json::Value> {
        let url = self.url("/v1/repos/{org}/{repo}/pulls");
        let payload = serde_json::json!({
            "title": title,
            "body": body.unwrap_or(""),
            "head": head,
            "base": base,
        });
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send_json(payload))
    }

    /// Lists pull requests with `GET /v1/repos/{org}/{repo}/pulls`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn list_pulls(&self) -> Result<serde_json::Value> {
        let url = self.url("/v1/repos/{org}/{repo}/pulls");
        json(&url, self.agent.get(&url).call())
    }

    /// Reads one pull request with `GET /v1/repos/{org}/{repo}/pulls/{n}`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn get_pull(&self, number: u32) -> Result<serde_json::Value> {
        let url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/pulls/{number}"));
        json(&url, self.agent.get(&url).call())
    }

    /// Merges a pull request with `POST /v1/repos/{org}/{repo}/pulls/{n}/merge`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn merge_pull(&self, number: u32) -> Result<serde_json::Value> {
        self.pull_action(number, "merge")
    }

    /// Closes a pull request with `POST /v1/repos/{org}/{repo}/pulls/{n}/close`.
    ///
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`].
    pub fn close_pull(&self, number: u32) -> Result<serde_json::Value> {
        self.pull_action(number, "close")
    }

    fn pull_action(&self, number: u32, action: &str) -> Result<serde_json::Value> {
        let url = self.url(&format!(
            "/v1/repos/{{org}}/{{repo}}/pulls/{number}/{action}"
        ));
        let mut req = self.agent.post(&url);
        if let Some(t) = &self.token {
            req = req.header("authorization", &format!("Bearer {t}"));
        }
        json(&url, req.send(&[][..]))
    }
}

/// Turns a transport failure or an error status into an [`Error`].
fn checked(
    url: &str,
    response: std::result::Result<Response<Body>, ureq::Error>,
) -> Result<Response<Body>> {
    let mut response = response.map_err(|error| Error::Request {
        url: url.to_owned(),
        message: error.to_string(),
    })?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    match response.body_mut().read_json::<ErrorBody>() {
        Ok(body) => Err(Error::Server {
            url: url.to_owned(),
            status: status.as_u16(),
            code: body.code,
            message: body.message,
        }),
        Err(_) => Err(Error::Request {
            url: url.to_owned(),
            message: format!("server answered {status}"),
        }),
    }
}

fn json<T: DeserializeOwned>(
    url: &str,
    response: std::result::Result<Response<Body>, ureq::Error>,
) -> Result<T> {
    checked(url, response)?
        .body_mut()
        .with_config()
        .limit(u64::MAX)
        .read_json()
        .map_err(|error| decode_error(url, &error))
}

fn decode_error(url: &str, error: &ureq::Error) -> Error {
    Error::Decode {
        url: url.to_owned(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod test;
