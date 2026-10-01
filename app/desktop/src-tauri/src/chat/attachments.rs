use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use tauri::Manager;

use super::DesktopStoredChatAttachment;

pub(crate) mod access;
mod cloud_cache;
pub(crate) mod cloud_upload;
pub(crate) mod live_photos;
pub(crate) mod open_local;
pub(crate) mod pasteboard;
pub(crate) mod quarantine;
pub(crate) mod save_as;
pub(crate) mod stream;

use cloud_cache::download as download_cloud_attachment;
use cloud_cache::evict as evict_cloud_attachments;
use cloud_cache::write as write_cloud_attachment_cache;
use cloud_cache::{cached as cached_cloud_attachment, copy as copy_cloud_attachment_cache};

pub(crate) const MAX_CHAT_ATTACHMENT_SIZE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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
        Some("heic") => Some("image/heic".to_string()),
        Some("heif") => Some("image/heif".to_string()),
        Some("mov") => Some("video/quicktime".to_string()),
        Some("mp4") => Some("video/mp4".to_string()),
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
    // These bytes often come from a conversation (received files, forwarded
    // media), so treat them like a download.
    quarantine::mark_quarantined_or_log(&path);
    stored_chat_attachment_from_path(&path)
}

#[tauri::command]
pub async fn desktop_chat_store_attachment(name: String, data: Vec<u8>) -> Result<String, String> {
    store_chat_attachment_bytes(&name, &data).map(|attachment| attachment.path)
}

#[tauri::command]
pub async fn desktop_chat_cache_cloud_attachment(
    attachment_id: String,
    name: String,
    data: Vec<u8>,
) -> Result<String, String> {
    write_cloud_attachment_cache(&attachment_id, &name, &data)
}

#[tauri::command]
pub async fn desktop_chat_cache_cloud_attachment_path(
    attachment_id: String,
    name: String,
    path: String,
) -> Result<String, String> {
    copy_cloud_attachment_cache(&attachment_id, &name, Path::new(&path))
}

#[tauri::command]
pub async fn desktop_chat_cached_cloud_attachment_path(
    attachment_id: String,
    name: String,
) -> Result<Option<String>, String> {
    cached_cloud_attachment(&attachment_id, &name)
        .map(|path| path.map(|value| value.display().to_string()))
}

/// Best effort: removes cached copies of cloud attachments after their message
/// is deleted or hidden. It acts only while `account_id` owns the active
/// account storage, because the cache directory belongs to that account.
pub(crate) fn evict_cloud_attachment_cache(account_id: &str, attachment_ids: &[String]) -> usize {
    let active_account_id = crate::cloud_account_paths::cloud_account_storage_current()
        .ok()
        .flatten()
        .map(|activation| activation.account_id);
    evict_cloud_attachment_cache_for(active_account_id.as_deref(), account_id, attachment_ids)
}

fn evict_cloud_attachment_cache_for(
    active_account_id: Option<&str>,
    account_id: &str,
    attachment_ids: &[String],
) -> usize {
    let account_id = account_id.trim();
    if attachment_ids.is_empty() || account_id.is_empty() || active_account_id != Some(account_id) {
        return 0;
    }
    match evict_cloud_attachments(attachment_ids) {
        Ok(removed) => removed,
        Err(error) => {
            eprintln!("[kordi] Unable to remove cached attachment copies: {error}");
            0
        }
    }
}

#[tauri::command]
pub async fn desktop_chat_download_cloud_attachment(
    token: String,
    attachment_id: String,
    name: String,
) -> Result<String, String> {
    download_cloud_attachment(&token, &attachment_id, &name).await
}

/// Resolves a path the desktop UI asked to attach. It must already be usable
/// under the attachment access policy, or be one of the file URLs on the
/// system pasteboard (a paste); `pasteboard_file_paths` is only read when
/// needed.
pub(crate) async fn authorize_requested_path<F, Fut>(
    path: &Path,
    pasteboard_file_paths: F,
) -> Result<PathBuf, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, String>>,
{
    match access::authorize_attachment_path(path) {
        Err(error) if error == access::ATTACHMENT_ACCESS_DENIED => {
            let pasted = pasteboard_file_paths().await?;
            access::authorize_pasted_attachment(path, &pasted)
        }
        result => result,
    }
}

pub(crate) async fn store_attachment_path<F, Fut>(
    path: String,
    name: Option<String>,
    pasteboard_file_paths: F,
) -> Result<DesktopStoredChatAttachment, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<PathBuf>, String>>,
{
    let fallback_name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment.bin")
        .to_string();
    let display_name = name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&fallback_name);
    let mut attachment = stored_chat_attachment_from_path(Path::new(&path))?;
    if attachment
        .size_bytes
        .is_some_and(|size| size > MAX_CHAT_ATTACHMENT_SIZE_BYTES)
    {
        return Err("Attachments must be 2 GiB or smaller.".to_string());
    }
    // Picked files are registered by the native picker and `@` references by
    // `desktop_chat_attach_reference_path`; a pasted path is accepted only
    // when native code finds it on the system pasteboard.
    authorize_requested_path(Path::new(&path), pasteboard_file_paths).await?;
    attachment.name = safe_attachment_name(display_name);
    Ok(attachment)
}

#[tauri::command]
pub async fn desktop_chat_store_attachment_path(
    app: tauri::AppHandle,
    path: String,
    name: Option<String>,
) -> Result<DesktopStoredChatAttachment, String> {
    store_attachment_path(path, name, || {
        pasteboard::general_pasteboard_file_paths(&app)
    })
    .await
}

/// Lets later attachment commands use a file the person picked from the `@`
/// file reference menu. Credential, keychain, browser profile, and shell
/// history locations are refused.
#[tauri::command]
pub async fn desktop_chat_attach_reference_path(path: String) -> Result<(), String> {
    access::register_referenced_attachment(Path::new(&path)).map(|_| ())
}

#[tauri::command]
pub async fn desktop_chat_pick_attachment_paths() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            let script = r#"
set selectedFiles to choose file with prompt "Choose attachments" with multiple selections allowed
set selectedPaths to ""
repeat with selectedFile in selectedFiles
    set selectedPaths to selectedPaths & POSIX path of selectedFile & linefeed
end repeat
return selectedPaths
"#;
            let output = Command::new("/usr/bin/osascript")
                .args(["-e", script])
                .output()
                .map_err(|error| format!("Unable to open attachment picker: {error}"))?;
            if !output.status.success() {
                let error = String::from_utf8_lossy(&output.stderr);
                if error.contains("(-128)") {
                    return Ok(Vec::new());
                }
                return Err(format!("Unable to choose attachments: {}", error.trim()));
            }
            let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect();
            access::register_native_selection(&paths)?;
            Ok(paths)
        })
        .await
        .map_err(|error| format!("Attachment picker stopped unexpectedly: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Native attachment picking is unavailable on this platform.".to_string())
    }
}

#[tauri::command]
pub async fn desktop_chat_read_attachment(path: String) -> Result<Vec<u8>, String> {
    let source = access::authorize_attachment_file(Path::new(&path))?;
    std::fs::read(&source)
        .map_err(|err| format!("Unable to read attachment {}: {err}", source.display()))
}

#[tauri::command]
pub async fn desktop_chat_download_attachment(
    path: String,
    name: Option<String>,
) -> Result<String, String> {
    let source = access::authorize_attachment_file(Path::new(&path))?;
    let fallback_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment.bin");
    let download_name = name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_name);
    let target = unique_download_path(download_name)?;
    save_as::copy_attachment_out(&source, &target)?;
    Ok(target.display().to_string())
}

#[cfg(test)]
mod tests;
