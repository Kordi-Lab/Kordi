//! Token and revocation endpoints for browser sign-in.

use super::*;
use crate::auth::app_sign_in::codes::{
    link_code_to_sign_in, present_code, verifier_matches_challenge,
};
use crate::auth::app_sign_in::tokens::{
    revoke_sign_in, revoke_sign_in_in_transaction, revoked_reason, rotate_refresh_token,
    sign_in_for_token, start_sign_in,
};
use crate::auth::app_sign_in::{IssuedTokens, RefreshOutcome};

/// Placeholder device name for a browser sign-in without device details.
/// It follows the `oauth-<method>-device` pattern so later metadata updates
/// may replace it.
const BROWSER_PLACEHOLDER_DEVICE_NAME: &str = "oauth-browser-device";

#[derive(Debug, Default, Deserialize)]
pub(super) struct TokenRequest {
    grant_type: Option<String>,
    client_id: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    device_public_key: Option<String>,
    device_key_algorithm: Option<String>,
    device_name: Option<String>,
    device_platform: Option<String>,
    device_os_version: Option<String>,
    device_app_version: Option<String>,
}

#[derive(Debug, Serialize)]
struct TokenResponse {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    refresh_token: String,
    refresh_token_expires_in: i64,
    device_id: String,
    sign_in_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<AccountResponse>,
}

fn token_response(issued: IssuedTokens, account: Option<AccountResponse>) -> Response {
    let now = Utc::now();
    let body = TokenResponse {
        access_token: issued.access_token,
        token_type: "Bearer",
        expires_in: (issued.access_expires_at - now).num_seconds().max(0),
        refresh_token: issued.refresh_token,
        refresh_token_expires_in: (issued.refresh_expires_at - now).num_seconds().max(0),
        device_id: issued.device_id,
        sign_in_id: issued.sign_in_id,
        account,
    };
    no_store((StatusCode::OK, Json(body)).into_response())
}

fn invalid_grant(description: &str) -> Response {
    oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", description)
}

fn server_error() -> Response {
    oauth_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "server_error",
        "Could not complete sign-in.",
    )
}

/// `POST /v1/cloud/auth/app/token`: `authorization_code` and
/// `refresh_token` grants for registered public clients.
pub(in crate::auth::routes) async fn app_token(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let peer_ip = client_ip(&headers, connect_info.as_ref());
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
        return limited_response(retry_after);
    }
    let request: TokenRequest = match parse_form_or_json(&headers, &body) {
        Ok(request) => request,
        Err(_) => {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "The token request is malformed.",
            );
        }
    };
    let Some(client_id) = request
        .client_id
        .as_deref()
        .and_then(|client_id| registry.client(client_id))
        .map(|client| client.client_id.clone())
    else {
        return oauth_error(
            StatusCode::UNAUTHORIZED,
            "invalid_client",
            "This app is not registered for browser sign-in.",
        );
    };
    match request.grant_type.as_deref() {
        Some("authorization_code") => exchange_code(&state, &client_id, &request, peer_ip).await,
        Some("refresh_token") => refresh(&state, &client_id, &request).await,
        _ => oauth_error(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "Use the authorization_code or refresh_token grant.",
        ),
    }
}

fn device_registration(
    request: &TokenRequest,
) -> Result<NormalizedDeviceRegistration, &'static str> {
    let Some(public_key) = request.device_public_key.clone() else {
        return Ok(legacy_device_registration(BROWSER_PLACEHOLDER_DEVICE_NAME));
    };
    normalize_device_registration(DeviceRegistrationRequest {
        display_name: request.device_name.clone(),
        platform: request.device_platform.clone(),
        os_version: request.device_os_version.clone(),
        app_version: request.device_app_version.clone(),
        approximate_location: None,
        public_key,
        key_algorithm: request.device_key_algorithm.clone().unwrap_or_default(),
    })
    .map_err(|error| error.message())
}

