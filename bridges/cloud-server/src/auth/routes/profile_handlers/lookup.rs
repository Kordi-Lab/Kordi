//! Looking up another account's public profile by Kordi ID.

use super::*;

pub(in crate::auth::routes) async fn get_profile(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    let target = account_id.trim().to_string();
    if target.is_empty() {
        return err(
            "invalid_account_id",
            "Kordi ID is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(client_ip(&headers, connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }

    let legacy_account_id = target.starts_with("acct_").then_some(target.as_str());
    let public_account_number = normalize_public_kordi_id(&target);
    let public_handle = normalize_public_handle(&target).ok().flatten();
    if legacy_account_id.is_none() && public_account_number.is_none() && public_handle.is_none() {
        return err(
            "invalid_account_id",
            "Enter a Kordi ID.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();

    let row: Option<AccountRecordRow> = match query_as(&format!(
        "SELECT {ACCOUNT_RECORD_COLUMNS} \
         FROM cloud_accounts \
         WHERE ($1::BIGINT IS NOT NULL AND public_account_number = $1) \
            OR ($2::TEXT IS NOT NULL AND account_id = $2) \
            OR ($3::TEXT IS NOT NULL AND public_handle IS NOT NULL AND LOWER(public_handle) = LOWER($3))",
    ))
    .bind(public_account_number)
    .bind(legacy_account_id)
    .bind(public_handle.as_deref())
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let Some(AccountRecordRow {
        account_id,
        kordi_id,
        display_name,
        avatar_url,
        about,
        location,
        time_zone,
        website,
        ..
    }) = row
    else {
        return err(
            "account_missing",
            "No account found with that Kordi ID.",
            StatusCode::NOT_FOUND,
        );
    };

    let is_self = account_id == session.account_id;
    let is_contact = if is_self {
        false
    } else {
        let contact_row: Option<(i32,)> =
            query_as("SELECT 1 FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2")
                .bind(&session.account_id)
                .bind(&account_id)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);
        contact_row.is_some()
    };
    let default_agent = match default_agent_profile_row(pool, &account_id).await {
        Ok(row) => default_agent_profile_from_row(&account_id, row, &Utc::now().to_rfc3339()),
        Err(_) => {
            return err(
                "server_error",
                "Could not fetch agent profile.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    Json(PublicProfileResponse {
        account_id,
        kordi_id,
        display_name,
        avatar_url,
        default_agent,
        node_id: None,
        about,
        location,
        time_zone,
        website,
        is_contact,
        is_self,
    })
    .into_response()
}
