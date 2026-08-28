use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use tauri::Manager;

use super::DesktopStoredChatAttachment;

mod cloud_cache;
pub(crate) mod cloud_upload;

use cloud_cache::download as download_cloud_attachment;
use cloud_cache::write as write_cloud_attachment_cache;
use cloud_cache::{cached as cached_cloud_attachment, copy as copy_cloud_attachment_cache};

pub(crate) const MAX_CHAT_ATTACHMENT_SIZE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct AttachmentStream {
    path: PathBuf,
    file: std::fs::File,
    size_bytes: u64,
}

fn attachment_streams() -> &'static Mutex<HashMap<String, AttachmentStream>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, AttachmentStream>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

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
    stored_chat_attachment_from_path(&path)
}

#[tauri::command]
pub async fn desktop_chat_store_attachment(name: String, data: Vec<u8>) -> Result<String, String> {
    store_chat_attachment_bytes(&name, &data).map(|attachment| attachment.path)
}

#[tauri::command]
pub fn desktop_chat_attachment_stream_start(name: String) -> Result<String, String> {
    let path = unique_attachment_path(&safe_attachment_name(&name))?;
    let file = std::fs::File::create(&path).map_err(|error| error.to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    attachment_streams()
        .lock()
        .map_err(|_| "Attachment stream state is unavailable.".to_string())?
        .insert(
            id.clone(),
            AttachmentStream {
                path,
                file,
                size_bytes: 0,
            },
        );
    Ok(id)
}

#[tauri::command]
pub fn desktop_chat_attachment_stream_append(
    stream_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut streams = attachment_streams()
        .lock()
        .map_err(|_| "Attachment stream state is unavailable.".to_string())?;
    let stream = streams
        .get_mut(&stream_id)
        .ok_or_else(|| "Attachment stream was not found.".to_string())?;
    let next_size = stream
        .size_bytes
        .checked_add(u64::try_from(data.len()).unwrap_or(u64::MAX))
        .ok_or_else(|| "Attachment is too large.".to_string())?;
    if next_size > MAX_CHAT_ATTACHMENT_SIZE_BYTES {
        return Err("Attachments must be 2 GiB or smaller.".to_string());
    }
    stream
        .file
        .write_all(&data)
        .map_err(|error| error.to_string())?;
    stream.size_bytes = next_size;
    Ok(())
}

#[tauri::command]
pub fn desktop_chat_attachment_stream_finish(
    stream_id: String,
) -> Result<DesktopStoredChatAttachment, String> {
    let mut stream = attachment_streams()
        .lock()
        .map_err(|_| "Attachment stream state is unavailable.".to_string())?
        .remove(&stream_id)
        .ok_or_else(|| "Attachment stream was not found.".to_string())?;
    stream.file.flush().map_err(|error| error.to_string())?;
    drop(stream.file);
    stored_chat_attachment_from_path(&stream.path)
}

#[tauri::command]
pub fn desktop_chat_attachment_stream_cancel(stream_id: String) -> Result<(), String> {
    let stream = attachment_streams()
        .lock()
        .map_err(|_| "Attachment stream state is unavailable.".to_string())?
        .remove(&stream_id);
    if let Some(stream) = stream {
        drop(stream.file);
        std::fs::remove_file(stream.path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_chat_discard_attachment(path: String) -> Result<(), String> {
    let attachment = ensure_attachment_file_path(Path::new(&path))?;
    let storage =
        std::fs::canonicalize(attachment_storage_dir()?).map_err(|error| error.to_string())?;
    if !attachment.starts_with(&storage) {
        return Err("Only Kordi temporary attachments can be discarded.".to_string());
    }
    std::fs::remove_file(attachment).map_err(|error| error.to_string())
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

#[tauri::command]
pub async fn desktop_chat_download_cloud_attachment(
    token: String,
    attachment_id: String,
    name: String,
) -> Result<String, String> {
    download_cloud_attachment(&token, &attachment_id, &name).await
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
    let mut attachment = stored_chat_attachment_from_path(Path::new(&path))?;
    if attachment
        .size_bytes
        .is_some_and(|size| size > MAX_CHAT_ATTACHMENT_SIZE_BYTES)
    {
        return Err("Attachments must be 2 GiB or smaller.".to_string());
    }
    attachment.name = safe_attachment_name(display_name);
    Ok(attachment)
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
            Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect())
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
    let source = ensure_attachment_file_path(Path::new(&path))?;
    std::fs::read(&source)
        .map_err(|err| format!("Unable to read attachment {}: {err}", source.display()))
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
        assert_eq!(
            stored_attachment_mime_type(Path::new("recording.mp4")).as_deref(),
            Some("video/mp4")
        );
    }

    #[test]
    fn streamed_attachments_write_incrementally_and_cancel_cleanly() {
        let stream_id = desktop_chat_attachment_stream_start("recording.mp4".to_string())
            .expect("start attachment stream");
        desktop_chat_attachment_stream_append(stream_id.clone(), b"first".to_vec())
            .expect("append first chunk");
        desktop_chat_attachment_stream_append(stream_id.clone(), b"second".to_vec())
            .expect("append second chunk");
        let stored = desktop_chat_attachment_stream_finish(stream_id).expect("finish stream");
        assert_eq!(std::fs::read(&stored.path).unwrap(), b"firstsecond");
        std::fs::remove_file(stored.path).ok();

        let cancelled = desktop_chat_attachment_stream_start("cancelled.mp4".to_string())
            .expect("start cancelled stream");
        let path = attachment_streams()
            .lock()
            .unwrap()
            .get(&cancelled)
            .unwrap()
            .path
            .clone();
        desktop_chat_attachment_stream_cancel(cancelled).expect("cancel stream");
        assert!(!path.exists());
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

    #[tokio::test]
    async fn read_attachment_reads_file_bytes_and_rejects_directories() {
        let dir =
            std::env::temp_dir().join(format!("kordi-attachment-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp attachment dir");
        let file = dir.join("report.txt");
        std::fs::write(&file, b"hello").expect("write temp attachment");

        let bytes = desktop_chat_read_attachment(file.display().to_string())
            .await
            .expect("read attachment bytes");
        assert_eq!(bytes, b"hello");

        let dir_error = desktop_chat_read_attachment(dir.display().to_string())
            .await
            .expect_err("directories are rejected");
        assert!(dir_error.contains("Attachment is not a file"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn selected_files_are_referenced_without_copying_and_reject_over_2_gib() {
        let dir = std::env::temp_dir().join(format!(
            "kordi-attachment-reference-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp attachment dir");
        let file = dir.join("archive.zip");
        std::fs::write(&file, b"small").expect("write temp attachment");

        let stored = desktop_chat_store_attachment_path(
            file.display().to_string(),
            Some("release.zip".to_string()),
        )
        .await
        .expect("reference selected attachment");
        assert_eq!(stored.path, file.display().to_string());
        assert_eq!(stored.name, "release.zip");

        let near_limit = dir.join("near-limit.bin");
        std::fs::File::create(&near_limit)
            .and_then(|file| file.set_len(MAX_CHAT_ATTACHMENT_SIZE_BYTES))
            .expect("create sparse near-limit attachment");
        let stored = desktop_chat_store_attachment_path(near_limit.display().to_string(), None)
            .await
            .expect("accept attachment at limit");
        assert_eq!(stored.path, near_limit.display().to_string());
        assert_eq!(stored.size_bytes, Some(MAX_CHAT_ATTACHMENT_SIZE_BYTES));

        let oversized = dir.join("oversized.bin");
        std::fs::File::create(&oversized)
            .and_then(|file| file.set_len(MAX_CHAT_ATTACHMENT_SIZE_BYTES + 1))
            .expect("create sparse oversized attachment");
        let error = desktop_chat_store_attachment_path(oversized.display().to_string(), None)
            .await
            .expect_err("oversized attachment is rejected");
        assert_eq!(error, "Attachments must be 2 GiB or smaller.");

        std::fs::remove_dir_all(dir).ok();
    }
}
