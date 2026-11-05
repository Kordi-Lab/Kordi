//! Google Cloud Storage JSON API client for one bucket.
//!
//! Requests authenticate with the instance identity (see `gcs_token`). No
//! request URL carries a credential, so URLs may appear in errors, but the
//! bucket and object names are still kept out of logs.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::gcs_token::GcsTokenSource;
use super::ObjectStoreError;

/// Public JSON API origin.
pub const DEFAULT_GCS_ENDPOINT: &str = "https://storage.googleapis.com";
/// Compose accepts at most this many source objects per request.
pub(super) const MAX_COMPOSE_SOURCES: usize = 32;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct ObjectMetadata {
    size: Option<String>,
    generation: Option<String>,
}

#[derive(Deserialize)]
struct ListPage {
    #[serde(default)]
    items: Vec<ListItem>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct ListItem {
    name: String,
}

/// One GCS bucket reached through the JSON API.
#[derive(Clone)]
pub struct GcsBucket {
    http: reqwest::Client,
    endpoint: String,
    bucket: String,
    tokens: Arc<GcsTokenSource>,
}

impl fmt::Debug for GcsBucket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GcsBucket")
            .field("bucket", &self.bucket)
            .field("tokens", &self.tokens)
            .finish_non_exhaustive()
    }
}

/// Percent-encodes an object name for a URL path segment or query value.
fn encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

impl GcsBucket {
    pub fn new(
        endpoint: &Url,
        bucket: String,
        tokens: Arc<GcsTokenSource>,
    ) -> Result<Self, ObjectStoreError> {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ObjectStoreError::Unavailable)?;
        Ok(Self {
            http,
            endpoint: endpoint.as_str().trim_end_matches('/').to_string(),
            bucket,
            tokens,
        })
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    fn bucket_url(&self) -> String {
        format!("{}/storage/v1/b/{}", self.endpoint, encode(&self.bucket))
    }

    fn object_url(&self, name: &str) -> String {
        format!("{}/o/{}", self.bucket_url(), encode(name))
    }

