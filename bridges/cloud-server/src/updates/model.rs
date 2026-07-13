use std::collections::BTreeMap;

use base64::Engine;
use chrono::DateTime;
use semver::Version;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

const SCHEMA_VERSION: u32 = 1;
const ALLOWED_PLATFORMS: &[&str] = &["darwin-aarch64"];

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAsset {
    pub object_key: String,
    pub file_name: String,
    pub content_type: String,
    pub sha256: String,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub changelog_url: String,
    pub manual: ReleaseAsset,
    pub platforms: BTreeMap<String, ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPointer {
    pub schema_version: u32,
    pub channel: String,
    pub release_manifest_key: String,
    pub release_manifest_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnpublishedChannelPointer {
    pub schema_version: u32,
    pub channel: String,
    pub unpublished: bool,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum MetadataError {
    #[error("unsupported metadata schema version")]
    SchemaVersion,
    #[error("release version must be a semantic version")]
    Version,
    #[error("release publication date must be RFC 3339 UTC")]
    PublicationDate,
    #[error("release notes must not be empty")]
    Notes,
    #[error("changelog URL must use HTTPS")]
    ChangelogUrl,
    #[error("release asset size must be positive")]
    Size,
    #[error("release asset SHA-256 must be 64 lowercase hexadecimal characters")]
    Digest,
    #[error("release updater signature is invalid")]
    Signature,
    #[error("release asset filename is unsafe")]
    FileName,
    #[error("release object key is outside the versioned release prefix")]
    ObjectKey,
    #[error("release platform is unsupported")]
    Platform,
    #[error("release content type is invalid")]
    ContentType,
    #[error("release channel is invalid")]
    Channel,
    #[error("release manifest key is invalid")]
    ManifestKey,
    #[error("release unpublished marker is invalid")]
    Unpublished,
    #[error("current client version must be semantic")]
    CurrentVersion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateDecision<'a> {
    Update(&'a ReleaseAsset),
    NoUpdate,
    Unsupported,
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn contains_encoded_path_control(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("%2f") || lower.contains("%5c") || lower.contains("%2e")
}

fn valid_path_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 255
        && !contains_encoded_path_control(value)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn valid_updater_signature(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() < 100
        || trimmed.to_ascii_lowercase().contains("template")
        || trimmed.to_ascii_lowercase().contains("example")
        || trimmed.to_ascii_lowercase().contains("todo")
    {
        return false;
    }
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(trimmed) else {
        return false;
    };
    let decoded = String::from_utf8_lossy(&decoded);
    decoded.starts_with("untrusted comment:") && decoded.contains("signature")
}

impl ReleaseAsset {
    fn validate(&self, version: &str, requires_signature: bool) -> Result<(), MetadataError> {
        if !valid_path_component(&self.file_name) {
            return Err(MetadataError::FileName);
        }
        if self.size_bytes == 0 {
            return Err(MetadataError::Size);
        }
        if !valid_digest(&self.sha256) {
            return Err(MetadataError::Digest);
        }
        let prefix = format!("desktop/releases/{version}/");
        if !self.object_key.starts_with(&prefix)
            || contains_encoded_path_control(&self.object_key)
            || self.object_key.contains('\\')
            || self
                .object_key
                .split('/')
                .any(|part| part == "." || part == "..")
            || self.object_key.rsplit('/').next() != Some(self.file_name.as_str())
        {
            return Err(MetadataError::ObjectKey);
        }
        if self.object_key[prefix.len()..]
            .split('/')
            .any(|part| !valid_path_component(part))
        {
            return Err(MetadataError::ObjectKey);
        }
        if requires_signature {
            if self.content_type != "application/gzip" {
                return Err(MetadataError::ContentType);
            }
            if !self
                .signature
                .as_deref()
                .is_some_and(valid_updater_signature)
            {
                return Err(MetadataError::Signature);
            }
        } else {
            if self.content_type != "application/x-apple-diskimage" {
                return Err(MetadataError::ContentType);
            }
            if self.signature.is_some() {
                return Err(MetadataError::Signature);
            }
        }
        Ok(())
    }
}

impl ReleaseManifest {
    pub fn validate(&self) -> Result<(), MetadataError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(MetadataError::SchemaVersion);
        }
        Version::parse(&self.version).map_err(|_| MetadataError::Version)?;
        let publication_date = DateTime::parse_from_rfc3339(&self.pub_date)
            .map_err(|_| MetadataError::PublicationDate)?;
        if publication_date.offset().local_minus_utc() != 0 {
            return Err(MetadataError::PublicationDate);
        }
        if self.notes.trim().is_empty() || self.notes.len() > 16_384 {
            return Err(MetadataError::Notes);
        }
        let changelog = Url::parse(&self.changelog_url).map_err(|_| MetadataError::ChangelogUrl)?;
        if changelog.scheme() != "https" || changelog.host_str().is_none() {
            return Err(MetadataError::ChangelogUrl);
        }
        self.manual.validate(&self.version, false)?;
        if self.platforms.is_empty() {
            return Err(MetadataError::Platform);
        }
        for (platform, asset) in &self.platforms {
            if !ALLOWED_PLATFORMS.contains(&platform.as_str()) {
                return Err(MetadataError::Platform);
            }
            asset.validate(&self.version, true)?;
        }
        Ok(())
    }

    pub fn allowed_asset(&self, file_name: &str) -> Option<&ReleaseAsset> {
        if self.manual.file_name == file_name {
            return Some(&self.manual);
        }
        self.platforms
            .values()
            .find(|asset| asset.file_name == file_name)
    }
}

impl ChannelPointer {
    pub fn validate(&self) -> Result<(), MetadataError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(MetadataError::SchemaVersion);
        }
        if !matches!(self.channel.as_str(), "beta" | "acceptance") {
            return Err(MetadataError::Channel);
        }
        if !valid_digest(&self.release_manifest_sha256) {
            return Err(MetadataError::Digest);
        }
        if contains_encoded_path_control(&self.release_manifest_key)
            || self.release_manifest_key.contains('\\')
        {
            return Err(MetadataError::ManifestKey);
        }
        let parts = self.release_manifest_key.split('/').collect::<Vec<_>>();
        if parts.len() != 4
            || parts[0] != "desktop"
            || parts[1] != "releases"
            || Version::parse(parts[2]).is_err()
            || parts[3] != "release.json"
        {
            return Err(MetadataError::ManifestKey);
        }
        Ok(())
    }
}

impl UnpublishedChannelPointer {
    pub fn validate(&self) -> Result<(), MetadataError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(MetadataError::SchemaVersion);
        }
        if !matches!(self.channel.as_str(), "beta" | "acceptance") {
            return Err(MetadataError::Channel);
        }
        if !self.unpublished {
            return Err(MetadataError::Unpublished);
        }
        Ok(())
    }
}

pub fn select_update<'a>(
    release: &'a ReleaseManifest,
    target: &str,
    arch: &str,
    current_version: &str,
) -> Result<UpdateDecision<'a>, MetadataError> {
    release.validate()?;
    let release_version = Version::parse(&release.version).map_err(|_| MetadataError::Version)?;
    let current = Version::parse(current_version).map_err(|_| MetadataError::CurrentVersion)?;
    if release_version <= current {
        return Ok(UpdateDecision::NoUpdate);
    }
    let platform = format!("{target}-{arch}");
    match release.platforms.get(&platform) {
        Some(asset) => Ok(UpdateDecision::Update(asset)),
        None => Ok(UpdateDecision::Unsupported),
    }
}
