use std::sync::Arc;

use anyhow::{Result, anyhow};
use chrono::Utc;
use kordi_core::agent_session::ImageContent;
use kordi_core::types::{ContentBlock, EntryBase, EntryId, SessionEntry};
use serde::Deserialize;

use crate::turn_runner;

use super::{ATTACHMENT_CONTEXT_CUSTOM_TYPE, DesktopChatAttachment};

pub(super) fn attachment_is_image(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp")
    )
}

fn attachment_format_label_from_path(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
}

fn attachment_name_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(path)
        .to_string()
}

fn attachment_mime_type_from_path(path: &str) -> Option<String> {
    match std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png".to_string()),
        Some("jpg" | "jpeg") => Some("image/jpeg".to_string()),
        Some("gif") => Some("image/gif".to_string()),
        Some("webp") => Some("image/webp".to_string()),
        Some("bmp") => Some("image/bmp".to_string()),
        Some("svg") => Some("image/svg+xml".to_string()),
        Some("pdf") => Some("application/pdf".to_string()),
        Some("json") => Some("application/json".to_string()),
        Some("zip") => Some("application/zip".to_string()),
        Some("txt" | "md" | "log") => Some("text/plain".to_string()),
        _ => None,
    }
}

pub(super) fn attachment_metadata_from_path(path: &str) -> DesktopChatAttachment {
    DesktopChatAttachment {
        kind: if attachment_is_image(path) {
            "image".to_string()
        } else {
            "file".to_string()
        },
        name: attachment_name_from_path(path),
        format_label: attachment_format_label_from_path(path),
        preview_url: None,
        mime_type: attachment_mime_type_from_path(path),
        local_path: Some(path.to_string()),
        size_bytes: std::fs::metadata(path).ok().map(|metadata| metadata.len()),
    }
}

pub(super) fn attachment_summary_from_metadata(
    attachments: &[DesktopChatAttachment],
) -> Option<String> {
    match attachments {
        [] => None,
        [attachment] => Some(format!("Attached {}", attachment.name)),
        _ => Some(format!("{} attachments", attachments.len())),
    }
}

pub(super) async fn append_attachment_context_message(
    conn: &Arc<tokio::sync::Mutex<rusqlite::Connection>>,
    session_id: &str,
    attachment_context_text: &str,
    attachments: &[DesktopChatAttachment],
) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }

    let conn = conn.lock().await;
    let content = if attachment_context_text.trim().is_empty() {
        Vec::new()
    } else {
        vec![ContentBlock::Text {
            text: attachment_context_text.to_string(),
        }]
    };
    let entry = SessionEntry::CustomMessage {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: turn_runner::get_leaf_raw(&conn, session_id),
            timestamp: Utc::now(),
        },
        custom_type: ATTACHMENT_CONTEXT_CUSTOM_TYPE.to_string(),
        content,
        display: false,
        details: Some(serde_json::json!({ "attachments": attachments })),
    };
    kordi_session::store::append_entry(&conn, session_id, &entry)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct AttachmentContextDetails {
    #[serde(default)]
    attachments: Vec<DesktopChatAttachment>,
}

pub(super) fn attachments_from_details(
    details: &Option<serde_json::Value>,
) -> Vec<DesktopChatAttachment> {
    details
        .clone()
        .and_then(|value| serde_json::from_value::<AttachmentContextDetails>(value).ok())
        .map(|value| value.attachments)
        .unwrap_or_default()
}

pub(super) fn image_attachments_from_blocks(blocks: &[ContentBlock]) -> Vec<DesktopChatAttachment> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Image { data, mime_type } => Some(DesktopChatAttachment {
                kind: "image".to_string(),
                name: "Image attachment".to_string(),
                format_label: mime_type
                    .split('/')
                    .nth(1)
                    .map(|value| value.trim().to_ascii_uppercase())
                    .filter(|value| !value.is_empty()),
                preview_url: Some(format!("data:{mime_type};base64,{data}")),
                mime_type: Some(mime_type.to_string()),
                local_path: None,
                size_bytes: None,
            }),
            _ => None,
        })
        .collect()
}

