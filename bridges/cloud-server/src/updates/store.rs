use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::{Bytes, BytesMut};
use futures_util::{Stream, StreamExt};
use rusty_s3::actions::{GetObject, HeadObject, S3Action};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use semver::Version;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

use super::model::{ChannelPointer, ReleaseAsset, ReleaseManifest};

pub const MAX_RELEASE_METADATA_BYTES: usize = 1024 * 1024;
const PRESIGNED_REQUEST_TTL: Duration = Duration::from_secs(2 * 60);

#[derive(Clone)]
pub struct ReleaseStoreConfig {
    pub endpoint: Url,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

impl fmt::Debug for ReleaseStoreConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReleaseStoreConfig")
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("credentials", &"[REDACTED]")
            .finish()
    }
}

impl ReleaseStoreConfig {
    pub fn from_env() -> Option<Self> {
        let endpoint = Url::parse(&non_empty_env("KORDI_RELEASE_S3_ENDPOINT")?).ok()?;
        let bucket = non_empty_env("KORDI_RELEASE_S3_BUCKET")?;
        if bucket != "kordi-releases" {
            return None;
        }
        Some(Self {
            endpoint,
            region: std::env::var("KORDI_RELEASE_S3_REGION")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "us-east-1".to_string()),
            bucket,
            access_key: non_empty_env("KORDI_RELEASE_S3_ACCESS_KEY")?,
            secret_key: non_empty_env("KORDI_RELEASE_S3_SECRET_KEY")?,
        })
    }

    fn bucket(&self) -> Result<Bucket, ReleaseStoreError> {
        Bucket::new(
            self.endpoint.clone(),
            UrlStyle::Path,
            self.bucket.clone(),
            self.region.clone(),
        )
        .map_err(|_| ReleaseStoreError::Unavailable)
    }

    fn credentials(&self) -> Credentials {
        Credentials::new(self.access_key.clone(), self.secret_key.clone())
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseStoreError {
    #[error("release object was not found")]
    NotFound,
    #[error("release storage is unavailable")]
    Unavailable,
    #[error("release metadata exceeds the size limit")]
    MetadataTooLarge,
    #[error("release metadata is invalid")]
    InvalidMetadata,
    #[error("release manifest digest does not match the channel pointer")]
    DigestMismatch,
    #[error("release object length does not match its manifest")]
    LengthMismatch,
}

pub struct ReleaseObjectStream {
    pub size_bytes: u64,
    pub body: Pin<Box<dyn Stream<Item = Result<Bytes, ReleaseStoreError>> + Send>>,
}

impl fmt::Debug for ReleaseObjectStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReleaseObjectStream")
            .field("size_bytes", &self.size_bytes)
            .field("body", &"[STREAM]")
            .finish()
    }
}

