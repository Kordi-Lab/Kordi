use std::path::{Path, PathBuf};

use super::{attachment_storage_dir, ensure_attachment_file_path, safe_attachment_name};

fn path(attachment_id: &str, name: &str) -> Result<PathBuf, String> {
    let attachment_id = attachment_id.trim();
    if attachment_id.is_empty() || attachment_id.len() > 256 {
        return Err("Cloud attachment id is invalid".to_string());
    }
    let encoded_id = attachment_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let storage_root = std::env::var_os("KORDI_STORAGE_ROOT")
        .ok_or_else(|| "Cloud account storage is unavailable".to_string())?;
    let account_scope = Path::new(&storage_root)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Cloud account storage is unavailable".to_string())?
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let directory = attachment_storage_dir()?.join("cloud").join(account_scope);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{encoded_id}-{}", safe_attachment_name(name))))
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
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

pub(super) fn copy(attachment_id: &str, name: &str, source: &Path) -> Result<String, String> {
    if let Some(path) = cached(attachment_id, name)? {
        return Ok(path.display().to_string());
    }
    let source = ensure_attachment_file_path(source)?;
    let path = path(attachment_id, name)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::copy(source, &temporary).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
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
}
