use super::*;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

pub(super) const SIGNUP_DEFAULT_DEVICE_NAME: &str =
    crate::auth::devices::EMAIL_PASSWORD_PLACEHOLDER_DEVICE_NAME;

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

/// The requesting client's address: the TCP peer, or the forwarded address
/// when the peer is a trusted reverse proxy (see [`crate::client_ip`]).
pub(super) fn client_ip(
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<SocketAddr>>,
) -> Option<IpAddr> {
    crate::client_ip::resolve_client_ip(headers, connect_info.map(|info| info.0.ip()))
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
    let row: Option<AccountRecordRow> = query_as(&format!(
        "SELECT {ACCOUNT_RECORD_COLUMNS} FROM cloud_accounts WHERE account_id = $1"
    ))
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    let default_agent = default_agent_profile_row(pool, account_id).await?;
    Ok(row.map(|row| account_response_from_rows(row, default_agent)))
}

/// Like [`account_response_row`], with the state only the signed-in owner of
/// `account_id` may see. Never use it for payloads about another account.
pub(super) async fn owner_account_response_row(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<AccountResponse>, sqlx_core::Error> {
    let row: Option<OwnerAccountRecordRow> = query_as(&format!(
        "SELECT {OWNER_ACCOUNT_RECORD_COLUMNS} FROM cloud_accounts WHERE account_id = $1"
    ))
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    let default_agent = default_agent_profile_row(pool, account_id).await?;
    Ok(row.map(|row| owner_account_response_from_rows(row, default_agent)))
}

pub(super) fn owner_account_response_from_rows(
    row: OwnerAccountRecordRow,
    default_agent_row: Option<DefaultAgentProfileRow>,
) -> AccountResponse {
    let change_available_at = row
        .public_handle_changed_at
        .and_then(|changed_at| public_handle_locked_until(changed_at, Utc::now()))
        .map(|until| until.to_rfc3339());
    AccountResponse {
        primary_email_verified: Some(row.primary_email_verified),
        birthday: Some(row.birthday.map(|date| date.format("%Y-%m-%d").to_string())),
        account_number: Some(row.account_number),
        kordi_id_change_available_at: Some(change_available_at),
        ..account_response_from_rows(row.account, default_agent_row)
    }
}

/// How long a changed public handle stays fixed.
pub(super) const PUBLIC_HANDLE_CHANGE_INTERVAL_DAYS: i64 = 365;

/// When a handle changed at `changed_at` may change again, if that is still
/// after `now`; `None` means it may change now.
pub(super) fn public_handle_locked_until(
    changed_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let available_at = changed_at + ChronoDuration::days(PUBLIC_HANDLE_CHANGE_INTERVAL_DAYS);
    (now < available_at).then_some(available_at)
}

/// The user-facing message for a handle that changed too recently.
pub(super) fn public_handle_locked_message(available_at: DateTime<Utc>) -> String {
    format!(
        "You can change your Kordi ID once a year. Next change on {}.",
        available_at.format("%B %-d, %Y")
    )
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
        row.account_id.clone(),
        StoredAvatar {
            source: row.avatar_source,
            style: row.avatar_style,
            seed: row.avatar_seed,
            renderer_version: row.avatar_renderer_version,
            avatar_url: row.avatar_url.clone(),
            version: row.avatar_version,
            updated_at: row.avatar_updated_at.clone(),
        },
    );
    let default_agent =
        default_agent_profile_from_row(&row.account_id, default_agent_row, &row.avatar_updated_at);
    AccountResponse {
        account_id: row.account_id,
        kordi_id: row.kordi_id,
        display_name: row.display_name,
        primary_email: row.primary_email,
        avatar_url: Some(avatar.image_url()),
        avatar,
        default_agent,
        node_id: None,
        password_set: row.password_hash.is_some(),
        primary_email_verified: None,
        about: row.about,
        location: row.location,
        time_zone: row.time_zone,
        website: row.website,
        birthday: None,
        account_number: None,
        kordi_id_change_available_at: None,
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

/// A user-chosen Kordi ID was not 3-30 ASCII letters and digits with at
/// least one letter.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct InvalidPublicHandle;

pub(super) const INVALID_PUBLIC_HANDLE_MESSAGE: &str =
    "Use 3-30 letters and numbers, with at least one letter.";

/// Normalizes a user-chosen Kordi ID (handle) such as `@shuyhere`.
///
/// Blank input means "no handle" (`Ok(None)`). Otherwise one leading `@` is
/// stripped and the rest must be 3-30 ASCII letters and digits with at least
/// one letter, so a handle can never look like a nine-digit account number.
/// The user's case is kept for display; uniqueness is case-insensitive.
pub(super) fn normalize_public_handle(value: &str) -> Result<Option<String>, InvalidPublicHandle> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let handle = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let valid = (3..=30).contains(&handle.len())
        && handle.chars().all(|ch| ch.is_ascii_alphanumeric())
        && handle.chars().any(|ch| ch.is_ascii_alphabetic());
    if valid {
        Ok(Some(handle.to_string()))
    } else {
        Err(InvalidPublicHandle)
    }
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
    use super::{
        normalize_public_handle, normalize_public_kordi_id, public_handle_locked_message,
        public_handle_locked_until, InvalidPublicHandle,
    };
    use chrono::{TimeZone, Utc};

    #[test]
    fn a_changed_handle_stays_locked_for_365_days() {
        let changed_at = Utc.with_ymd_and_hms(2026, 10, 20, 15, 30, 0).unwrap();
        let available_at = Utc.with_ymd_and_hms(2027, 10, 20, 15, 30, 0).unwrap();
        assert_eq!(
            public_handle_locked_until(changed_at, changed_at),
            Some(available_at)
        );
        assert_eq!(
            public_handle_locked_until(changed_at, available_at - chrono::Duration::seconds(1)),
            Some(available_at)
        );
        assert_eq!(public_handle_locked_until(changed_at, available_at), None);
        // 365 days, not one calendar year, across a leap day.
        let before_leap = Utc.with_ymd_and_hms(2027, 6, 1, 0, 0, 0).unwrap();
        assert_eq!(
            public_handle_locked_until(before_leap, before_leap),
            Some(Utc.with_ymd_and_hms(2028, 5, 31, 0, 0, 0).unwrap())
        );
        assert_eq!(
            public_handle_locked_message(available_at),
            "You can change your Kordi ID once a year. Next change on October 20, 2027."
        );
        assert_eq!(
            public_handle_locked_message(Utc.with_ymd_and_hms(2028, 5, 1, 0, 0, 0).unwrap()),
            "You can change your Kordi ID once a year. Next change on May 1, 2028."
        );
    }

    #[test]
    fn public_handle_normalization_accepts_letters_and_digits() {
        assert_eq!(
            normalize_public_handle("@shuyhere"),
            Ok(Some("shuyhere".to_string()))
        );
        assert_eq!(
            normalize_public_handle("  ShuYhere "),
            Ok(Some("ShuYhere".to_string()))
        );
        assert_eq!(normalize_public_handle("ab1"), Ok(Some("ab1".to_string())));
        assert_eq!(
            normalize_public_handle(&"a".repeat(30)),
            Ok(Some("a".repeat(30)))
        );
        assert_eq!(normalize_public_handle("   "), Ok(None));
        assert_eq!(normalize_public_handle(""), Ok(None));
    }

    #[test]
    fn public_handle_normalization_rejects_invalid_values() {
        for value in [
            "shu_yhere",
            "ab",
            "@ab",
            "123456789",
            "1234",
            "shu yhere",
            "@",
            "@@shuyhere",
            "shu-yhere",
            "shuyhére",
        ] {
            assert_eq!(
                normalize_public_handle(value),
                Err(InvalidPublicHandle),
                "{value}"
            );
        }
        assert_eq!(
            normalize_public_handle(&"a".repeat(31)),
            Err(InvalidPublicHandle)
        );
    }

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