#[async_trait]
pub trait ReleaseStoreBackend: Send + Sync {
    async fn get_metadata(&self, key: &str, max_bytes: usize) -> Result<Bytes, ReleaseStoreError>;
    async fn head_object(&self, key: &str) -> Result<u64, ReleaseStoreError>;
    async fn stream_object(&self, key: &str) -> Result<ReleaseObjectStream, ReleaseStoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseCatalog {
    pub pointer: ChannelPointer,
    pub release: ReleaseManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedReleaseAsset {
    pub release: ReleaseManifest,
    pub asset: ReleaseAsset,
}

#[derive(Clone)]
pub struct ReleaseCatalogStore {
    backend: Arc<dyn ReleaseStoreBackend>,
}

impl ReleaseCatalogStore {
    pub fn new(backend: Arc<dyn ReleaseStoreBackend>) -> Self {
        Self { backend }
    }

    pub async fn load_channel(
        &self,
        channel: &str,
    ) -> Result<Option<ReleaseCatalog>, ReleaseStoreError> {
        if !matches!(channel, "beta" | "acceptance") {
            return Err(ReleaseStoreError::InvalidMetadata);
        }
        let pointer_key = format!("desktop/channels/{channel}/latest.json");
        let pointer_bytes = match self
            .backend
            .get_metadata(&pointer_key, MAX_RELEASE_METADATA_BYTES)
            .await
        {
            Ok(bytes) => bytes,
            Err(ReleaseStoreError::NotFound) => return Ok(None),
            Err(error) => return Err(error),
        };
        let pointer: ChannelPointer = serde_json::from_slice(&pointer_bytes)
            .map_err(|_| ReleaseStoreError::InvalidMetadata)?;
        pointer
            .validate()
            .map_err(|_| ReleaseStoreError::InvalidMetadata)?;
        if pointer.channel != channel {
            return Err(ReleaseStoreError::InvalidMetadata);
        }

        let release_bytes = self
            .backend
            .get_metadata(&pointer.release_manifest_key, MAX_RELEASE_METADATA_BYTES)
            .await?;
        let digest = hex::encode(Sha256::digest(&release_bytes));
        if digest != pointer.release_manifest_sha256 {
            return Err(ReleaseStoreError::DigestMismatch);
        }
        let release = parse_release_manifest(&release_bytes)?;
        let expected_key = format!("desktop/releases/{}/release.json", release.version);
        if pointer.release_manifest_key != expected_key {
            return Err(ReleaseStoreError::InvalidMetadata);
        }
        Ok(Some(ReleaseCatalog { pointer, release }))
    }

    pub async fn load_version(
        &self,
        version: &str,
    ) -> Result<Option<ReleaseManifest>, ReleaseStoreError> {
        if Version::parse(version).is_err() {
            return Ok(None);
        }
        let key = format!("desktop/releases/{version}/release.json");
        let bytes = match self
            .backend
            .get_metadata(&key, MAX_RELEASE_METADATA_BYTES)
            .await
        {
            Ok(bytes) => bytes,
            Err(ReleaseStoreError::NotFound) => return Ok(None),
            Err(error) => return Err(error),
        };
        let release = parse_release_manifest(&bytes)?;
        if release.version != version {
            return Err(ReleaseStoreError::InvalidMetadata);
        }
        Ok(Some(release))
    }

    pub async fn load_allowed_asset(
        &self,
        version: &str,
        file_name: &str,
    ) -> Result<Option<AllowedReleaseAsset>, ReleaseStoreError> {
        let Some(release) = self.load_version(version).await? else {
            return Ok(None);
        };
        let Some(asset) = release.allowed_asset(file_name).cloned() else {
            return Ok(None);
        };
        Ok(Some(AllowedReleaseAsset { release, asset }))
    }

    pub async fn open_asset(
        &self,
        asset: &ReleaseAsset,
    ) -> Result<ReleaseObjectStream, ReleaseStoreError> {
        self.verify_asset_size(asset).await?;
        let stream = self.backend.stream_object(&asset.object_key).await?;
        if stream.size_bytes != asset.size_bytes {
            return Err(ReleaseStoreError::LengthMismatch);
        }
        Ok(stream)
    }

    pub async fn verify_asset_size(&self, asset: &ReleaseAsset) -> Result<(), ReleaseStoreError> {
        let stored_size = self.backend.head_object(&asset.object_key).await?;
        if stored_size != asset.size_bytes {
            return Err(ReleaseStoreError::LengthMismatch);
        }
        Ok(())
    }
}

fn parse_release_manifest(bytes: &[u8]) -> Result<ReleaseManifest, ReleaseStoreError> {
    let release: ReleaseManifest =
        serde_json::from_slice(bytes).map_err(|_| ReleaseStoreError::InvalidMetadata)?;
    release
        .validate()
        .map_err(|_| ReleaseStoreError::InvalidMetadata)?;
    Ok(release)
}

pub(super) async fn collect_bounded_metadata<S>(
    stream: S,
    max_bytes: usize,
) -> Result<Bytes, ReleaseStoreError>
where
    S: Stream<Item = Result<Bytes, ReleaseStoreError>>,
{
    futures_util::pin_mut!(stream);
    let mut collected = BytesMut::with_capacity(max_bytes.min(64 * 1024));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if collected.len().saturating_add(chunk.len()) > max_bytes {
            return Err(ReleaseStoreError::MetadataTooLarge);
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected.freeze())
}

pub struct MinioReleaseStore {
    config: ReleaseStoreConfig,
    client: reqwest::Client,
}

impl fmt::Debug for MinioReleaseStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MinioReleaseStore")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl MinioReleaseStore {
    pub fn new(config: ReleaseStoreConfig) -> Result<Self, ReleaseStoreError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(5 * 60))
            .build()
            .map_err(|_| ReleaseStoreError::Unavailable)?;
        Ok(Self { config, client })
    }

    fn get_url(&self, key: &str) -> Result<Url, ReleaseStoreError> {
        let bucket = self.config.bucket()?;
        let credentials = self.config.credentials();
        Ok(GetObject::new(&bucket, Some(&credentials), key).sign(PRESIGNED_REQUEST_TTL))
    }

    fn head_url(&self, key: &str) -> Result<Url, ReleaseStoreError> {
        let bucket = self.config.bucket()?;
        let credentials = self.config.credentials();
        Ok(HeadObject::new(&bucket, Some(&credentials), key).sign(PRESIGNED_REQUEST_TTL))
    }
}

#[async_trait]
impl ReleaseStoreBackend for MinioReleaseStore {
    async fn get_metadata(&self, key: &str, max_bytes: usize) -> Result<Bytes, ReleaseStoreError> {
        let response = self
            .client
            .get(self.get_url(key)?)
            .send()
            .await
            .map_err(|_| ReleaseStoreError::Unavailable)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ReleaseStoreError::NotFound);
        }
        if !response.status().is_success() {
            return Err(ReleaseStoreError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(ReleaseStoreError::MetadataTooLarge);
        }
        collect_bounded_metadata(
            response
                .bytes_stream()
                .map(|chunk| chunk.map_err(|_| ReleaseStoreError::Unavailable)),
            max_bytes,
        )
        .await
    }

    async fn head_object(&self, key: &str) -> Result<u64, ReleaseStoreError> {
        let response = self
            .client
            .head(self.head_url(key)?)
            .send()
            .await
            .map_err(|_| ReleaseStoreError::Unavailable)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ReleaseStoreError::NotFound);
        }
        if !response.status().is_success() {
            return Err(ReleaseStoreError::Unavailable);
        }
        response
            .content_length()
            .ok_or(ReleaseStoreError::Unavailable)
    }

    async fn stream_object(&self, key: &str) -> Result<ReleaseObjectStream, ReleaseStoreError> {
        let response = self
            .client
            .get(self.get_url(key)?)
            .send()
            .await
            .map_err(|_| ReleaseStoreError::Unavailable)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ReleaseStoreError::NotFound);
        }
        if !response.status().is_success() {
            return Err(ReleaseStoreError::Unavailable);
        }
        let size_bytes = response
            .content_length()
            .ok_or(ReleaseStoreError::Unavailable)?;
        let body = response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|_| ReleaseStoreError::Unavailable));
        Ok(ReleaseObjectStream {
            size_bytes,
            body: Box::pin(body),
        })
    }
}
