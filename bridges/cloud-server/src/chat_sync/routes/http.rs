use super::*;

pub(super) fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
    details: Option<serde_json::Value>,
) -> Response {
    let mut error = json!({
        "code": code,
        "message": message,
    });
    if let (Some(object), Some(details)) = (error.as_object_mut(), details) {
        object.insert("details".to_string(), details);
    }
    (status, Json(json!({ "error": error }))).into_response()
}

pub(super) enum RuntimeRequirementError {
    CursorUnavailable,
}

pub(super) fn runtime_requirement_error(error: RuntimeRequirementError) -> Response {
    match error {
        RuntimeRequirementError::CursorUnavailable => error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHAT_SYNC_CURSOR_UNAVAILABLE",
            "Reliable chat sync is not fully configured.",
            None,
        ),
    }
}

pub(super) fn require_cursor_codec(
    runtime: &ChatSyncRuntime,
) -> Result<CursorCodec, RuntimeRequirementError> {
    runtime
        .cursor_codec
        .clone()
        .ok_or(RuntimeRequirementError::CursorUnavailable)
}

pub(super) fn store_error(context: &str, error: StoreError) -> Response {
    match error {
        StoreError::InvalidInput(message) => {
            error_response(StatusCode::BAD_REQUEST, "INVALID_REQUEST", message, None)
        }
        StoreError::NotFound => error_response(
            StatusCode::NOT_FOUND,
            "CHAT_ENTITY_NOT_FOUND",
            "The requested conversation or message is unavailable.",
            None,
        ),
        StoreError::Forbidden => error_response(
            StatusCode::FORBIDDEN,
            "CHAT_FORBIDDEN",
            "The account is not allowed to perform this operation.",
            None,
        ),
        StoreError::IdempotencyKeyReused => error_response(
            StatusCode::CONFLICT,
            "IDEMPOTENCY_KEY_REUSED",
            "The client operation ID was already used with different input.",
            None,
        ),
        StoreError::VersionConflict(current) => error_response(
            StatusCode::CONFLICT,
            "VERSION_CONFLICT",
            "The conversation changed on another device.",
            Some(json!({ "current_conversation": current })),
        ),
        StoreError::PreferencesVersionConflict(current) => error_response(
            StatusCode::CONFLICT,
            "VERSION_CONFLICT",
            "The conversation preferences changed on another device.",
            Some(json!({ "current_preferences": current })),
        ),
        StoreError::MessageVersionConflict(current) => error_response(
            StatusCode::CONFLICT,
            "VERSION_CONFLICT",
            "The message changed on another device.",
            Some(json!({ "current_message": current })),
        ),
        StoreError::CursorExpired => error_response(
            StatusCode::CONFLICT,
            "SYNC_CURSOR_EXPIRED",
            "The sync cursor is older than retained events.",
            Some(json!({ "bootstrap_required": true })),
        ),
        StoreError::CursorAhead => error_response(
            StatusCode::CONFLICT,
            "SYNC_CURSOR_EXPIRED",
            "The sync cursor is ahead of the server stream.",
            Some(json!({ "bootstrap_required": true })),
        ),
        StoreError::Database(error) => {
            eprintln!("[chat-sync] {context}: {error}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "SERVER_ERROR",
                "The chat operation could not be completed.",
                None,
            )
        }
        StoreError::InvariantViolation(message) => {
            eprintln!("[chat-sync] {context}: invariant violation: {message}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CHAT_SYNC_INVARIANT_VIOLATION",
                "The durable chat stream failed an integrity check.",
                Some(json!({ "bootstrap_required": true })),
            )
        }
    }
}

#[derive(Debug)]
pub(super) struct MessageValidationError {
    pub(super) status: StatusCode,
    pub(super) code: &'static str,
    pub(super) message: &'static str,
}

impl MessageValidationError {
    pub(super) fn into_response(self) -> Response {
        error_response(self.status, self.code, self.message, None)
    }
}

