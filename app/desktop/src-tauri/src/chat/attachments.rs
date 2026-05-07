use std::path::{Path, PathBuf};

use tauri::Manager;

use super::DesktopStoredChatAttachment;

fn attachment_storage_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("tmp").join("attachments"))
        .unwrap_or_else(|| std::env::temp_dir().join("kordi-desktop-attachments"));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

pub(crate) fn allow_attachment_asset_scope<R: tauri::Runtime>(
    app: &tauri::App<R>,
) -> Result<(), String> {
    let dir = attachment_storage_dir()?;
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|err| err.to_string())
}

fn attachment_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn stored_attachment_kind(path: &Path) -> String {
    if path.is_dir() {
        return "folder".to_string();
    }

    match attachment_extension(path).as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg") => "image".to_string(),
        _ => "file".to_string(),
    }
}

fn stored_attachment_mime_type(path: &Path) -> Option<String> {
    if path.is_dir() {
        return None;
    }

    match attachment_extension(path).as_deref() {
        Some("png") => Some("image/png".to_string()),
        Some("jpg" | "jpeg") => Some("image/jpeg".to_string()),
        Some("gif") => Some("image/gif".to_string()),
        Some("webp") => Some("image/webp".to_string()),
        Some("bmp") => Some("image/bmp".to_string()),
        Some("svg") => Some("image/svg+xml".to_string()),
        Some("txt") => Some("text/plain".to_string()),
        Some("json") => Some("application/json".to_string()),
        Some("pdf") => Some("application/pdf".to_string()),
        _ => None,
    }
}

fn stored_attachment_format_label(path: &Path) -> Option<String> {
    if path.is_dir() {
        return Some("Folder".to_string());
    }

    attachment_extension(path).map(|extension| extension.to_ascii_uppercase())
}

fn safe_attachment_name(name: &str) -> String {
    std::path::Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment.bin")
        .to_string()
}

