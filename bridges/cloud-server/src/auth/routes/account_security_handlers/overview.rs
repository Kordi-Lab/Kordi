//! `GET /v1/cloud/account/security`: what the account security page shows.

use super::proof::signed_in_recently;
use super::sessions::list_sessions;
use super::*;
use crate::auth::app_sign_in::AppClientRegistry;
use crate::auth::routes::device_operation_support::confirm_reviewed_devices_now;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedProvider {
    provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    email_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    linked_at: String,
}

type ProviderRow = (String, Option<String>, bool, Option<String>, String);

pub(super) async fn account_security(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match overview(&state, &registry, &session).await {
        Ok(body) => Json(body).into_response(),
        Err(response) => *response,
    }
}

async fn overview(
    state: &ServerState,
    registry: &AppClientRegistry,
    session: &CloudSession,
) -> Result<serde_json::Value, Box<Response>> {
    let pool = state.db_pool();
    // The page reads with the cookie, which the session middleware does not
    // count as activity.
    let _ = touch_device_activity(pool, &session.account_id, &session.device_id).await;
    confirm_reviewed_devices_now(state, &session.account_id).await?;
    let account = load_account(pool, &session.account_id).await?;
    let providers: Vec<ProviderRow> = query_as(
        "SELECT provider, email, email_verified, provider_username, created_at \
         FROM cloud_account_identities WHERE account_id = $1 ORDER BY provider, created_at",
    )
    .bind(&session.account_id)
    .fetch_all(pool)
    .await
    .map_err(|_| server_error())?;
    let device_confirmed: Option<(String,)> = query_as(
        "SELECT authorization_state FROM cloud_devices \
         WHERE account_id = $1 AND device_id = $2 AND revoked_at IS NULL",
    )
    .bind(&session.account_id)
    .bind(&session.device_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| server_error())?;
    let sessions = list_sessions(pool, registry, session).await?;
    let recent_sign_in = signed_in_recently(pool, &session.token_id).await?;
    let providers: Vec<LinkedProvider> = providers
        .into_iter()
        .map(
            |(provider, email, email_verified, username, linked_at)| LinkedProvider {
                provider,
                email,
                email_verified,
                username,
                linked_at,
            },
        )
        .collect();
    Ok(serde_json::json!({
        "email": {
            "address": account.primary_email,
            "verified": account.email_verified,
        },
        "password": {
            "set": account.password_hash.is_some(),
            "updatedAt": account.password_updated_at,
        },
        "providers": providers,
        "sessions": sessions,
        "canManageOtherSessions": device_confirmed
            .is_some_and(|(authorization_state,)| authorization_state == "confirmed"),
        "recentSignIn": recent_sign_in,
    }))
}
