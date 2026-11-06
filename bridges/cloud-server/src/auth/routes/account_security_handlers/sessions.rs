//! Signed-in sessions of an account: list, sign out one, and sign out of
//! other devices.
//!
//! A session is either an app sign-in (`asi_…`, from browser sign-in) or a
//! direct session (`cs_…`, such as a web page or an older app sign-in).
//! The current session is never signed out here. Signing out a session on
//! another device needs a confirmed current device, like every other device
//! management action.

use super::*;
use crate::auth::app_sign_in::tokens::{
    list_active_sign_ins, revoke_sign_in_in_transaction, revoked_reason, sign_in_for_session,
};
use crate::auth::app_sign_in::AppClientRegistry;
use crate::auth::devices::device_display_identity;
use crate::auth::routes::device_operation_support::{
    confirm_reviewed_devices_now, require_confirmed_actor,
};

/// At most this many sessions of each kind are listed.
const MAX_LISTED_SESSIONS: i64 = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionSummary {
    id: String,
    /// `app` for an app or a registered installation, `web` for a browser.
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_name: Option<String>,
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sign_in_method: Option<String>,
    created_at: String,
    last_used_at: String,
    current: bool,
}

type DirectSessionRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
);

fn rfc3339(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| value.to_string())
}

/// Live sessions of the account, current first, then most recently used.
pub(super) async fn list_sessions(
    pool: &PgPool,
    registry: &AppClientRegistry,
    session: &CloudSession,
) -> Result<Vec<SessionSummary>, Box<Response>> {
    let current_sign_in = sign_in_for_session(pool, &session.token_id)
        .await
        .map_err(|_| server_error())?;
    let sign_ins = list_active_sign_ins(pool, &session.account_id)
        .await
        .map_err(|_| server_error())?;
    let direct: Vec<DirectSessionRow> = query_as(
        "SELECT token.token_id, token.device_id, device.device_name, device.device_platform, \
                device.device_key_algorithm, token.created_at, device.last_seen_at \
         FROM cloud_refresh_tokens token \
         JOIN cloud_devices device ON device.device_id = token.device_id \
         WHERE token.account_id = $1 AND token.app_sign_in_id IS NULL \
           AND token.revoked_at IS NULL AND token.expires_at > $2 \
           AND device.account_id = token.account_id AND device.revoked_at IS NULL \
         ORDER BY device.last_seen_at DESC, token.created_at DESC \
         LIMIT $3",
    )
    .bind(&session.account_id)
    .bind(Utc::now().to_rfc3339())
    .bind(MAX_LISTED_SESSIONS)
    .fetch_all(pool)
    .await
    .map_err(|_| server_error())?;

    let mut sessions: Vec<SessionSummary> = sign_ins
        .into_iter()
        .take(MAX_LISTED_SESSIONS as usize)
        .map(|sign_in| {
            let (device_name, sign_in_method) = device_display_identity(sign_in.device_name);
            SessionSummary {
                current: current_sign_in.as_deref() == Some(sign_in.sign_in_id.as_str()),
                kind: "app",
                app_name: registry
                    .client(&sign_in.client_id)
                    .map(|client| client.name.clone()),
                id: sign_in.sign_in_id,
                client_id: Some(sign_in.client_id),
                device_id: sign_in.device_id,
                device_name,
                platform: sign_in.device_platform,
                sign_in_method,
                created_at: sign_in.created_at.to_rfc3339(),
                last_used_at: sign_in.last_refreshed_at.to_rfc3339(),
            }
        })
        .collect();
    sessions.extend(direct.into_iter().map(
        |(token_id, device_id, name, platform, key_algorithm, created_at, last_seen_at)| {
            let (device_name, sign_in_method) = device_display_identity(name);
            // Web pages sign in without registering an installation key.
            let web = key_algorithm == "legacy" && platform.is_none();
            SessionSummary {
                current: token_id == session.token_id,
                id: token_id,
                kind: if web { "web" } else { "app" },
                client_id: None,
                app_name: None,
                device_id,
                device_name,
                platform,
                sign_in_method,
                created_at: rfc3339(&created_at),
                last_used_at: rfc3339(&last_seen_at),
            }
        },
    ));
    sessions.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then_with(|| b.last_used_at.cmp(&a.last_used_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(sessions)
}

/// Revokes every other session and app sign-in of the account. The
/// current session and the sign-in it belongs to stay.
pub(super) async fn revoke_other_sessions_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    session: &CloudSession,
    reason: &str,
) -> Result<u64, sqlx_core::Error> {
    let current_sign_in: Option<(Option<String>,)> =
        query_as("SELECT app_sign_in_id FROM cloud_refresh_tokens WHERE token_id = $1")
            .bind(&session.token_id)
            .fetch_optional(&mut **tx)
            .await?;
    let current_sign_in = current_sign_in.and_then(|(id,)| id);
    let sign_ins: Vec<(String,)> = query_as(
        "SELECT sign_in_id FROM cloud_app_sign_ins \
         WHERE account_id = $1 AND revoked_at IS NULL AND sign_in_id IS DISTINCT FROM $2 \
         FOR UPDATE",
    )
    .bind(&session.account_id)
    .bind(current_sign_in.as_deref())
    .fetch_all(&mut **tx)
    .await?;
    let mut revoked = 0;
    for (sign_in_id,) in sign_ins {
        if revoke_sign_in_in_transaction(tx, &sign_in_id, reason).await? {
            revoked += 1;
        }
    }
    revoked += query(
        "UPDATE cloud_refresh_tokens SET revoked_at = $1 \
         WHERE account_id = $2 AND token_id <> $3 AND app_sign_in_id IS NULL \
           AND revoked_at IS NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(&session.account_id)
    .bind(&session.token_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();
    Ok(revoked)
}

fn cannot_revoke_current() -> Response {
    err(
        "cannot_revoke_current_session",
        "Use Sign out to end this session.",
        StatusCode::BAD_REQUEST,
    )
}

fn session_not_found() -> Response {
    err(
        "session_not_found",
        "That session was not found.",
        StatusCode::NOT_FOUND,
    )
}

/// The device of a live session or sign-in the account owns.
async fn session_device(
    pool: &PgPool,
    account_id: &str,
    id: &str,
) -> Result<Option<String>, Box<Response>> {
    let sql = if id.starts_with("asi_") {
        "SELECT device_id FROM cloud_app_sign_ins \
         WHERE sign_in_id = $1 AND account_id = $2 AND revoked_at IS NULL"
    } else if id.starts_with("cs_") {
        "SELECT device_id FROM cloud_refresh_tokens \
         WHERE token_id = $1 AND account_id = $2 AND app_sign_in_id IS NULL \
           AND revoked_at IS NULL"
    } else {
        return Ok(None);
    };
    let row: Option<(String,)> = query_as(sql)
        .bind(id)
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| server_error())?;
    Ok(row.map(|(device_id,)| device_id))
}

/// `POST /v1/cloud/account/security/sessions/:session_id/revoke`
pub(super) async fn revoke_session_by_id(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change().await {
        return *response;
    }
    let pool = caller.pool();
    let current_sign_in = match sign_in_for_session(pool, &session.token_id).await {
        Ok(value) => value,
        Err(_) => return *server_error(),
    };
    if id == session.token_id || current_sign_in.as_deref() == Some(id.as_str()) {
        return cannot_revoke_current();
    }
    let device_id = match session_device(pool, &session.account_id, &id).await {
        Ok(Some(device_id)) => device_id,
        Ok(None) => return session_not_found(),
        Err(response) => return *response,
    };
    let other_device = device_id != session.device_id;
    if other_device {
        if let Err(response) = confirm_reviewed_devices_now(&state, &session.account_id).await {
            return *response;
        }
    }
    let Ok(mut tx) = pool.begin().await else {
        return *server_error();
    };
    if other_device {
        if let Err(response) = require_confirmed_actor(&mut tx, &session).await {
            return *response;
        }
    }
    let revoked = if id.starts_with("asi_") {
        revoke_sign_in_in_transaction(&mut tx, &id, revoked_reason::USER_REVOKED).await
    } else {
        query(
            "UPDATE cloud_refresh_tokens SET revoked_at = $1 \
             WHERE token_id = $2 AND account_id = $3 AND revoked_at IS NULL",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(&id)
        .bind(&session.account_id)
        .execute(&mut *tx)
        .await
        .map(|result| result.rows_affected() > 0)
    };
    match revoked {
        Ok(true) => {}
        Ok(false) => return session_not_found(),
        Err(_) => return *server_error(),
    }
    if let Err(response) = audit_in_transaction(
        &mut tx,
        &session,
        "account.session.revoked",
        serde_json::json!({ "sessionId": id, "deviceId": device_id }),
    )
    .await
    {
        return *response;
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    StatusCode::NO_CONTENT.into_response()
}

/// `POST /v1/cloud/account/security/sessions/revoke-others`: revoke every
/// other device through the device revocation path, which also ends their
/// sign-ins and live connections, then every other session on this device.
pub(super) async fn revoke_other_sessions(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change().await {
        return *response;
    }
    let devices = super::super::device_handlers::revoke_devices(
        state.clone(),
        session.clone(),
        uuid::Uuid::new_v4(),
        None,
    )
    .await;
    if !devices.status().is_success() {
        return devices;
    }
    let revoked_devices = match axum::body::to_bytes(devices.into_body(), 1 << 20).await {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|value| value["affectedDeviceIds"].as_array().map(Vec::len))
            .unwrap_or_default(),
        Err(_) => 0,
    };
    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    let revoked_sessions =
        match revoke_other_sessions_in_transaction(&mut tx, &session, revoked_reason::USER_REVOKED)
            .await
        {
            Ok(count) => count,
            Err(_) => return *server_error(),
        };
    if let Err(response) = audit_in_transaction(
        &mut tx,
        &session,
        "account.sessions.revoked_others",
        serde_json::json!({
            "revokedDevices": revoked_devices,
            "revokedSessions": revoked_sessions,
        }),
    )
    .await
    {
        return *response;
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    Json(serde_json::json!({
        "revokedDevices": revoked_devices,
        "revokedSessions": revoked_sessions,
    }))
    .into_response()
}
