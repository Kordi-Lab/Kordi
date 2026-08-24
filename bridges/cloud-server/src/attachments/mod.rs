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
mod content_type;
pub(crate) mod preview;
mod response;
pub mod routes;

use std::time::{Duration, SystemTime};

use rusty_s3::actions::{
    AbortMultipartUpload, CompleteMultipartUpload, CreateMultipartUpload, GetObject, HeadObject,
    PutObject, S3Action, UploadPart,
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
