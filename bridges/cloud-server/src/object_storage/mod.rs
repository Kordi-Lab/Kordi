//! Private object storage behind one interface.
//!
//! Two backends exist, selected by `KORDI_OBJECT_STORAGE_BACKEND`:
//!
//! - `s3` (default): an S3-compatible store such as MinIO, reached with
//!   short-lived presigned requests signed by an access key.
//! - `gcs`: Google Cloud Storage through its JSON API, authenticated with an
//!   OAuth token from the instance metadata server. No key file or HMAC key
//!   is used, so it works where service account key creation is disabled.
//!
//! Clients never reach either store directly; the Cloud server proxies every
//! transfer and enforces size limits itself.

mod config;
mod gcs;
mod gcs_multipart;
mod gcs_token;
mod s3;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use reqwest::Response;
use thiserror::Error;
use url::Url;

use crate::attachments::{presign_download_url, presign_upload_url, S3Config};

pub use config::{
    attachment_store_from_env, configure_object_storage, valid_bucket_name, ObjectStorageBackend,
    ObjectStorageSettings,
};
pub use gcs::{GcsBucket, DEFAULT_GCS_ENDPOINT};
pub use gcs_token::{GcsTokenSource, DEFAULT_GCS_TOKEN_URL};

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ObjectStoreError {
    #[error("object was not found")]
    NotFound,
    #[error("object changed since it was recorded")]
    PreconditionFailed,
    #[error("object storage is unavailable")]
    Unavailable,
}

#[derive(Clone)]
enum Backend {
    S3(S3Config),
    Gcs(GcsBucket),
}

/// The attachment bucket: attachments, avatars, agent artifacts, and shared
/// documents all live here under distinct key prefixes.
#[derive(Clone)]
pub struct ObjectStore {
    backend: Backend,
}

impl fmt::Debug for ObjectStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObjectStore")
            .field("backend", &self.backend_name())
            .field("bucket", &self.bucket())
            .finish()
    }
}

impl From<S3Config> for ObjectStore {
    fn from(config: S3Config) -> Self {
        Self::s3(config)
    }
}

impl ObjectStore {
    pub fn s3(config: S3Config) -> Self {
        Self {
            backend: Backend::S3(config),
        }
    }

    pub fn gcs(bucket: GcsBucket) -> Self {
        Self {
            backend: Backend::Gcs(bucket),
        }
    }

    pub fn backend_name(&self) -> &'static str {
        match self.backend {
            Backend::S3(_) => "s3",
            Backend::Gcs(_) => "gcs",
        }
    }

    pub fn bucket(&self) -> &str {
        match &self.backend {
            Backend::S3(config) => &config.bucket,
            Backend::Gcs(bucket) => bucket.bucket(),
        }
    }

    /// Writes a whole object in one request.
    pub async fn put(
        &self,
        key: &str,
        content_type: Option<&str>,
        body: Bytes,
    ) -> Result<(), ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::put(config, key, content_type, body).await,
            Backend::Gcs(bucket) => bucket.put(key, content_type, body).await.map(|_| ()),
        }
    }

    /// Starts a download, optionally with an HTTP `Range` header value. Any
    /// storage status is returned so callers can stream bytes and headers.
    pub async fn get(&self, key: &str, range: Option<&str>) -> Result<Response, ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::get(config, key, range).await,
            Backend::Gcs(bucket) => bucket.get(key, range).await,
        }
    }

    pub async fn size(&self, key: &str) -> Result<u64, ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::size(config, key).await,
            Backend::Gcs(bucket) => bucket.size(key).await,
        }
    }

    /// Deletes an object; deleting a missing object succeeds.
    pub async fn delete(&self, key: &str) -> Result<(), ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::delete(config, key).await,
            Backend::Gcs(bucket) => bucket.delete(key).await,
        }
    }

    pub async fn create_multipart(&self, key: &str) -> Result<String, ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::create_multipart(config, key).await,
            Backend::Gcs(_) => Ok(gcs_multipart::new_upload_id()),
        }
    }

    /// Stores one part and returns the token that completion must present
    /// (an S3 ETag, or the GCS generation of the part object).
    pub async fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        part_number: u16,
        body: Bytes,
    ) -> Result<String, ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::upload_part(config, key, upload_id, part_number, body).await,
            Backend::Gcs(bucket) => {
                gcs_multipart::upload_part(bucket, upload_id, part_number, body).await
            }
        }
    }

    pub async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        part_tokens: &[String],
        content_type: Option<&str>,
    ) -> Result<(), ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => {
                s3::complete_multipart(config, key, upload_id, part_tokens).await
            }
            Backend::Gcs(bucket) => {
                gcs_multipart::complete(bucket, key, upload_id, part_tokens, content_type).await
            }
        }
    }

    pub async fn abort_multipart(
        &self,
        key: &str,
        upload_id: &str,
    ) -> Result<(), ObjectStoreError> {
        match &self.backend {
            Backend::S3(config) => s3::abort_multipart(config, key, upload_id).await,
            Backend::Gcs(bucket) => gcs_multipart::abort(bucket, upload_id).await,
        }
    }

    /// Bounded readiness probe: S3 `HeadBucket`, or a GCS bucket metadata read.
    pub async fn ready(&self, timeout: Duration) -> bool {
        match &self.backend {
            Backend::S3(config) => s3::ready(config, timeout).await,
            Backend::Gcs(bucket) => bucket.ready(timeout).await,
        }
    }

    /// A presigned URL that reads the object directly. Only S3 backends can
    /// produce one; GCS callers use the authenticated server routes instead.
    pub fn direct_download_url(&self, key: &str) -> Option<Url> {
        match &self.backend {
            Backend::S3(config) => presign_download_url(config, key).ok(),
            Backend::Gcs(_) => None,
        }
    }

    /// A presigned URL that writes the object directly (S3 only).
    pub fn direct_upload_url(&self, key: &str) -> Option<Url> {
        match &self.backend {
            Backend::S3(config) => presign_upload_url(config, key).ok(),
            Backend::Gcs(_) => None,
        }
    }
}

/// Builds a GCS bucket handle that shares `tokens` with other buckets.
pub fn gcs_bucket(
    endpoint: &Url,
    bucket: &str,
    tokens: &Arc<GcsTokenSource>,
) -> Result<GcsBucket, ObjectStoreError> {
    GcsBucket::new(endpoint, bucket.to_string(), tokens.clone())
}