pub(super) fn validate_message_request(
    request: &SendMessageRequest,
) -> Result<(), MessageValidationError> {
    let message_kind = request.kind.trim();
    if message_kind == "call" || message_kind.starts_with("call.") {
        return Err(MessageValidationError {
            status: StatusCode::BAD_REQUEST,
            code: "RESERVED_MESSAGE_KIND",
            message: "Call activity messages can only be created by the call service.",
        });
    }
    let Some(content) = request.content.as_object() else {
        return Err(MessageValidationError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_MESSAGE_CONTENT",
            message: "Message content must be a structured JSON object.",
        });
    };
    if content
        .get("schema")
        .and_then(serde_json::Value::as_u64)
        .is_none_or(|schema| schema == 0)
        || !content
            .get("blocks")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(MessageValidationError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_MESSAGE_CONTENT",
            message: "Message content must contain a positive schema and a blocks array.",
        });
    }
    let encoded_size = serde_json::to_vec(&request.content)
        .map(|value| value.len())
        .unwrap_or(usize::MAX);
    if encoded_size > MAX_MESSAGE_CONTENT_BYTES {
        return Err(MessageValidationError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            code: "MESSAGE_TOO_LARGE",
            message: "Message content exceeds the encoded size limit.",
        });
    }
    if request.attachment_ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(MessageValidationError {
            status: StatusCode::BAD_REQUEST,
            code: "TOO_MANY_ATTACHMENTS",
            message: "The message references too many attachments.",
        });
    }
    if message_kind == "voice" {
        validate_voice_message(content, &request.attachment_ids)?;
    }
    validate_attachment_metadata(content, &request.attachment_ids)?;
    Ok(())
}

fn validate_voice_message(
    content: &serde_json::Map<String, serde_json::Value>,
    attachment_ids: &[String],
) -> Result<(), MessageValidationError> {
    let blocks = content
        .get("blocks")
        .and_then(serde_json::Value::as_array)
        .expect("message blocks validated before voice metadata");
    let voice_blocks = blocks
        .iter()
        .filter_map(serde_json::Value::as_object)
        .filter(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("voice"))
        .collect::<Vec<_>>();
    let valid = voice_blocks.len() == 1
        && attachment_ids.len() == 1
        && voice_blocks.first().is_some_and(|voice| {
            let media_id = voice
                .get("mediaId")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let mime_type = voice
                .get("mimeType")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let duration_ms = voice
                .get("durationMs")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default();
            let transcript = voice
                .get("transcript")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let waveform = voice
                .get("waveformSamples")
                .and_then(serde_json::Value::as_array);
            media_id == attachment_ids[0].trim()
                && matches!(
                    mime_type.as_str(),
                    "audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac"
                )
                && (1..=60_000).contains(&duration_ms)
                && !transcript.is_empty()
                && transcript.chars().count() <= 20_000
                && waveform.is_some_and(|samples| {
                    !samples.is_empty()
                        && samples.len() <= 96
                        && samples.iter().all(|sample| {
                            sample.as_f64().is_some_and(|value| {
                                value.is_finite() && (0.0..=1.0).contains(&value)
                            })
                        })
                })
        });
    if valid {
        return Ok(());
    }
    Err(MessageValidationError {
        status: StatusCode::BAD_REQUEST,
        code: "INVALID_VOICE_MESSAGE",
        message: "Voice messages require one finalized audio item, a transcript, a duration of at most 60 seconds, and bounded waveform samples.",
    })
}

