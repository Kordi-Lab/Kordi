use super::*;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

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
    let row: Option<AccountRecordRow> = query_as(
        "SELECT account_id, public_account_number, display_name, primary_email, avatar_url, password_hash, \
            avatar_source, avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at \
             FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    let default_agent = default_agent_profile_row(pool, account_id).await?;
    Ok(row.map(|row| account_response_from_rows(row, default_agent)))
}

pub(super) fn default_agent_id(account_id: &str) -> String {
    format!("cloud-agent:{}", account_id.trim())
}

pub(super) async fn default_agent_profile_row(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<DefaultAgentProfileRow>, sqlx_core::Error> {
    query_as(
        "SELECT owner_account_id, display_name, avatar_url, avatar_source, avatar_style, \
            avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at \
         FROM cloud_default_agent_profiles WHERE owner_account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await
}

pub(super) fn default_agent_profile_from_row(
    account_id: &str,
    row: Option<DefaultAgentProfileRow>,
    fallback_updated_at: &str,
) -> DefaultAgentProfileResponse {
    let agent_id = default_agent_id(account_id);
    let row = row.unwrap_or_else(|| {
        let seed = format!("default-agent-{account_id}");
        (
            account_id.to_string(),
            "Kordi".to_string(),
            None,
            "generated".to_string(),
            crate::avatars::AGENT_AVATAR_STYLE.to_string(),
            seed,
            crate::avatars::AVATAR_RENDERER_VERSION.to_string(),
            1,
            fallback_updated_at.to_string(),
        )
    });
    let avatar = descriptor_from_parts(
        "agent".to_string(),
        agent_id.clone(),
        StoredAvatar {
            source: row.3,
            style: row.4,
            seed: row.5,
            renderer_version: row.6,
            avatar_url: row.2,
            version: row.7,
            updated_at: row.8,
        },
    );
    DefaultAgentProfileResponse {
        agent_id,
        display_name: row.1,
        avatar_url: Some(avatar.image_url()),
        avatar,
    }
}

pub(super) fn account_response_from_rows(
    row: AccountRecordRow,
    default_agent_row: Option<DefaultAgentProfileRow>,
) -> AccountResponse {
    let avatar = descriptor_from_parts(
        "human".to_string(),
        row.0.clone(),
        StoredAvatar {
            source: row.6,
            style: row.7,
            seed: row.8,
            renderer_version: row.9,
            avatar_url: row.4.clone(),
            version: row.10,
            updated_at: row.11.clone(),
        },
    );
    let default_agent = default_agent_profile_from_row(&row.0, default_agent_row, &row.11);
    AccountResponse {
        account_id: row.0,
        kordi_id: row.1.to_string(),
        display_name: row.2,
        primary_email: row.3,
        avatar_url: Some(avatar.image_url()),
        avatar,
        default_agent,
        node_id: None,
        password_set: row.5.is_some(),
    }
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

pub(super) fn normalized_source_session_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return None;
    }
    Some(trimmed.to_string())
}

pub(super) async fn conversation_id_for_session_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    session_id: &str,
) -> Result<Option<Uuid>, sqlx_core::Error> {
    let canonical_id = Uuid::parse_str(session_id).ok();
    query_as(
        "SELECT conversation.conversation_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE (conversation.legacy_session_id = $1 OR conversation.conversation_id = $3) \
           AND member.account_id = $2 \
           AND member.membership_state = 'active'",
    )
    .bind(session_id)
    .bind(account_id)
    .bind(canonical_id)
    .fetch_optional(&mut **transaction)
    .await
    .map(|row: Option<(Uuid,)>| row.map(|(conversation_id,)| conversation_id))
}

pub(super) async fn active_conversation_member_ids_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Vec<String>, sqlx_core::Error> {
    query_as::<_, (String,)>(
        "SELECT account_id FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active' \
         ORDER BY account_id ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut **transaction)
    .await
    .map(|rows| rows.into_iter().map(|(account_id,)| account_id).collect())
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
