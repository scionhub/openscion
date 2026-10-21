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
use serde::Serialize;
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
        Self { base, agent, token: None }
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
    pub fn locate_objects(&self, ids: Vec<ObjectId>) -> Result<Vec<LocateLocation>> {
        let url = format!("{}/v1/objects/locate", self.base);
        let body = serde_json::json!({
            "ids": ids.iter().map(|id| format!("{id}")).collect::<Vec<_>>()
        });
        #[derive(serde::Deserialize)]
        struct Wrapper {
            locations: Vec<LocateLocation>,
        }
        let out: Wrapper = json(&url, self.agent.post(&url).send_json(&body))?;
        Ok(out.locations)
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
        let mut req = self.agent.post(&url).header("content-type", "application/octet-stream");
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
        json(&url, req.send_json(&update))
    }

    fn post_json<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let url = self.url(path);
        json(&url, self.agent.post(&url).send_json(body))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

impl RepoClient {
    #[must_use]
    pub fn base(&self) -> &str {
        &self.base
    }
    #[must_use]
    pub fn org(&self) -> &str {
        &self.org
    }
    #[must_use]
    pub fn repo(&self) -> &str {
        &self.repo
    }
    fn url(&self, path: &str) -> String {
        format!(
            "{}{}",
            self.base,
            path.replace("{org}", &self.org).replace("{repo}", &self.repo)
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
    /// # Errors
    ///
    /// As for [`RepoClient::upload_blobs`]; a missing ref is
    /// [`Error::Server`] with code `NotFound`.
    pub fn get_ref(&self, name: &str) -> Result<RefValue> {
        let url = self.url(&format!("/v1/repos/{{org}}/{{repo}}/refs/{name}"));
        json(&url, self.agent.get(&url).call())
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
        json(&url, req.send_json(&update))
    }

    fn post_json<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let url = self.url(path);
        json(&url, self.agent.post(&url).send_json(body))
    }

    /// Locate a set of object ids at storage providers: piece, offset, length, and provider URL.
    pub fn locate_objects(&self, ids: Vec<ObjectId>) -> Result<Vec<LocateLocation>> {
        // Locate is served at the top-level, not repo-scoped.
        let url = format!("{}/v1/objects/locate", self.base);
        let body = serde_json::json!({
            "ids": ids.iter().map(|id| format!("{id}")).collect::<Vec<_>>()
        });
        #[derive(serde::Deserialize)]
        struct Wrapper {
            locations: Vec<LocateLocation>,
        }
        let out: Wrapper = json(&url, self.agent.post(&url).send_json(&body))?;
        Ok(out.locations)
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
