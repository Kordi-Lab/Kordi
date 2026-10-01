//! Attachment metadata and private object-storage transport.
//!
//! The bytes themselves live in S3-compatible object storage (MinIO in
//! the kordi-cloud namespace). The Cloud server signs short-lived internal
//! URLs and proxies authenticated desktop transfers so MinIO never needs a
//! public port. The `cloud_attachments` row tracks ownership and finalized
//! metadata.
//!
//! # Lifecycle
//!
//! Small compatibility callers use initiate plus a single proxied PUT.
//! Composer files use S3 multipart upload through bounded authenticated part
//! requests, with status, resume, complete, and cancel endpoints. Only after
//! object storage confirms completion do we stamp `finalized_at`.
//!
//! Each proxied request is bounded to one part. This keeps memory independent
//! of total file size while preserving the private storage boundary.

pub(crate) mod access;
pub(crate) mod content;
mod content_type;
pub(crate) mod playback;
pub(crate) mod preview;
mod response;
pub mod routes;

use std::time::{Duration, SystemTime};

use rusty_s3::actions::{
    AbortMultipartUpload, CompleteMultipartUpload, CreateMultipartUpload, DeleteObject, GetObject,
    HeadObject, PutObject, S3Action, UploadPart,
};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use url::Url;

/// How long presigned URLs stay valid. Long enough to cover slow
/// uploaders + clock skew, short enough that a leaked URL goes stale.
pub const PRESIGNED_URL_TTL: Duration = Duration::from_secs(15 * 60);
pub const MULTIPART_CHUNK_SIZE: usize = 8 * 1024 * 1024;
pub const MAX_ATTACHMENT_SIZE_BYTES: i64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct S3Config {
    /// Endpoint clients use to PUT/GET. The signed URLs embed this
    /// host; clients must connect to the same host they receive.
    pub endpoint: Url,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

impl S3Config {
    /// Pull an `S3Config` from environment variables. Returns `None`
    /// when any of the required pieces is missing — callers can then
    /// 503 the attachment endpoints without crashing the server.
    pub fn from_env() -> Option<Self> {
        let endpoint_raw = std::env::var("S3_ENDPOINT").ok()?;
        let endpoint = Url::parse(&endpoint_raw).ok()?;
        let bucket = std::env::var("S3_BUCKET").ok()?;
        let access_key = std::env::var("S3_ACCESS_KEY").ok()?;
        let secret_key = std::env::var("S3_SECRET_KEY").ok()?;
        let region = std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        Some(Self {
            endpoint,
            region,
            bucket,
            access_key,
            secret_key,
        })
    }

    fn bucket(&self) -> Result<Bucket, rusty_s3::BucketError> {
        Bucket::new(
            self.endpoint.clone(),
            UrlStyle::Path,
            self.bucket.clone(),
            self.region.clone(),
        )
    }

    fn creds(&self) -> Credentials {
        Credentials::new(self.access_key.clone(), self.secret_key.clone())
    }
}

#[derive(Debug)]
pub enum PresignError {
    Bucket(rusty_s3::BucketError),
}

impl std::fmt::Display for PresignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bucket(err) => write!(f, "build s3 bucket: {err}"),
        }
    }
}

impl std::error::Error for PresignError {}

/// Sign a PUT URL for `object_key` valid for [`PRESIGNED_URL_TTL`].
pub fn presign_upload_url(cfg: &S3Config, object_key: &str) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    let action = PutObject::new(&bucket, Some(&creds), object_key);
    Ok(action.sign(PRESIGNED_URL_TTL))
}

/// Sign a GET URL for `object_key` valid for [`PRESIGNED_URL_TTL`].
pub fn presign_download_url(cfg: &S3Config, object_key: &str) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    let action = GetObject::new(&bucket, Some(&creds), object_key);
    Ok(action.sign(PRESIGNED_URL_TTL))
}

/// Sign a client-facing GET URL for attachment bytes. Object storage is told
/// to answer with an allowlisted media type, or with an opaque download for
/// every other type, so a direct URL never renders stored bytes as a document.
pub(crate) fn presign_attachment_download_url(
    cfg: &S3Config,
    object_key: &str,
    media_type: Option<&'static str>,
) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    let mut action = GetObject::new(&bucket, Some(&creds), object_key);
    match media_type {
        Some(media_type) => {
            action
                .query_mut()
                .insert("response-content-type", media_type);
        }
        None => {
            action
                .query_mut()
                .insert("response-content-type", content_type::OPAQUE_CONTENT_TYPE);
            action
                .query_mut()
                .insert("response-content-disposition", "attachment");
        }
    }
    Ok(action.sign(PRESIGNED_URL_TTL))
}

/// Sign a DELETE URL for `object_key` valid for [`PRESIGNED_URL_TTL`]. Used
/// only by the server; never return it to a client or write it to a log.
pub fn presign_delete_url(cfg: &S3Config, object_key: &str) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    Ok(DeleteObject::new(&bucket, Some(&creds), object_key).sign(PRESIGNED_URL_TTL))
}