fn downloads_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Downloads"))
        .unwrap_or_else(|| std::env::temp_dir().join("kordi-downloads"));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn unique_download_path(name: &str) -> Result<PathBuf, String> {
    let safe_name = safe_attachment_name(name);
    let downloads = downloads_dir()?;
    let candidate = downloads.join(&safe_name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let stem = Path::new(&safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment");
    let extension = Path::new(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..1000 {
        let candidate = downloads.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Unable to choose a unique download filename".to_string())
}

fn ensure_attachment_file_path(path: &Path) -> Result<PathBuf, String> {
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|err| format!("Unable to read attachment file {}: {err}", path.display()))?;
    let metadata = std::fs::metadata(&canonical_path).map_err(|err| {
        format!(
            "Unable to read attachment metadata {}: {err}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("Attachment is not a file: {}", path.display()));
    }
    Ok(canonical_path)
}

fn unique_attachment_path(name: &str) -> Result<PathBuf, String> {
    let safe_name = safe_attachment_name(name);
    let stem = Path::new(&safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment");
    let extension = Path::new(&safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    Ok(attachment_storage_dir()?.join(format!("{}-{}{}", stem, uuid::Uuid::new_v4(), extension)))
}

pub(crate) fn stored_chat_attachment_from_path(
    path: &Path,
) -> Result<DesktopStoredChatAttachment, String> {
    let metadata = std::fs::metadata(path).map_err(|err| {
        format!(
            "Unable to read attachment metadata for {}: {err}",
            path.display()
        )
    })?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(format!(
            "Attachment is not a file or folder: {}",
            path.display()
        ));
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment")
        .to_string();
    Ok(DesktopStoredChatAttachment {
        path: path.display().to_string(),
        name,
        kind: stored_attachment_kind(path),
        mime_type: stored_attachment_mime_type(path),
        format_label: stored_attachment_format_label(path),
        size_bytes: metadata.is_file().then_some(metadata.len()),
    })
}

pub(crate) fn store_chat_attachment_bytes(
    name: &str,
    data: &[u8],
) -> Result<DesktopStoredChatAttachment, String> {
    let path = unique_attachment_path(name)?;
    std::fs::write(&path, data).map_err(|err| err.to_string())?;
    stored_chat_attachment_from_path(&path)
}

pub(crate) fn store_chat_attachment_file(
    source: &Path,
    name: &str,
) -> Result<DesktopStoredChatAttachment, String> {
    let canonical_source = std::fs::canonicalize(source)
        .map_err(|err| format!("Unable to read attachment file {}: {err}", source.display()))?;
    let metadata = std::fs::metadata(&canonical_source).map_err(|err| {
        format!(
            "Unable to read attachment metadata {}: {err}",
            source.display()
        )
    })?;
    let display_name = safe_attachment_name(name);

    if metadata.is_dir() {
        let mut stored = stored_chat_attachment_from_path(source)?;
        stored.name = display_name;
        return Ok(stored);
    }

    if !metadata.is_file() {
        return Err(format!(
            "Attachment is not a file or folder: {}",
            source.display()
        ));
    }

    let target = unique_attachment_path(&display_name)?;
    std::fs::copy(&canonical_source, &target).map_err(|err| err.to_string())?;
    let mut stored = stored_chat_attachment_from_path(&target)?;
    stored.name = display_name;
    Ok(stored)
}

#[tauri::command]
pub async fn desktop_chat_store_attachment(name: String, data: Vec<u8>) -> Result<String, String> {
    store_chat_attachment_bytes(&name, &data).map(|attachment| attachment.path)
}

#[tauri::command]
pub async fn desktop_chat_store_attachment_path(
    path: String,
    name: Option<String>,
) -> Result<DesktopStoredChatAttachment, String> {
    let fallback_name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment.bin")
        .to_string();
    let display_name = name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&fallback_name);
    store_chat_attachment_file(Path::new(&path), display_name)
}

#[tauri::command]
pub async fn desktop_chat_download_attachment(
    path: String,
    name: Option<String>,
) -> Result<String, String> {
    let source = ensure_attachment_file_path(Path::new(&path))?;
    let fallback_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment.bin");
    let download_name = name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name);
    let target = unique_download_path(download_name)?;
    std::fs::copy(&source, &target).map_err(|err| err.to_string())?;
    Ok(target.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_attachment_name_strips_path_segments() {
        assert_eq!(safe_attachment_name("/tmp/report.pdf"), "report.pdf");
        assert_eq!(safe_attachment_name("   "), "attachment.bin");
    }

    #[test]
    fn stored_attachment_metadata_is_derived_from_extension() {
        let path = Path::new("screen.PNG");
        assert_eq!(stored_attachment_kind(path), "image");
        assert_eq!(
            stored_attachment_mime_type(path).as_deref(),
            Some("image/png")
        );
        assert_eq!(stored_attachment_format_label(path).as_deref(), Some("PNG"));
    }

    #[test]
    fn stored_attachment_from_directory_preserves_folder_path() {
        let dir =
            std::env::temp_dir().join(format!("kordi-attachment-folder-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp attachment folder");

        let attachment = stored_chat_attachment_from_path(&dir).expect("directory attaches");

        assert_eq!(attachment.path, dir.display().to_string());
        assert_eq!(attachment.kind, "folder");
        assert_eq!(attachment.format_label.as_deref(), Some("Folder"));
        assert_eq!(attachment.size_bytes, None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn store_attachment_file_preserves_directory_source_path() {
        let dir =
            std::env::temp_dir().join(format!("kordi-attachment-folder-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp attachment folder");

        let attachment =
            store_chat_attachment_file(&dir, "Project Folder").expect("directory attaches");

        assert_eq!(attachment.path, dir.display().to_string());
        assert_eq!(attachment.name, "Project Folder");
        assert_eq!(attachment.kind, "folder");
        assert_eq!(attachment.format_label.as_deref(), Some("Folder"));
        assert_eq!(attachment.size_bytes, None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
