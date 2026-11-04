//! The signed-in apps of an account: list and revoke one.

use super::*;
use crate::auth::app_sign_in::tokens::{
    list_active_sign_ins, revoke_account_sign_in, sign_in_for_session,
};
use crate::auth::devices::device_display_identity;

#[derive(Debug, Serialize)]
struct AppSignInSummary {
    #[serde(rename = "signInId")]
    sign_in_id: String,
    #[serde(rename = "clientId")]
    client_id: String,
    #[serde(rename = "appName", skip_serializing_if = "Option::is_none")]
    app_name: Option<String>,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "deviceName", skip_serializing_if = "Option::is_none")]
    device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "lastActiveAt")]
    last_active_at: String,
    current: bool,
}

/// `GET /v1/cloud/auth/app/sign-ins`
pub(in crate::auth::routes) async fn list_app_sign_ins(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    let (sign_ins, current) = match tokio::try_join!(
        list_active_sign_ins(pool, &session.account_id),
        sign_in_for_session(pool, &session.token_id),
    ) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not load signed-in apps.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let summaries: Vec<AppSignInSummary> = sign_ins
        .into_iter()
        .map(|sign_in| {
            let (device_name, _) = device_display_identity(sign_in.device_name);
            AppSignInSummary {
                current: current.as_deref() == Some(sign_in.sign_in_id.as_str()),
                app_name: registry
                    .client(&sign_in.client_id)
                    .map(|client| client.name.clone()),
                sign_in_id: sign_in.sign_in_id,
                client_id: sign_in.client_id,
                device_id: sign_in.device_id,
                device_name,
                platform: sign_in.device_platform,
                created_at: sign_in.created_at.to_rfc3339(),
                last_active_at: sign_in.last_refreshed_at.to_rfc3339(),
            }
        })
        .collect();
    (
        StatusCode::OK,
        Json(serde_json::json!({ "signIns": summaries })),
    )
        .into_response()
}

/// `DELETE /v1/cloud/auth/app/sign-ins/:sign_in_id`
pub(in crate::auth::routes) async fn revoke_app_sign_in(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(sign_in_id): axum::extract::Path<String>,
) -> Response {
    let pool = state.db_pool();
    match revoke_account_sign_in(pool, &session.account_id, &sign_in_id).await {
        Ok(true) => {
            let _ = write_audit(
                pool,
                Some(&session.account_id),
                Some(&session.device_id),
                "auth.app_sign_in.revoked",
                serde_json::json!({ "signInId": sign_in_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => err(
            "not_found",
            "That sign-in was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => err(
            "server_error",
            "Could not revoke the sign-in.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