/// How long one object deletion may take before it counts as failed.
const OBJECT_DELETE_TIMEOUT: Duration = Duration::from_secs(15);

/// Deletes stored attachment bytes for the content removal worker.
pub struct S3ObjectDeleter {
    config: S3Config,
    client: reqwest::Client,
}

impl S3ObjectDeleter {
    pub fn new(config: S3Config) -> Self {
        // Redirects are not followed, so a signed request never leaves the
        // configured object store.
        let client = reqwest::Client::builder()
            .timeout(OBJECT_DELETE_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, client }
    }
}

#[async_trait::async_trait]
impl crate::chat_sync::removal::ObjectStoreDeleter for S3ObjectDeleter {
    /// A 2xx or 404 response counts as deleted; 403 is reported separately
    /// so an operator can tell missing permissions from other failures.
    async fn delete_object(
        &self,
        object_key: &str,
    ) -> Result<(), crate::chat_sync::removal::ObjectDeleteError> {
        use crate::chat_sync::removal::ObjectDeleteError;
        let url =
            presign_delete_url(&self.config, object_key).map_err(|_| ObjectDeleteError::Failed)?;
        let response = self
            .client
            .delete(url)
            .send()
            .await
            .map_err(|_| ObjectDeleteError::Failed)?;
        let status = response.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else if status == reqwest::StatusCode::FORBIDDEN {
            Err(ObjectDeleteError::Forbidden)
        } else {
            Err(ObjectDeleteError::Failed)
        }
    }
}

pub fn presign_head_url(cfg: &S3Config, object_key: &str) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    Ok(HeadObject::new(&bucket, Some(&creds), object_key).sign(PRESIGNED_URL_TTL))
}

pub fn presign_create_multipart_url(cfg: &S3Config, object_key: &str) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    Ok(CreateMultipartUpload::new(&bucket, Some(&creds), object_key).sign(PRESIGNED_URL_TTL))
}

pub fn presign_upload_part_url(
    cfg: &S3Config,
    object_key: &str,
    part_number: u16,
    upload_id: &str,
) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    Ok(
        UploadPart::new(&bucket, Some(&creds), object_key, part_number, upload_id)
            .sign(PRESIGNED_URL_TTL),
    )
}

pub fn presign_complete_multipart(
    cfg: &S3Config,
    object_key: &str,
    upload_id: &str,
    etags: &[String],
) -> Result<(Url, String), PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    let url = CompleteMultipartUpload::new(
        &bucket,
        Some(&creds),
        object_key,
        upload_id,
        etags.iter().map(String::as_str),
    )
    .sign(PRESIGNED_URL_TTL);
    let body = CompleteMultipartUpload::new(
        &bucket,
        Some(&creds),
        object_key,
        upload_id,
        etags.iter().map(String::as_str),
    )
    .body();
    Ok((url, body))
}

pub fn presign_abort_multipart_url(
    cfg: &S3Config,
    object_key: &str,
    upload_id: &str,
) -> Result<Url, PresignError> {
    let bucket = cfg.bucket().map_err(PresignError::Bucket)?;
    let creds = cfg.creds();
    Ok(
        AbortMultipartUpload::new(&bucket, Some(&creds), object_key, upload_id)
            .sign(PRESIGNED_URL_TTL),
    )
}

/// Compute the URL expiry timestamp for client display, given the
/// current wall clock + the fixed TTL.
pub fn url_expires_at(now: SystemTime) -> chrono::DateTime<chrono::Utc> {
    let target = now + PRESIGNED_URL_TTL;
    chrono::DateTime::<chrono::Utc>::from(target)
}

#[cfg(test)]
mod deletion_tests;

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config() -> S3Config {
        S3Config {
            endpoint: Url::parse("http://127.0.0.1:9").unwrap(),
            region: "us-east-1".to_string(),
            bucket: "kordi-test".to_string(),
            access_key: "test-access".to_string(),
            secret_key: "test-secret".to_string(),
        }
    }

    fn query(url: &Url) -> HashMap<String, String> {
        url.query_pairs().into_owned().collect()
    }

    #[test]
    fn direct_attachment_urls_pin_safe_response_headers() {
        let opaque =
            presign_attachment_download_url(&config(), "attachments/a/att_1", None).unwrap();
        let opaque = query(&opaque);
        assert_eq!(opaque["response-content-type"], "application/octet-stream");
        assert_eq!(opaque["response-content-disposition"], "attachment");

        let image =
            presign_attachment_download_url(&config(), "attachments/a/att_2", Some("image/png"))
                .unwrap();
        let image = query(&image);
        assert_eq!(image["response-content-type"], "image/png");
        assert!(!image.contains_key("response-content-disposition"));
    }
}
