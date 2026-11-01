use super::{ReleaseAsset, ReleaseCatalogStore, ReleaseStoreError, MAX_RELEASE_METADATA_BYTES};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceManifest {
    schema_version: u32,
    version: String,
    release_commit: String,
    catalog_sha256: String,
    pub_date: String,
    files: Vec<SourcePart>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourcePart {
    file_name: String,
    sha256: String,
    size_bytes: u64,
}
fn safe_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.contains("..")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl ReleaseCatalogStore {
    pub async fn load_source_asset(
        &self,
        version: &str,
        name: &str,
    ) -> Result<Option<(ReleaseAsset, String)>, ReleaseStoreError> {
        if semver::Version::parse(version).is_err() || !safe_name(name) {
            return Ok(None);
        }
        let prefix = format!("desktop/releases/{version}/sources/");
        let bytes = match self
            .backend
            .get_metadata(
                &format!("{prefix}manifest.json"),
                MAX_RELEASE_METADATA_BYTES,
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(ReleaseStoreError::NotFound) => return Ok(None),
            Err(error) => return Err(error),
        };
        let manifest: SourceManifest =
            serde_json::from_slice(&bytes).map_err(|_| ReleaseStoreError::InvalidMetadata)?;
        if manifest.schema_version != 1
            || manifest.version != version
            || !hex(&manifest.release_commit, 40)
            || !hex(&manifest.catalog_sha256, 64)
            || chrono::DateTime::parse_from_rfc3339(&manifest.pub_date).is_err()
            || manifest.files.is_empty()
            || manifest.files.len() > 256
        {
            return Err(ReleaseStoreError::InvalidMetadata);
        }
        let mut names = HashSet::new();
        for file in &manifest.files {
            if !safe_name(&file.file_name)
                || file.file_name == "manifest.json"
                || !names.insert(&file.file_name)
                || !hex(&file.sha256, 64)
                || file.size_bytes == 0
                || file.size_bytes > 64 * 1024 * 1024
            {
                return Err(ReleaseStoreError::InvalidMetadata);
            }
        }
        let (sha256, size_bytes, content_type) = if name == "manifest.json" {
            (
                hex::encode(Sha256::digest(&bytes)),
                bytes.len() as u64,
                "application/json",
            )
        } else if let Some(part) = manifest.files.iter().find(|file| file.file_name == name) {
            (
                part.sha256.clone(),
                part.size_bytes,
                "application/octet-stream",
            )
        } else {
            return Ok(None);
        };
        Ok(Some((
            ReleaseAsset {
                object_key: format!("{prefix}{name}"),
                file_name: name.to_owned(),
                content_type: content_type.to_owned(),
                sha256,
                size_bytes,
                signature: None,
                minimum_system_version: None,
            },
            manifest.pub_date,
        )))
    }
}
