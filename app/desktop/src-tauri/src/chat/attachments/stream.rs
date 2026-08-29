use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::{
    attachment_storage_dir, ensure_attachment_file_path, safe_attachment_name,
    stored_chat_attachment_from_path, unique_attachment_path, MAX_CHAT_ATTACHMENT_SIZE_BYTES,
};
use crate::chat::DesktopStoredChatAttachment;

struct AttachmentStream {
    path: PathBuf,
    file: std::fs::File,
    size_bytes: u64,
}

fn attachment_streams() -> &'static Mutex<HashMap<String, AttachmentStream>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, AttachmentStream>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
