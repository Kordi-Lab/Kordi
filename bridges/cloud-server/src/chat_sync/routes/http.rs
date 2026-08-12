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
        StoreError::CursorExpired => error_response(
            StatusCode::CONFLICT,
            "SYNC_CURSOR_EXPIRED",
            "The sync cursor is older than retained events.",
            Some(json!({ "bootstrap_required": true })),
        ),
        StoreError::CursorAhead => error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_SYNC_CURSOR",
            "The sync cursor is ahead of the server stream.",
            None,
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

pub(super) struct MessageValidationError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl MessageValidationError {
    pub(super) fn into_response(self) -> Response {
        error_response(self.status, self.code, self.message, None)
    }
}

pub(super) fn validate_message_request(
    request: &SendMessageRequest,
) -> Result<(), MessageValidationError> {
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
    Ok(())
}