pub(super) fn merge_attachment_metadata(
    existing: Vec<DesktopChatAttachment>,
    metadata: Vec<DesktopChatAttachment>,
) -> Vec<DesktopChatAttachment> {
    if metadata.is_empty() {
        return existing;
    }

    let mut remaining_images = existing
        .into_iter()
        .filter(|attachment| attachment.kind == "image")
        .collect::<Vec<_>>()
        .into_iter();
    let mut merged = Vec::new();

    for attachment in metadata {
        if attachment.kind == "image" {
            if let Some(preview) = remaining_images.next() {
                merged.push(DesktopChatAttachment {
                    kind: "image".to_string(),
                    name: if attachment.name.trim().is_empty() {
                        preview.name
                    } else {
                        attachment.name
                    },
                    format_label: attachment.format_label.or(preview.format_label),
                    preview_url: preview.preview_url,
                    mime_type: attachment.mime_type.or(preview.mime_type),
                    local_path: attachment.local_path.or(preview.local_path),
                    size_bytes: attachment.size_bytes.or(preview.size_bytes),
                });
            } else {
                merged.push(attachment);
            }
        } else {
            merged.push(attachment);
        }
    }

    merged.extend(remaining_images);
    merged
}

fn quote_attachment_path(path: &str) -> String {
    if path.contains(char::is_whitespace) || path.contains('"') || path.contains('\'') {
        format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

pub(super) fn expand_prompt_with_attachment_paths(
    prompt: &str,
    attachment_paths: &[String],
    cwd: &std::path::Path,
) -> crate::input_files::ExpandedInputFiles {
    let attachment_refs = attachment_paths
        .iter()
        .map(|path| format!("@{}", quote_attachment_path(path)))
        .collect::<Vec<_>>();
    let combined = if attachment_refs.is_empty() {
        prompt.trim().to_string()
    } else if prompt.trim().is_empty() {
        attachment_refs.join("\n")
    } else {
        format!("{}\n\n{}", prompt.trim(), attachment_refs.join("\n"))
    };
    crate::input_files::expand_at_file_references(&combined, cwd)
}

pub(super) fn load_images_from_paths(paths: &[std::path::PathBuf]) -> Result<Vec<ImageContent>> {
    use base64::Engine;

    let mut images = Vec::new();
    for path in paths {
        let data = std::fs::read(path)
            .map_err(|error| anyhow!("Could not read image {}: {error}", path.display()))?;
        let mime_type = match path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref()
        {
            Some("png") => Some("image/png"),
            Some("jpg" | "jpeg") => Some("image/jpeg"),
            Some("gif") => Some("image/gif"),
            Some("webp") => Some("image/webp"),
            _ => None,
        };
        let Some(mime_type) = mime_type else {
            continue;
        };
        images.push(ImageContent {
            source: base64::engine::general_purpose::STANDARD.encode(data),
            mime_type: Some(mime_type.to_string()),
        });
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_expansion_quotes_paths_with_spaces() {
        let expanded = expand_prompt_with_attachment_paths(
            "see these",
            &["/tmp/a b.png".to_string()],
            std::path::Path::new("/tmp"),
        );

        assert!(expanded.text.contains("see these"));
        assert!(expanded.text.contains("@\"/tmp/a b.png\""));
    }

    #[test]
    fn attachment_summary_mentions_single_file_name() {
        let attachments = vec![DesktopChatAttachment {
            kind: "file".to_string(),
            name: "report.pdf".to_string(),
            format_label: Some("PDF".to_string()),
            preview_url: None,
            mime_type: Some("application/pdf".to_string()),
            local_path: Some("/tmp/report.pdf".to_string()),
            size_bytes: Some(12),
        }];

        assert_eq!(
            attachment_summary_from_metadata(&attachments).as_deref(),
            Some("Attached report.pdf"),
        );
    }
}
