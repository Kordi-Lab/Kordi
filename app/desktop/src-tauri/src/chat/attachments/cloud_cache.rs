use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use super::access::authorize_attachment_file;
use super::quarantine::mark_quarantined_or_log;
use super::{attachment_storage_dir, safe_attachment_name};

const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn hex(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn valid_attachment_id(attachment_id: &str) -> Option<&str> {
    let attachment_id = attachment_id.trim();
    (!attachment_id.is_empty() && attachment_id.len() <= 256).then_some(attachment_id)
}

fn account_directory() -> Result<PathBuf, String> {
    let storage_root = std::env::var_os("KORDI_STORAGE_ROOT")
        .ok_or_else(|| "Cloud account storage is unavailable".to_string())?;
    let account_scope = Path::new(&storage_root)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Cloud account storage is unavailable".to_string())?;
    Ok(attachment_storage_dir()?
        .join("cloud")
        .join(hex(account_scope)))
}

fn path(attachment_id: &str, name: &str) -> Result<PathBuf, String> {
    let attachment_id =
        valid_attachment_id(attachment_id).ok_or("Cloud attachment id is invalid")?;
    let directory = account_directory()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!(
        "{}-{}",
        hex(attachment_id),
        safe_attachment_name(name)
    )))
}

/// Removes every cached copy of these attachments for the active account.
/// Files still being written (`.tmp`) are left to their writer.
pub(super) fn evict(attachment_ids: &[String]) -> Result<usize, String> {
    // Hex never contains '-', so "<hex id>-" cannot match a longer id.
    let prefixes = attachment_ids
        .iter()
        .filter_map(|id| valid_attachment_id(id))
        .map(|id| format!("{}-", hex(id)))
        .collect::<Vec<_>>();
    if prefixes.is_empty() {
        return Ok(0);
    }
    let entries = match std::fs::read_dir(account_directory()?) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.to_string()),
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let matches = path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)));
        let temporary = path.extension().is_some_and(|value| value == "tmp");
        if !matches || temporary || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn prune(directory: &Path, protected: &Path) -> Result<(), String> {
    prune_to_limit(directory, protected, MAX_CACHE_BYTES)
}

fn prune_to_limit(directory: &Path, protected: &Path, limit: u64) -> Result<(), String> {
    let mut files = std::fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            metadata.is_file().then_some((
                path,
                metadata.len(),
                metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            ))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, size, _)| size).sum::<u64>();
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= limit {
            break;
        }
        if path == protected || path.extension().is_some_and(|value| value == "tmp") {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    Ok(())
}

