use super::*;
use kordi_tools::SessionAttachmentReference;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;

fn unavailable() -> String {
    "The attachment changed or is unavailable. Refresh its reference before retrying.".into()
}

fn version(content: &str) -> i64 {
    i64::from_str_radix(&crate::canonical_sessions::core::hash_hex(content, 15), 16)
        .unwrap_or(1)
        .max(1)
}

fn metadata(
    conn: &Connection,
    session: &str,
    message: &str,
) -> Result<(String, Vec<Value>), String> {
    let raw: String = conn.query_row("SELECT COALESCE(content_json,'{}') FROM session_messages WHERE session_id=?1 AND id=?2", params![session,message], |row|row.get(0)).map_err(|_|unavailable())?;
    let values = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v["attachments"].as_array().cloned())
        .unwrap_or_default();
    Ok((raw, values))
}

pub(super) fn references(
    conn: &Connection,
    session: &str,
    message: &str,
) -> Result<Vec<SessionAttachmentReference>, String> {
    let (raw, values) = metadata(conn, session, message)?;
    Ok(values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let mime = value["mimeType"].as_str().unwrap_or_else(|| {
                match std::path::Path::new(value["localPath"].as_str().unwrap_or_default())
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref()
                {
                    Some("png") => "image/png",
                    Some("jpg" | "jpeg") => "image/jpeg",
                    Some("webp") => "image/webp",
                    Some("gif") => "image/gif",
                    _ => "application/octet-stream",
                }
            });
            value["localPath"].as_str()?;
            Some(SessionAttachmentReference {
                message_id: message.into(),
                attachment_id: format!("local-image:{index}"),
                message_version: version(&raw),
                mime_type: mime.into(),
                size_bytes: value["sizeBytes"].as_i64().unwrap_or(-1),
            })
        })
        .collect())
}

pub(super) fn read(
    conn: &Connection,
    request: ReadSessionRequest,
) -> Result<ReadSessionResponse, String> {
    let ids = request
        .message_ids
        .as_ref()
        .filter(|ids| ids.len() == 1)
        .ok_or_else(unavailable)?;
    let id = &ids[0];
    let index = request
        .attachment_id
        .as_deref()
        .and_then(|id| id.strip_prefix("local-image:"))
        .and_then(|index| index.parse::<usize>().ok())
        .ok_or_else(unavailable)?;
    let (raw, values) = metadata(conn, &request.session_id, id)?;
    if request.expected_version != Some(version(&raw)) {
        return Err(unavailable());
    }
    let value = values.get(index).ok_or_else(unavailable)?;
    let path = PathBuf::from(value["localPath"].as_str().ok_or_else(unavailable)?);
    let root = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .map(|p| p.join("tmp/attachments"))
        .unwrap_or_else(|| std::env::temp_dir().join("kordi-desktop-attachments"));
    let path = path.canonicalize().map_err(|_| unavailable())?;
    let root = root.canonicalize().map_err(|_| unavailable())?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|_| unavailable())?
        .take(kordi_tools::image_input::MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    let image = kordi_tools::image_input::static_image_content(&bytes)
        .map_err(|error| error.to_string())?;
    if metadata(conn, &request.session_id, id)?.0 != raw {
        return Err(unavailable());
    }
    let response = super::read_session_for_observation_in_db(
        conn,
        ReadSessionRequest {
            mode: Some("messages".into()),
            ..request
        },
    )?;
    Ok(ReadSessionResponse {
        media: vec![image],
        ..response
    })
}
