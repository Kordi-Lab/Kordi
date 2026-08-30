use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(super) const MAX_REMOTE_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const REMOTE_IMAGE_CACHE_VERSION: u8 = 1;
const REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES: usize = 4 * 1024;

pub(super) struct RemoteImageCachePolicy {
    pub directory: &'static str,
    magic: &'static [u8],
    extension: &'static str,
    max_entries: usize,
    max_bytes: u64,
    ttl: Option<Duration>,
    pub required_media_type: Option<&'static str>,
    account_scoped: bool,
    pub allow_debug_loopback: bool,
}

pub(super) const AVATAR_CACHE_POLICY: RemoteImageCachePolicy = RemoteImageCachePolicy {
    directory: "remote-avatars-v1",
    magic: b"KORDI_REMOTE_AVATAR_V1\n",
    extension: "avatar",
    max_entries: 128,
    max_bytes: 32 * 1024 * 1024,
    ttl: Some(Duration::from_secs(30 * 24 * 60 * 60)),
    required_media_type: None,
    account_scoped: true,
    allow_debug_loopback: false,
};

pub(super) const BLOB_EMOJI_CACHE_POLICY: RemoteImageCachePolicy = RemoteImageCachePolicy {
    directory: "blob-emoji-v1",
    magic: b"KORDI_BLOB_EMOJI_V1\n",
    extension: "webp",
    max_entries: 1024,
    max_bytes: 64 * 1024 * 1024,
    ttl: None,
    required_media_type: Some("image/webp"),
    account_scoped: false,
    allow_debug_loopback: true,
};
const _: () = assert!(BLOB_EMOJI_CACHE_POLICY.max_entries >= 547);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct RemoteImageCacheHeader {
    version: u8,
    url_sha256: String,
    media_type: String,
    content_sha256: String,
    byte_len: usize,
    cached_at_unix_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RemoteImagePayload {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

pub(super) fn supported_image_media_type(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        "image/avif" => Some("image/avif"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        _ => None,
    }
}

pub(super) fn remote_image_data_url(media_type: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Avatar image response was empty.".to_string());
    }
    if bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return Err("Avatar image is larger than 2 MB.".to_string());
    }
    Ok(format!(
        "data:{media_type};base64,{}",
        STANDARD.encode(bytes)
    ))
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn remote_image_url_cache_key(url: &str) -> String {
    sha256_hex(url.as_bytes())
}

fn remote_image_cache_dir(
    storage_root: impl AsRef<Path>,
    policy: &RemoteImageCachePolicy,
) -> PathBuf {
    storage_root.as_ref().join("cache").join(policy.directory)
}

pub(super) fn active_remote_image_cache_dir(policy: &RemoteImageCachePolicy) -> Option<PathBuf> {
    if !policy.account_scoped {
        return std::env::var_os("APP_DATA_DIR")
            .map(|root| remote_image_cache_dir(PathBuf::from(root), policy));
    }
    crate::cloud_account_paths::cloud_account_storage_current()
        .ok()
        .flatten()
        .map(|activation| remote_image_cache_dir(&activation.storage_root, policy))
}

fn remote_image_cache_entry_path(
    cache_dir: &Path,
    url: &str,
    policy: &RemoteImageCachePolicy,
) -> PathBuf {
    cache_dir.join(format!(
        "{}.{}",
        remote_image_url_cache_key(url),
        policy.extension
    ))
}

pub(super) fn unix_timestamp_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn encode_remote_image_cache_entry(
    url: &str,
    media_type: &str,
    bytes: &[u8],
    cached_at_unix_seconds: u64,
    policy: &RemoteImageCachePolicy,
) -> Result<Vec<u8>, String> {
    let media_type = supported_image_media_type(media_type)
        .ok_or_else(|| "Avatar cache media type is not supported.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_REMOTE_IMAGE_BYTES {
        return Err("Avatar cache body is outside the allowed size.".to_string());
    }
    let header = RemoteImageCacheHeader {
        version: REMOTE_IMAGE_CACHE_VERSION,
        url_sha256: remote_image_url_cache_key(url),
        media_type: media_type.to_string(),
        content_sha256: sha256_hex(bytes),
        byte_len: bytes.len(),
        cached_at_unix_seconds,
    };
    let encoded_header = serde_json::to_vec(&header)
        .map_err(|error| format!("Unable to encode avatar cache metadata: {error}"))?;
    if encoded_header.len() > REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES {
        return Err("Avatar cache metadata is too large.".to_string());
    }
    let mut encoded =
        Vec::with_capacity(policy.magic.len() + encoded_header.len() + 1 + bytes.len());
    encoded.extend_from_slice(policy.magic);
    encoded.extend_from_slice(&encoded_header);
    encoded.push(b'\n');
    encoded.extend_from_slice(bytes);
    Ok(encoded)
}

fn decode_remote_image_cache_entry(
    url: &str,
    encoded: &[u8],
    now_unix_seconds: u64,
    expected_sha256: Option<&str>,
    policy: &RemoteImageCachePolicy,
) -> Result<RemoteImagePayload, String> {
    if encoded.len()
        > policy.magic.len() + REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES + 1 + MAX_REMOTE_IMAGE_BYTES
    {
        return Err("Avatar cache entry is too large.".to_string());
    }
    let remainder = encoded
        .strip_prefix(policy.magic)
        .ok_or_else(|| "Avatar cache entry has an invalid format.".to_string())?;
    let header_end = remainder
        .iter()
        .take(REMOTE_IMAGE_CACHE_MAX_HEADER_BYTES + 1)
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "Avatar cache metadata is incomplete.".to_string())?;
    let header: RemoteImageCacheHeader = serde_json::from_slice(&remainder[..header_end])
        .map_err(|_| "Avatar cache metadata is invalid.".to_string())?;
    let bytes = &remainder[header_end + 1..];

    if header.version != REMOTE_IMAGE_CACHE_VERSION
        || header.url_sha256 != remote_image_url_cache_key(url)
        || header.byte_len != bytes.len()
        || bytes.is_empty()
        || bytes.len() > MAX_REMOTE_IMAGE_BYTES
        || supported_image_media_type(&header.media_type).is_none()
        || policy
            .required_media_type
            .is_some_and(|required| required != header.media_type)
        || header.content_sha256 != sha256_hex(bytes)
        || expected_sha256.is_some_and(|expected| expected != header.content_sha256)
    {
        return Err("Avatar cache entry failed validation.".to_string());
    }
    if header.cached_at_unix_seconds > now_unix_seconds.saturating_add(5 * 60) {
        return Err("Avatar cache entry has expired.".to_string());
    }
    if policy.ttl.is_some_and(|ttl| {
        now_unix_seconds.saturating_sub(header.cached_at_unix_seconds) > ttl.as_secs()
    }) {
        return Err("Avatar cache entry has expired.".to_string());
    }

    Ok(RemoteImagePayload {
        media_type: header.media_type,
        bytes: bytes.to_vec(),
    })
}