pub(super) fn cached(attachment_id: &str, name: &str) -> Result<Option<PathBuf>, String> {
    let path = path(attachment_id, name)?;
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Ok(Some(path)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn write(attachment_id: &str, name: &str, data: &[u8]) -> Result<String, String> {
    if let Some(path) = cached(attachment_id, name)? {
        return Ok(path.display().to_string());
    }
    let path = path(attachment_id, name)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, data).map_err(|error| error.to_string())?;
    mark_quarantined_or_log(&temporary);
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    prune(
        path.parent()
            .ok_or_else(|| "Cloud attachment cache is unavailable".to_string())?,
        &path,
    )?;
    Ok(path.display().to_string())
}

pub(super) fn copy(attachment_id: &str, name: &str, source: &Path) -> Result<String, String> {
    if let Some(path) = cached(attachment_id, name)? {
        return Ok(path.display().to_string());
    }
    let source = authorize_attachment_file(source)?;
    let path = path(attachment_id, name)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    mark_quarantined_or_log(&temporary);
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    prune(
        path.parent()
            .ok_or_else(|| "Cloud attachment cache is unavailable".to_string())?,
        &path,
    )?;
    Ok(path.display().to_string())
}

pub(super) async fn download(
    token: &str,
    attachment_id: &str,
    name: &str,
) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("Cloud session is unavailable".to_string());
    }
    if let Some(path) = cached(attachment_id, name)? {
        return Ok(path.display().to_string());
    }
    let mut url = reqwest::Url::parse(&crate::cloud_api_endpoint::cloud_api_base_url_from_env()?)
        .map_err(|_| "Cloud API base URL is invalid".to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Cloud API base URL is invalid".to_string())?
        .extend(["v1", "cloud", "attachments", attachment_id, "content"]);
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Unable to download attachment: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Unable to download attachment: server returned {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > super::MAX_CHAT_ATTACHMENT_SIZE_BYTES)
    {
        return Err("Attachment exceeds the 2 GiB limit".to_string());
    }

    let path = path(attachment_id, name)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        let mut file = tokio::fs::File::create(&temporary)
            .await
            .map_err(|error| error.to_string())?;
        let mut stream = response.bytes_stream();
        let mut written = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("Attachment download failed: {error}"))?;
            written = written.saturating_add(chunk.len() as u64);
            if written > super::MAX_CHAT_ATTACHMENT_SIZE_BYTES {
                return Err("Attachment exceeds the 2 GiB limit".to_string());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| error.to_string())?;
        }
        file.flush().await.map_err(|error| error.to_string())?;
        mark_quarantined_or_log(&temporary);
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            if path.is_file() {
                let _ = tokio::fs::remove_file(&temporary).await;
            } else {
                return Err(error.to_string());
            }
        }
        prune(
            path.parent()
                .ok_or_else(|| "Cloud attachment cache is unavailable".to_string())?,
            &path,
        )?;
        Ok(path.display().to_string())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_survives_a_new_lookup() {
        let _storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-cache");
        let attachment_id = format!("att_test_{}", uuid::Uuid::new_v4());
        let path = write(&attachment_id, "preview.png", b"image").expect("cache attachment");
        let cached = cached(&attachment_id, "preview.png")
            .expect("read cache")
            .expect("cached path");

        assert_eq!(cached.display().to_string(), path);
        assert_eq!(std::fs::read(&cached).unwrap(), b"image");
        std::fs::remove_file(cached).ok();
    }

    #[test]
    fn cache_is_scoped_by_active_account_storage() {
        let attachment_id = format!("att_test_{}", uuid::Uuid::new_v4());
        let first_path = {
            let _storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-account-a");
            write(&attachment_id, "preview.png", b"first").expect("cache first account attachment")
        };
        let second_path = {
            let _storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-account-b");
            write(&attachment_id, "preview.png", b"second")
                .expect("cache second account attachment")
        };

        assert_ne!(first_path, second_path);
        assert_eq!(std::fs::read(&first_path).unwrap(), b"first");
        assert_eq!(std::fs::read(&second_path).unwrap(), b"second");
        std::fs::remove_file(first_path).ok();
        std::fs::remove_file(second_path).ok();
    }

    #[test]
    fn eviction_removes_only_matching_ids_and_skips_partial_writes() {
        let _storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-eviction");
        let original = path("att_gone", "photo.jpg").unwrap();
        let preview = path("att_gone", "preview.png").unwrap();
        let longer_id = path("att_gone_too", "photo.jpg").unwrap();
        let kept = path("att_kept", "photo.jpg").unwrap();
        let partial = original.with_extension("0b1c.tmp");
        for file in [&original, &preview, &longer_id, &kept, &partial] {
            std::fs::write(file, b"bytes").unwrap();
        }

        let removed = evict(&["att_gone".to_string(), " ".to_string()]).unwrap();

        assert_eq!(removed, 2);
        assert!(!original.exists());
        assert!(!preview.exists());
        assert!(longer_id.exists());
        assert!(kept.exists());
        assert!(partial.exists());
        assert_eq!(evict(&["att_missing".to_string()]).unwrap(), 0);
        std::fs::remove_dir_all(kept.parent().unwrap()).ok();
    }

    #[test]
    fn eviction_acts_only_for_the_active_account_storage() {
        let _storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-eviction-gate");
        let cached = path("att_gate", "photo.jpg").unwrap();
        std::fs::write(&cached, b"bytes").unwrap();
        let ids = ["att_gate".to_string()];

        assert_eq!(
            super::super::evict_cloud_attachment_cache_for(None, "acct_a", &ids),
            0
        );
        assert_eq!(
            super::super::evict_cloud_attachment_cache_for(Some("acct_b"), "acct_a", &ids),
            0
        );
        assert!(cached.exists());
        assert_eq!(
            super::super::evict_cloud_attachment_cache_for(Some("acct_a"), " acct_a ", &ids),
            1
        );
        assert!(!cached.exists());
        std::fs::remove_dir_all(cached.parent().unwrap()).ok();
    }

    #[test]
    fn eviction_without_a_cache_directory_is_a_no_op() {
        let storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-eviction-empty");
        let previous_app_data = std::env::var_os("APP_DATA_DIR");
        std::env::set_var("APP_DATA_DIR", storage.root());
        let result = evict(&["att_any".to_string()]);
        match previous_app_data {
            Some(value) => std::env::set_var("APP_DATA_DIR", value),
            None => std::env::remove_var("APP_DATA_DIR"),
        }
        assert_eq!(result.unwrap(), 0);
    }

    #[test]
    fn pruning_keeps_the_new_file_and_enforces_the_cache_limit() {
        let _storage = crate::test_support::ScopedKordiStorageRoot::new("attachment-pruning");
        let first = path("att_first", "first.bin").unwrap();
        let second = path("att_second", "second.bin").unwrap();
        let protected = path("att_current", "current.bin").unwrap();
        std::fs::write(&first, b"old").unwrap();
        std::fs::write(&second, b"old").unwrap();
        std::fs::write(&protected, b"new").unwrap();

        prune_to_limit(protected.parent().unwrap(), &protected, 3).unwrap();

        assert!(protected.exists());
        assert!(!first.exists());
        assert!(!second.exists());
        std::fs::remove_file(protected).ok();
    }
}
