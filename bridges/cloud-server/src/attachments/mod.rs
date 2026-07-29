//! Attachment metadata + presigned-URL flow.
//!
//! The bytes themselves live in S3-compatible object storage (MinIO in
//! the kordi-cloud namespace); the cloud-server only signs short-lived
//! URLs that let the client PUT/GET directly. The `cloud_attachments`
//! row tracks ownership and post-upload metadata so a future GC can
//! cull dangling objects whose `finalized_at` never landed.
//!
//! # Lifecycle
//!
//! 1. **Initiate**: caller posts to `/v1/cloud/attachments/initiate`. We
//!    insert a row keyed by a fresh `attachment_id`, derive the
//!    canonical `object_key` from it, and return a presigned PUT URL
//!    valid for [`PRESIGNED_URL_TTL`].
//! 2. **Upload**: caller PUTs the bytes directly to MinIO using the
//!    signed URL. The cloud-server is uninvolved.
//! 3. **Finalize**: caller posts the resulting `size_bytes` (and
//!    optional `content_type` / `sha256_hex`) to
//!    `/v1/cloud/attachments/:id/finalize`. We update the row and stamp
//!    `finalized_at`. From here the attachment is "complete."
//! 4. **Download**: caller GETs `/v1/cloud/attachments/:id/download-url`
//!    to receive a short-lived signed GET URL.
//!
//! # Why presigned URLs (not server-proxied)
//!
//! Proxying would force the cloud-server to terminate every byte twice
//! — once from the client, once to MinIO — burning CPU and bandwidth
//! that's already paid for at the storage layer. Presigned URLs give
//! the client a direct path while keeping access control, since each
//! URL is scoped to one object key + one verb + a short TTL.

mod response;
pub mod routes;

use std::time::{Duration, SystemTime};

use rusty_s3::actions::{GetObject, PutObject, S3Action};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use url::Url;

/// How long presigned URLs stay valid. Long enough to cover slow
/// uploaders + clock skew, short enough that a leaked URL goes stale.
pub const PRESIGNED_URL_TTL: Duration = Duration::from_secs(15 * 60);

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

/// Compute the URL expiry timestamp for client display, given the
/// current wall clock + the fixed TTL.
pub fn url_expires_at(now: SystemTime) -> chrono::DateTime<chrono::Utc> {
    let target = now + PRESIGNED_URL_TTL;
    chrono::DateTime::<chrono::Utc>::from(target)
}