async fn exchange_code(
    state: &ServerState,
    client_id: &str,
    request: &TokenRequest,
    peer_ip: Option<IpAddr>,
) -> Response {
    let (Some(code), Some(redirect_uri), Some(verifier)) = (
        request.code.as_deref(),
        request.redirect_uri.as_deref(),
        request.code_verifier.as_deref(),
    ) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "code, redirect_uri and code_verifier are required.",
        );
    };
    let registration = match device_registration(request) {
        Ok(registration) => registration,
        Err(message) => return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", message),
    };
    let pool = state.db_pool();
    let Ok(mut tx) = pool.begin().await else {
        return server_error();
    };
    let presented = match present_code(&mut tx, code).await {
        Ok(Some(presented)) => presented,
        Ok(None) => return invalid_grant("The authorization code is invalid."),
        Err(_) => return server_error(),
    };
    if presented.already_used {
        // RFC 6749, section 4.1.2: revoke what the first exchange issued.
        if let Some(sign_in_id) = presented.sign_in_id.as_deref() {
            if revoke_sign_in_in_transaction(
                &mut tx,
                sign_in_id,
                revoked_reason::AUTHORIZATION_CODE_REUSE,
            )
            .await
            .is_err()
            {
                return server_error();
            }
        }
        return match tx.commit().await {
            Ok(()) => invalid_grant("The authorization code was already used."),
            Err(_) => server_error(),
        };
    }
    let rejection = if presented.client_id != client_id {
        Some("The authorization code was issued to another app.")
    } else if presented.redirect_uri != redirect_uri {
        Some("The redirect URI does not match the authorization request.")
    } else if presented.expires_at <= Utc::now() {
        Some("The authorization code has expired.")
    } else if !verifier_matches_challenge(verifier, &presented.code_challenge) {
        Some("The code verifier does not match.")
    } else {
        None
    };
    if let Some(description) = rejection {
        // Keep the code consumed so it cannot be retried.
        return match tx.commit().await {
            Ok(()) => invalid_grant(description),
            Err(_) => server_error(),
        };
    }
    let account_id = presented.account_id;
    if let Err(error) = state.admission().authorize_account(pool, &account_id).await {
        let _ = tx.commit().await;
        return error.response();
    }
    let Ok(device) = authorize_device(&mut tx, &account_id, &registration, "pending_review").await
    else {
        return server_error();
    };
    let Ok(issued) = start_sign_in(&mut tx, &account_id, &device.device_id, client_id).await else {
        return server_error();
    };
    if link_code_to_sign_in(&mut tx, code, &issued.sign_in_id)
        .await
        .is_err()
    {
        return server_error();
    }
    let audit = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, 'auth.app_sign_in.success', $4, $5)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(&account_id)
    .bind(&device.device_id)
    .bind(
        serde_json::json!({
            "clientId": client_id,
            "signInId": issued.sign_in_id,
            "ip": peer_ip.map(|ip| ip.to_string()),
        })
        .to_string(),
    )
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await;
    if audit.is_err() {
        return server_error();
    }
    if device.is_new_authorization
        && append_device_sync_event(
            &mut tx,
            &account_id,
            "device.added",
            &device.device_id,
            registration.display_name.as_deref(),
            "pending_review",
        )
        .await
        .is_err()
    {
        return server_error();
    }
    if tx.commit().await.is_err() {
        return server_error();
    }
    if device.is_new_authorization {
        let events = state.events().clone();
        let account_id = account_id.clone();
        let device_id = device.device_id.clone();
        tokio::spawn(async move {
            events
                .publish_device_event(&account_id, "added", &device_id)
                .await;
        });
    }
    let account = owner_account_response_row(pool, &account_id)
        .await
        .ok()
        .flatten();
    token_response(issued, account)
}

async fn refresh(state: &ServerState, client_id: &str, request: &TokenRequest) -> Response {
    let Some(refresh_token) = request.refresh_token.as_deref() else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "refresh_token is required.",
        );
    };
    let pool = state.db_pool();
    match rotate_refresh_token(pool, client_id, refresh_token).await {
        Ok(RefreshOutcome::Issued(issued)) => {
            if let Err(error) = state
                .admission()
                .authorize_account(pool, &issued.account_id)
                .await
            {
                let _ = revoke_sign_in(
                    pool,
                    &issued.sign_in_id,
                    revoked_reason::ACCOUNT_NOT_ADMITTED,
                )
                .await;
                return error.response();
            }
            token_response(issued, None)
        }
        Ok(RefreshOutcome::Invalid) => invalid_grant("The refresh token is invalid or expired."),
        Ok(RefreshOutcome::ReuseDetected { account_id }) => {
            let _ = write_audit(
                pool,
                Some(&account_id),
                None,
                "auth.app_sign_in.refresh_reuse",
                serde_json::json!({ "clientId": client_id }),
            )
            .await;
            invalid_grant("The refresh token was already used. Sign in again.")
        }
        Err(_) => server_error(),
    }
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct RevokeRequest {
    token: Option<String>,
    #[allow(dead_code)]
    token_type_hint: Option<String>,
    client_id: Option<String>,
}

/// `POST /v1/cloud/auth/app/revoke` (RFC 7009): sign the app out by
/// revoking the sign-in behind a refresh token or access token. Unknown
/// tokens succeed without effect, as the RFC requires.
pub(in crate::auth::routes) async fn revoke_app_token(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let peer_ip = client_ip(&headers, connect_info.as_ref());
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
        return limited_response(retry_after);
    }
    let Ok(request) = parse_form_or_json::<RevokeRequest>(&headers, &body) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "The revocation request is malformed.",
        );
    };
    let Some(client_id) = request
        .client_id
        .as_deref()
        .filter(|client_id| registry.client(client_id).is_some())
    else {
        return oauth_error(
            StatusCode::UNAUTHORIZED,
            "invalid_client",
            "This app is not registered for browser sign-in.",
        );
    };
    let Some(token) = request.token.as_deref().filter(|token| !token.is_empty()) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "token is required.",
        );
    };
    let pool = state.db_pool();
    match sign_in_for_token(pool, token).await {
        Ok(Some((sign_in_id, owner_client_id))) if owner_client_id == client_id => {
            if revoke_sign_in(pool, &sign_in_id, revoked_reason::SIGN_OUT)
                .await
                .is_err()
            {
                return server_error();
            }
        }
        Ok(_) => {}
        Err(_) => return server_error(),
    }
    no_store((StatusCode::OK, Json(serde_json::json!({}))).into_response())
}
