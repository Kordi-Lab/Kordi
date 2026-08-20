use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use futures_util::stream::{FuturesUnordered, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::{attachment_storage_dir, ensure_attachment_file_path, MAX_CHAT_ATTACHMENT_SIZE_BYTES};

mod http;

use http::{
    cancel_server_upload, complete_upload, initiate_upload, load_server_status, upload_part,
};

const UPLOAD_PROGRESS_EVENT: &str = "cloud-attachment-upload-progress";
const MAX_PARALLEL_PARTS: usize = 4;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgressEvent {
    request_id: String,
    phase: String,
    uploaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudAttachmentUploadResult {
    pub attachment_id: String,
    pub object_key: String,
    pub size_bytes: Option<i64>,
    pub content_type: Option<String>,
    pub sha256_hex: Option<String>,
    pub finalized_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResumeRecord {
    attachment_id: String,
    size_bytes: u64,
    modified_at_ms: u64,
}

fn active_uploads() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static UPLOADS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    UPLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn resume_record_path(path: &Path) -> Result<PathBuf, String> {
    let path_hash = hex::encode(Sha256::digest(path.as_os_str().as_encoded_bytes()));
    Ok(attachment_storage_dir()?.join(format!("upload-{path_hash}.json")))
}

fn modified_at_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .unwrap_or_default()
}

fn upload_part_count(size_bytes: u64, chunk_size: u64) -> u64 {
    size_bytes.max(1).div_ceil(chunk_size)
}

fn upload_part_size(size_bytes: u64, chunk_size: u64, part_index: u64) -> u64 {
    if size_bytes == 0 {
        0
    } else {
        size_bytes
            .saturating_sub(part_index.saturating_mul(chunk_size))
            .min(chunk_size)
    }
}

async fn load_resume_record(
    path: &Path,
    size_bytes: u64,
    modified_at_ms: u64,
) -> Option<UploadResumeRecord> {
    let bytes = tokio::fs::read(resume_record_path(path).ok()?).await.ok()?;
    let record: UploadResumeRecord = serde_json::from_slice(&bytes).ok()?;
    (record.size_bytes == size_bytes && record.modified_at_ms == modified_at_ms).then_some(record)
}

async fn save_resume_record(path: &Path, record: &UploadResumeRecord) -> Result<(), String> {
    let bytes = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    tokio::fs::write(resume_record_path(path)?, bytes)
        .await
        .map_err(|error| format!("Unable to save attachment upload state: {error}"))
}

async fn remove_resume_record(path: &Path) {
    if let Ok(record_path) = resume_record_path(path) {
        let _ = tokio::fs::remove_file(record_path).await;
    }
}

fn emit_progress(
    app: &AppHandle,
    request_id: &str,
    phase: &str,
    uploaded_bytes: u64,
    total_bytes: u64,
) {
    let _ = app.emit(
        UPLOAD_PROGRESS_EVENT,
        UploadProgressEvent {
            request_id: request_id.to_string(),
            phase: phase.to_string(),
            uploaded_bytes,
            total_bytes,
        },
    );
}

async fn run_upload(
    app: &AppHandle,
    request_id: &str,
    source: &Path,
    content_type: Option<&str>,
    base_url: &str,
    token: &str,
    cancel: &CancellationToken,
) -> Result<DesktopCloudAttachmentUploadResult, String> {
    let metadata = std::fs::metadata(source)
        .map_err(|error| format!("Unable to read attachment metadata: {error}"))?;
    let size_bytes = metadata.len();
    let file_modified_at_ms = modified_at_ms(&metadata);
    emit_progress(app, request_id, "preparing", 0, size_bytes);
    let resume = load_resume_record(source, size_bytes, file_modified_at_ms).await;
    let mut status = if let Some(record) = resume.as_ref() {
        load_server_status(base_url, token, &record.attachment_id, cancel).await?
    } else {
        None
    };
    if status
        .as_ref()
        .is_some_and(|value| value.status == "completed")
    {
        if let Some(completed) = status.take().and_then(|value| value.completed_result()) {
            remove_resume_record(source).await;
            emit_progress(app, request_id, "complete", size_bytes, size_bytes);
            return Ok(completed);
        }
    }
    let (attachment_id, chunk_size, uploaded_parts, uploaded_bytes) = if let Some(status) = status {
        if status.status != "uploading" || status.total_size_bytes != size_bytes {
            return Err("Saved attachment upload state is no longer valid.".to_string());
        }
        (
            status.attachment_id,
            status.chunk_size_bytes,
            status.uploaded_parts,
            status.uploaded_bytes,
        )
    } else {
        let initiated = initiate_upload(base_url, token, size_bytes, content_type, cancel).await?;
        if let Err(error) = save_resume_record(
            source,
            &UploadResumeRecord {
                attachment_id: initiated.attachment_id.clone(),
                size_bytes,
                modified_at_ms: file_modified_at_ms,
            },
        )
        .await
        {
            cancel_server_upload(base_url, token, &initiated.attachment_id).await;
            return Err(error);
        }
        (
            initiated.attachment_id,
            initiated.chunk_size_bytes,
            Vec::new(),
            0,
        )
    };
    if chunk_size == 0 || chunk_size > 64 * 1024 * 1024 {
        return Err("Server returned an invalid attachment chunk size.".to_string());
    }

    let uploaded_part_numbers = uploaded_parts
        .iter()
        .map(|part| part.part_number)
        .collect::<HashSet<_>>();
    let known_uploaded_bytes = uploaded_parts
        .iter()
        .map(|part| part.size_bytes)
        .sum::<u64>();
    if known_uploaded_bytes != uploaded_bytes || known_uploaded_bytes > size_bytes {
        return Err("Server returned inconsistent attachment progress.".to_string());
    }
    let mut confirmed_bytes = known_uploaded_bytes;
    emit_progress(app, request_id, "uploading", confirmed_bytes, size_bytes);

    let part_count = upload_part_count(size_bytes, chunk_size);
    let mut file = tokio::fs::File::open(source)
        .await
        .map_err(|error| format!("Unable to open attachment: {error}"))?;
    let mut hasher = Sha256::new();
    let mut pending = FuturesUnordered::new();
    for part_index in 0..part_count {
        let expected_size = upload_part_size(size_bytes, chunk_size, part_index);
        let mut bytes =
            vec![0; usize::try_from(expected_size).map_err(|_| "Attachment part is too large.")?];
        file.read_exact(&mut bytes)
            .await
            .map_err(|error| format!("Unable to read attachment: {error}"))?;
        hasher.update(&bytes);
        let part_number = u32::try_from(part_index + 1)
            .map_err(|_| "Attachment has too many parts.".to_string())?;
        if uploaded_part_numbers.contains(&part_number) {
            continue;
        }
        pending.push(upload_part(
            base_url.to_string(),
            token.to_string(),
            attachment_id.clone(),
            part_number,
            bytes.into(),
            cancel.clone(),
        ));
        if pending.len() >= MAX_PARALLEL_PARTS {
            let uploaded = pending
                .next()
                .await
                .ok_or_else(|| "Attachment upload stopped unexpectedly.".to_string())??;
            confirmed_bytes = confirmed_bytes.saturating_add(uploaded.size_bytes);
            emit_progress(app, request_id, "uploading", confirmed_bytes, size_bytes);
        }
    }
    while let Some(uploaded) = pending.next().await {
        confirmed_bytes = confirmed_bytes.saturating_add(uploaded?.size_bytes);
        emit_progress(app, request_id, "uploading", confirmed_bytes, size_bytes);
    }
    if confirmed_bytes != size_bytes {
        return Err("Attachment upload did not confirm every byte.".to_string());
    }

    emit_progress(app, request_id, "finishing", size_bytes, size_bytes);
    let result = complete_upload(
        base_url,
        token,
        &attachment_id,
        &hex::encode(hasher.finalize()),
        cancel,
    )
    .await?;
    remove_resume_record(source).await;
    emit_progress(app, request_id, "complete", size_bytes, size_bytes);
    Ok(result)
}

#[tauri::command]
pub async fn desktop_cloud_attachment_upload(
    app: AppHandle,
    request_id: String,
    path: String,
    content_type: Option<String>,
) -> Result<DesktopCloudAttachmentUploadResult, String> {
    let request_id = request_id.trim().to_string();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Attachment upload request is invalid.".to_string());
    }
    let source = ensure_attachment_file_path(Path::new(&path))?;
    let metadata = std::fs::metadata(&source)
        .map_err(|error| format!("Unable to read attachment metadata: {error}"))?;
    let size_bytes = metadata.len();
    if size_bytes > MAX_CHAT_ATTACHMENT_SIZE_BYTES {
        return Err("Attachments must be 2 GiB or smaller.".to_string());
    }
    let session = crate::cloud_session::cloud_session_load()?
        .filter(|session| !session.token.trim().is_empty())
        .ok_or_else(|| "Not signed in.".to_string())?;
    let base_url = crate::cloud_api_base_url_from_env()?;
    let cancel = CancellationToken::new();
    {
        let mut uploads = active_uploads()
            .lock()
            .map_err(|_| "Attachment upload state is unavailable.".to_string())?;
        if uploads.contains_key(&request_id) {
            return Err("Attachment upload is already running.".to_string());
        }
        uploads.insert(request_id.clone(), cancel.clone());
    }

    let result = run_upload(
        &app,
        &request_id,
        &source,
        content_type.as_deref(),
        &base_url,
        &session.token,
        &cancel,
    )
    .await;
    if cancel.is_cancelled() {
        if let Some(record) =
            load_resume_record(&source, size_bytes, modified_at_ms(&metadata)).await
        {
            cancel_server_upload(&base_url, &session.token, &record.attachment_id).await;
        }
        remove_resume_record(&source).await;
        emit_progress(&app, &request_id, "cancelled", 0, size_bytes);
    } else if result.is_err() {
        emit_progress(&app, &request_id, "failed", 0, size_bytes);
    }
    if let Ok(mut uploads) = active_uploads().lock() {
        uploads.remove(&request_id);
    }
    result
}

#[tauri::command]
pub async fn desktop_cloud_attachment_cancel(request_id: String) -> Result<(), String> {
    let uploads = active_uploads()
        .lock()
        .map_err(|_| "Attachment upload state is unavailable.".to_string())?;
    if let Some(cancel) = uploads.get(request_id.trim()) {
        cancel.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        load_resume_record, remove_resume_record, resume_record_path, save_resume_record,
        upload_part_count, upload_part_size, UploadResumeRecord,
    };

    #[test]
    fn large_files_are_read_in_bounded_chunks() {
        let chunk = 8 * 1024 * 1024;
        let size = 250 * 1024 * 1024;
        let part_count = upload_part_count(size, chunk);
        assert_eq!(part_count, 32);
        assert!((0..part_count).all(|index| upload_part_size(size, chunk, index) <= chunk));
        assert_eq!(
            upload_part_size(size, chunk, part_count - 1),
            2 * 1024 * 1024
        );
    }

    #[tokio::test]
    async fn resume_record_is_reused_only_for_the_same_file_version() {
        let _environment_guard = crate::test_support::lock_process_environment();
        let dir =
            std::env::temp_dir().join(format!("kordi-upload-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("archive.zip");
        std::fs::write(&file, b"test").unwrap();
        let record = UploadResumeRecord {
            attachment_id: "att_test".to_string(),
            size_bytes: 4,
            modified_at_ms: 7,
        };

        save_resume_record(&file, &record).await.unwrap();
        assert_ne!(resume_record_path(&file).unwrap().parent(), file.parent());
        assert_eq!(
            load_resume_record(&file, 4, 7).await.unwrap().attachment_id,
            "att_test"
        );
        assert!(load_resume_record(&file, 5, 7).await.is_none());

        remove_resume_record(&file).await;
        assert!(!resume_record_path(&file).unwrap().exists());
        std::fs::remove_dir_all(dir).ok();
    }
}