fn validate_attachment_metadata(
    content: &serde_json::Map<String, serde_json::Value>,
    attachment_ids: &[String],
) -> Result<(), MessageValidationError> {
    let Some(attachments) = content.get("legacy_attachments") else {
        return Ok(());
    };
    let Some(attachments) = attachments.as_array() else {
        return Err(MessageValidationError {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_ATTACHMENT_METADATA",
            message: "Attachment metadata must be an array.",
        });
    };
    for attachment in attachments {
        let Some(attachment) = attachment.as_object() else {
            return Err(MessageValidationError {
                status: StatusCode::BAD_REQUEST,
                code: "INVALID_ATTACHMENT_METADATA",
                message: "Attachment metadata must contain structured objects.",
            });
        };
        let width = attachment.get("widthPixels");
        let height = attachment.get("heightPixels");
        let dimensions_valid = match (width, height) {
            (None, None) => true,
            (Some(width), Some(height)) if width.is_null() && height.is_null() => true,
            (Some(width), Some(height)) => {
                width
                    .as_u64()
                    .is_some_and(|value| (1..=MAX_IMAGE_PIXEL_DIMENSION).contains(&value))
                    && height
                        .as_u64()
                        .is_some_and(|value| (1..=MAX_IMAGE_PIXEL_DIMENSION).contains(&value))
            }
            _ => false,
        };
        if !dimensions_valid {
            return Err(MessageValidationError {
                status: StatusCode::BAD_REQUEST,
                code: "INVALID_IMAGE_DIMENSIONS",
                message: "Image dimensions must be a bounded positive pixel pair.",
            });
        }
        let Some(subtype) = attachment.get("subtype") else {
            continue;
        };
        if subtype.is_null() {
            continue;
        }
        if subtype.as_str() != Some("meme") {
            return Err(MessageValidationError {
                status: StatusCode::BAD_REQUEST,
                code: "INVALID_ATTACHMENT_SUBTYPE",
                message: "The attachment subtype is not supported.",
            });
        }
        let attachment_id = attachment
            .get("attachmentId")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let alt_text = attachment
            .get("altText")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let mime_type = attachment
            .get("mimeType")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let supported_mime = matches!(
            mime_type.to_ascii_lowercase().as_str(),
            "image/png" | "image/jpeg" | "image/jpg" | "image/gif" | "image/webp"
        );
        if attachment_id.is_empty()
            || !attachment_ids
                .iter()
                .any(|value| value.trim() == attachment_id)
            || attachment.get("kind").and_then(serde_json::Value::as_str) != Some("image")
            || alt_text.is_empty()
            || alt_text.chars().count() > 500
            || !supported_mime
        {
            return Err(MessageValidationError {
                status: StatusCode::BAD_REQUEST,
                code: "INVALID_MEME_ATTACHMENT",
                message: "Meme attachments require a supported image, a matching attachment ID, and alt text of 500 characters or fewer.",
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use axum::{body::to_bytes, http::StatusCode};
    use serde_json::json;
    use uuid::Uuid;

    use super::{store_error, validate_message_request};
    use crate::chat_sync::models::SendMessageRequest;
    use crate::chat_sync::store::StoreError;

    #[tokio::test]
    async fn reset_server_cursor_requests_a_fresh_bootstrap() {
        let response = store_error("sync", StoreError::CursorAhead);
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "SYNC_CURSOR_EXPIRED");
        assert_eq!(body["error"]["details"]["bootstrap_required"], true);
    }

    #[test]
    fn client_messages_cannot_impersonate_call_activity() {
        for kind in ["call", "call.started.fake"] {
            let request = SendMessageRequest {
                client_message_id: Uuid::now_v7(),
                kind: kind.to_string(),
                content: json!({
                    "schema": 1,
                    "blocks": [{ "type": "text", "text": "Forged call activity" }]
                }),
                reply_to_message_id: None,
                attachment_ids: Vec::new(),
            };

            assert!(validate_message_request(&request).is_err());
        }
    }

    #[test]
    fn voice_messages_require_bounded_native_audio_metadata() {
        let request = |voice: serde_json::Value| SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "voice".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [
                    { "type": "text", "text": "Meet me after lunch." },
                    voice
                ]
            }),
            reply_to_message_id: None,
            attachment_ids: vec!["att_voice".to_string()],
        };
        let valid = json!({
            "type": "voice",
            "mediaId": "att_voice",
            "mimeType": "audio/mp4",
            "durationMs": 12_000,
            "waveformSamples": [0.1, 0.5, 1.0],
            "transcript": "Meet me after lunch."
        });
        assert!(validate_message_request(&request(valid.clone())).is_ok());

        let mut too_long = valid.clone();
        too_long["durationMs"] = json!(60_001);
        assert!(validate_message_request(&request(too_long)).is_err());

        let mut wrong_media = valid;
        wrong_media["mediaId"] = json!("att_other");
        assert!(validate_message_request(&request(wrong_media)).is_err());
    }

    #[test]
    fn image_dimensions_must_be_bounded_pairs() {
        let request = |attachment: serde_json::Value| SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [{ "type": "text", "text": "Image" }],
                "legacy_attachments": [attachment]
            }),
            reply_to_message_id: None,
            attachment_ids: vec!["att_image".to_string()],
        };
        let attachment = json!({
            "attachmentId": "att_image",
            "kind": "image",
            "widthPixels": 1600,
            "heightPixels": 900
        });
        assert!(validate_message_request(&request(attachment.clone())).is_ok());

        let mut missing_height = attachment.clone();
        missing_height
            .as_object_mut()
            .unwrap()
            .remove("heightPixels");
        assert!(validate_message_request(&request(missing_height)).is_err());

        let mut too_large = attachment;
        too_large["widthPixels"] = json!(100_001);
        assert!(validate_message_request(&request(too_large)).is_err());
    }
}