    /// Sends a request with a bearer token. A rejected token is dropped and
    /// the request is retried once with a fresh one.
    async fn send(
        &self,
        build: impl Fn(&reqwest::Client) -> RequestBuilder,
    ) -> Result<Response, ObjectStoreError> {
        for attempt in 0..2 {
            let authorization = self.tokens.authorization().await?;
            let response = build(&self.http)
                .header(reqwest::header::AUTHORIZATION, authorization)
                .send()
                .await
                .map_err(|_| ObjectStoreError::Unavailable)?;
            if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                self.tokens.invalidate().await;
                continue;
            }
            return Ok(response);
        }
        Err(ObjectStoreError::Unavailable)
    }

    fn check(response: &Response) -> Result<(), ObjectStoreError> {
        match response.status() {
            status if status.is_success() => Ok(()),
            StatusCode::NOT_FOUND => Err(ObjectStoreError::NotFound),
            StatusCode::PRECONDITION_FAILED => Err(ObjectStoreError::PreconditionFailed),
            status => {
                eprintln!("[object-storage] storage request failed: {status}");
                Err(ObjectStoreError::Unavailable)
            }
        }
    }

    async fn generation(response: Response) -> Result<String, ObjectStoreError> {
        Self::check(&response)?;
        let metadata: ObjectMetadata = response
            .json()
            .await
            .map_err(|_| ObjectStoreError::Unavailable)?;
        metadata
            .generation
            .filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
            .ok_or(ObjectStoreError::Unavailable)
    }

    /// Uploads `body` in one media request and returns the new generation.
    pub async fn put(
        &self,
        name: &str,
        content_type: Option<&str>,
        body: Bytes,
    ) -> Result<String, ObjectStoreError> {
        let url = format!(
            "{}/upload/storage/v1/b/{}/o?uploadType=media&name={}",
            self.endpoint,
            encode(&self.bucket),
            encode(name)
        );
        let content_type = content_type.unwrap_or("application/octet-stream");
        let response = self
            .send(|http| {
                http.post(&url)
                    .header(reqwest::header::CONTENT_TYPE, content_type)
                    .body(body.clone())
            })
            .await?;
        Self::generation(response).await
    }

    /// Starts a media download. The response is returned as is, including
    /// `206`, `404`, and `416`, so callers can stream it and copy headers.
    pub async fn get(&self, name: &str, range: Option<&str>) -> Result<Response, ObjectStoreError> {
        let url = format!("{}?alt=media", self.object_url(name));
        self.send(|http| {
            let request = http.get(&url);
            match range {
                Some(value) => request.header(reqwest::header::RANGE, value),
                None => request,
            }
        })
        .await
    }

    pub async fn size(&self, name: &str) -> Result<u64, ObjectStoreError> {
        let url = format!("{}?fields=size", self.object_url(name));
        let response = self.send(|http| http.get(&url)).await?;
        Self::check(&response)?;
        let metadata: ObjectMetadata = response
            .json()
            .await
            .map_err(|_| ObjectStoreError::Unavailable)?;
        metadata
            .size
            .and_then(|value| value.parse().ok())
            .ok_or(ObjectStoreError::Unavailable)
    }

    /// Deletes an object. A missing object counts as deleted.
    pub async fn delete(&self, name: &str) -> Result<(), ObjectStoreError> {
        let url = self.object_url(name);
        let response = self.send(|http| http.delete(&url)).await?;
        match Self::check(&response) {
            Ok(()) | Err(ObjectStoreError::NotFound) => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// Lists every object name under `prefix`.
    pub async fn list(&self, prefix: &str) -> Result<Vec<String>, ObjectStoreError> {
        let mut names = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut url = format!(
                "{}/o?prefix={}&fields=items(name),nextPageToken",
                self.bucket_url(),
                encode(prefix)
            );
            if let Some(token) = page_token.as_deref() {
                url.push_str(&format!("&pageToken={}", encode(token)));
            }
            let response = self.send(|http| http.get(&url)).await?;
            Self::check(&response)?;
            let page: ListPage = response
                .json()
                .await
                .map_err(|_| ObjectStoreError::Unavailable)?;
            names.extend(page.items.into_iter().map(|item| item.name));
            match page.next_page_token.filter(|token| !token.is_empty()) {
                Some(token) => page_token = Some(token),
                None => return Ok(names),
            }
        }
    }

    /// Concatenates up to [`MAX_COMPOSE_SOURCES`] objects into `destination`.
    /// Each source may name the generation it must still have.
    pub async fn compose(
        &self,
        destination: &str,
        sources: &[(String, Option<String>)],
        content_type: Option<&str>,
    ) -> Result<String, ObjectStoreError> {
        if sources.is_empty() || sources.len() > MAX_COMPOSE_SOURCES {
            return Err(ObjectStoreError::Unavailable);
        }
        let source_objects = sources
            .iter()
            .map(|(name, generation)| match generation {
                Some(generation) => json!({
                    "name": name,
                    "objectPreconditions": { "ifGenerationMatch": generation },
                }),
                None => json!({ "name": name }),
            })
            .collect::<Vec<_>>();
        let body = json!({
            "sourceObjects": source_objects,
            "destination": {
                "contentType": content_type.unwrap_or("application/octet-stream"),
            },
        });
        let url = format!("{}/compose", self.object_url(destination));
        let response = self.send(|http| http.post(&url).json(&body)).await?;
        Self::generation(response).await
    }

    /// Reads bucket metadata, which proves the identity can reach the bucket.
    pub async fn ready(&self, timeout: Duration) -> bool {
        let url = format!("{}?fields=name", self.bucket_url());
        self.send(|http| http.get(&url).timeout(timeout))
            .await
            .is_ok_and(|response| response.status().is_success())
    }
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn object_names_are_encoded_as_one_segment() {
        assert_eq!(encode("attachments/a b/c+d"), "attachments%2Fa%20b%2Fc%2Bd");
        assert_eq!(encode("v1.2_x-y~z"), "v1.2_x-y~z");
    }
}
