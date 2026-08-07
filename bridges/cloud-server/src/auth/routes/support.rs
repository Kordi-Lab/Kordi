use super::*;

pub(super) const AVATAR_SEED_PREFIX: &str = "kordi-pixel-avatar://";
pub(super) const AVATAR_UPLOAD_MAX_BYTES: usize = 200 * 1024;
pub(super) const SIGNUP_DEFAULT_DEVICE_NAME: &str = "cloud-email-password-device";

pub(super) fn err(code: &'static str, message: impl Into<String>, status: StatusCode) -> Response {
    let body = ErrorBody {
        error_code: code,
        message: message.into(),
    };
    (status, Json(body)).into_response()
}

pub(super) fn boxed_err(
    code: &'static str,
    message: impl Into<String>,
    status: StatusCode,
) -> Box<Response> {
    Box::new(err(code, message, status))
}

pub(super) fn normalize_message_attachment_preview_url(
    value: Option<&str>,
) -> Result<Option<String>, Box<Response>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > 360_000 {
        return Err(boxed_err(
            "invalid_attachment",
            "Attachment preview is too large.",
            StatusCode::BAD_REQUEST,
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    let allowed = lower.starts_with("data:image/png;base64,")
        || lower.starts_with("data:image/jpeg;base64,")
        || lower.starts_with("data:image/jpg;base64,")
        || lower.starts_with("data:image/webp;base64,")
        || lower.starts_with("data:image/gif;base64,");
    if !allowed {
        return Err(boxed_err(
            "invalid_attachment",
            "Attachment preview must be a data:image base64 URL.",
            StatusCode::BAD_REQUEST,
        ));
    }
    Ok(Some(trimmed.to_string()))
}

pub(super) fn normalize_message_attachment(
    input: &SendMessageAttachmentRequest,
    attachment_id: &str,
    db_mime_type: Option<String>,
    db_size_bytes: Option<i64>,
    _download_url: Option<String>,
) -> Result<MessageAttachmentSummary, Box<Response>> {
    let name = input.name.trim().chars().take(255).collect::<String>();
    if name.is_empty() {
        return Err(boxed_err(
            "invalid_attachment",
            "Attachment name is required.",
            StatusCode::BAD_REQUEST,
        ));
    }
    let kind = match input.kind.trim() {
        "image" => "image".to_string(),
        "file" => "file".to_string(),
        _ => {
            return Err(boxed_err(
                "invalid_attachment",
                "Attachment kind must be image or file.",
                StatusCode::BAD_REQUEST,
            ));
        }
    };
    let mime_type = input
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(255).collect::<String>())
        .or(db_mime_type);
    let size_bytes = input
        .size_bytes
        .filter(|value| *value >= 0)
        .or(db_size_bytes);
    let preview_url = normalize_message_attachment_preview_url(input.preview_url.as_deref())?;
    Ok(MessageAttachmentSummary {
        attachment_id: attachment_id.to_string(),
        name,
        kind,
        mime_type,
        size_bytes,
        preview_url,
        download_url: None,
    })
}

pub(super) fn limited_response(retry_after: std::time::Duration) -> Response {
    let secs = retry_after.as_secs().max(1);
    let mut response = err(
        "rate_limited",
        "Too many attempts. Try again shortly.",
        StatusCode::TOO_MANY_REQUESTS,
    );
    response
        .headers_mut()
        .insert("Retry-After", secs.to_string().parse().unwrap());
    response
}

pub(super) fn map_password_policy(err_value: PasswordPolicyError) -> Response {
    err(
        "weak_password",
        err_value.to_string(),
        StatusCode::BAD_REQUEST,
    )
}

pub(super) fn map_email_format(err_value: EmailFormatError) -> Response {
    err(
        "invalid_email",
        err_value.to_string(),
        StatusCode::BAD_REQUEST,
    )
}

pub(super) fn ip_from_extension(ip: Option<&ConnectInfo<SocketAddr>>) -> Option<IpAddr> {
    ip.map(|info| info.0.ip())
}

pub(super) fn bearer_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer ").map(str::trim))
}

pub(super) async fn account_response_row(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<AccountResponse>, sqlx_core::Error> {
    let row: Option<(
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = query_as(
        "SELECT account_id, public_account_number, display_name, primary_email, avatar_url, password_hash \
             FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(
            account_id,
            public_account_number,
            display_name,
            primary_email,
            avatar_url,
            password_hash,
        )| AccountResponse {
            account_id,
            kordi_id: public_account_number.to_string(),
            display_name,
            primary_email,
            avatar_url,
            // Bridges-node lookup belonged to the local-first server; cloud
            // server doesn't own registered_nodes, so this stays None.
            node_id: None,
            password_set: password_hash.is_some(),
        },
    ))
}

pub(super) fn normalize_public_kordi_id(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    let without_prefix = trimmed.strip_prefix('@').unwrap_or(trimmed);
    if without_prefix.is_empty()
        || without_prefix
            .chars()
            .any(|ch| !ch.is_ascii_digit() && ch != ' ' && ch != '-')
    {
        return None;
    }
    let digits: String = without_prefix
        .chars()
        .filter(|ch| ch.is_ascii_digit())
        .collect();
    if digits.len() != 9 || digits.starts_with('0') {
        return None;
    }
    digits.parse::<i64>().ok()
}

pub(super) async fn write_audit(
    pool: &PgPool,
    account_id: Option<&str>,
    device_id: Option<&str>,
    event_type: &str,
    metadata_json: serde_json::Value,
) -> Result<(), sqlx_core::Error> {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(account_id)
    .bind(device_id)
    .bind(event_type)
    .bind(metadata_json.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod public_identity_tests {
    use super::normalize_public_kordi_id;

    #[test]
    fn kordi_id_normalization_accepts_supported_human_formats() {
        assert_eq!(normalize_public_kordi_id("@482731906"), Some(482_731_906));
        assert_eq!(normalize_public_kordi_id("482 731 906"), Some(482_731_906));
        assert_eq!(normalize_public_kordi_id("482-731-906"), Some(482_731_906));
        assert_eq!(normalize_public_kordi_id("acct_private"), None);
        assert_eq!(normalize_public_kordi_id("48273190"), None);
        assert_eq!(normalize_public_kordi_id("082731906"), None);
    }
}