pub(super) fn read_cached_remote_image(
    cache_dir: &Path,
    url: &str,
    now_unix_seconds: u64,
    expected_sha256: Option<&str>,
    policy: &RemoteImageCachePolicy,
) -> Option<RemoteImagePayload> {
    let path = remote_image_cache_entry_path(cache_dir, url, policy);
    let encoded = match std::fs::read(&path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return None,
    };
    match decode_remote_image_cache_entry(url, &encoded, now_unix_seconds, expected_sha256, policy)
    {
        Ok(payload) => {
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| {
                    file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::now()))
                });
            Some(payload)
        }
        Err(_) => {
            let _ = std::fs::remove_file(path);
            None
        }
    }
}

fn prune_remote_image_cache(
    cache_dir: &Path,
    max_entries: usize,
    max_bytes: u64,
    policy: &RemoteImageCachePolicy,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(cache_dir)
        .map_err(|error| format!("Unable to inspect avatar cache: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("tmp") {
                let _ = std::fs::remove_file(path);
                return None;
            }
            if path.extension().and_then(|value| value.to_str()) != Some(policy.extension) {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
            Some((path, metadata.len(), modified))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(_, _, modified)| *modified);
    let mut total_bytes = entries.iter().map(|(_, length, _)| *length).sum::<u64>();
    let mut entry_count = entries.len();
    for (path, length, _) in entries {
        if entry_count <= max_entries && total_bytes <= max_bytes {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            entry_count = entry_count.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(length);
        }
    }
    Ok(())
}

pub(super) fn write_cached_remote_image(
    cache_dir: &Path,
    url: &str,
    media_type: &str,
    bytes: &[u8],
    now_unix_seconds: u64,
    policy: &RemoteImageCachePolicy,
) -> Result<(), String> {
    std::fs::create_dir_all(cache_dir)
        .map_err(|error| format!("Unable to create avatar cache: {error}"))?;
    let encoded =
        encode_remote_image_cache_entry(url, media_type, bytes, now_unix_seconds, policy)?;
    let destination = remote_image_cache_entry_path(cache_dir, url, policy);
    let temporary = cache_dir.join(format!(
        ".{}.{}.tmp",
        remote_image_url_cache_key(url),
        uuid::Uuid::new_v4()
    ));
    if let Err(error) = std::fs::write(&temporary, encoded) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Unable to write avatar cache: {error}"));
    }
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("Unable to commit avatar cache: {error}"));
    }
    prune_remote_image_cache(cache_dir, policy.max_entries, policy.max_bytes, policy)
}

#[cfg(test)]
mod tests;
