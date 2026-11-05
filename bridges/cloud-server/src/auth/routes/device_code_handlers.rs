//! HTTP endpoints for device code sign-in (RFC 8628). The contract is
//! documented in `docs/development/device-code-sign-in.md`.
//!
//! - `POST /v1/cloud/auth/device/code`: the device asks for a code pair.
//! - `POST /v1/cloud/auth/device/token`: the device polls.
//! - `POST /v1/cloud/auth/device/lookup` and `/decision`: the approval page,
//!   with the web session cookie, shows the device and records the decision.
//! - `GET /device`: the approval page itself.

use super::app_sign_in_handlers::{
    begin_sign_in, finish_sign_in, invalid_grant, no_store, oauth_error, parse_form_or_json,
    server_error as token_server_error,
};
use super::*;
use crate::auth::app_sign_in::tokens::revoke_sign_in_in_transaction;
use crate::auth::app_sign_in::AppClientRegistry;
use crate::auth::device_code::{
    denied_reason, deny_at_redemption, issue_device_code, link_sign_in, poll, DeviceDetails,
    PollOutcome, DEVICE_CODE_GRANT_TYPE, DEVICE_CODE_LIFETIME_SECS, VERIFICATION_PATH,
};
use crate::auth::devices::DeviceMetadataUpdateRequest;
use crate::auth::rate_limit::{rate_limit_client_key, AccountActionLimit};
use crate::organizations::device_code_sign_in_blocked_by;

mod approval;
mod page;

pub(super) use approval::{device_decision, device_lookup};
pub(super) use page::{device_page, device_page_asset};

/// Placeholder device name for a device code sign-in without a reported
/// name. It follows the `oauth-<method>-device` pattern.
const DEVICE_CODE_PLACEHOLDER_DEVICE_NAME: &str = "oauth-device-code-device";
const DEVICE_CODE_REUSE: &str = "device_code_reuse";

/// Code pairs one client address may request.
const CODE_REQUEST_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "device-code-request",
    limit: 10,
    window: std::time::Duration::from_secs(10 * 60),
};

/// Polls from one client address across every code. Twelve devices polling
/// every five seconds fit; a flood does not.
const POLL_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "device-code-poll",
    limit: 150,
    window: std::time::Duration::from_secs(60),
};

pub(super) async fn observe(
    rate_limiter: &CloudRateLimiter,
    limit: AccountActionLimit,
    key: &str,
) -> Option<Response> {
    match rate_limiter.observe_account_limit(limit, key).await {
        RateLimitDecision::Limited { retry_after } => Some(limited_response(retry_after)),
        RateLimitDecision::Allowed => None,
    }
}

fn address_key(peer_ip: Option<IpAddr>) -> String {
    rate_limit_client_key(peer_ip).to_string()
}

/// The registered app behind `client_id`, if it may use device codes.
fn device_code_client(registry: &AppClientRegistry, client_id: Option<&str>) -> Option<String> {
    client_id
        .and_then(|client_id| registry.client(client_id))
        .filter(|client| client.device_code)
        .map(|client| client.client_id.clone())
}

fn invalid_client() -> Response {
    oauth_error(
        StatusCode::UNAUTHORIZED,
        "invalid_client",
        "This app cannot sign in with a code.",
    )
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct DeviceCodeRequest {
    client_id: Option<String>,
    #[allow(dead_code)]
    scope: Option<String>,
    device_name: Option<String>,
    device_platform: Option<String>,
    device_os_version: Option<String>,
    device_app_version: Option<String>,
    device_public_key: Option<String>,
    device_key_algorithm: Option<String>,
}

/// Validate what the device reported. A public key must be valid now, so a
/// bad key fails before anyone approves the code.
fn reported_details(request: &DeviceCodeRequest) -> Result<DeviceDetails, &'static str> {
    if let Some(public_key) = request.device_public_key.clone() {
        let registration = normalize_device_registration(DeviceRegistrationRequest {
            display_name: request.device_name.clone(),
            platform: request.device_platform.clone(),
            os_version: request.device_os_version.clone(),
            app_version: request.device_app_version.clone(),
            approximate_location: None,
            public_key,
            key_algorithm: request.device_key_algorithm.clone().unwrap_or_default(),
        })
        .map_err(|error| error.message())?;
        return Ok(DeviceDetails {
            device_name: registration.display_name,
            device_platform: registration.platform,
            device_os_version: registration.os_version,
            device_app_version: registration.app_version,
            device_public_key: Some(registration.public_key),
            device_key_algorithm: Some(registration.key_algorithm),
            ..DeviceDetails::default()
        });
    }
    let metadata = normalize_device_metadata(DeviceMetadataUpdateRequest {
        display_name: request.device_name.clone(),
        platform: request.device_platform.clone(),
        os_version: request.device_os_version.clone(),
        app_version: request.device_app_version.clone(),
        approximate_location: None,
        machine_id: None,
    });
    Ok(DeviceDetails {
        device_name: metadata.display_name,
        device_platform: metadata.platform,
        device_os_version: metadata.os_version,
        device_app_version: metadata.app_version,
        ..DeviceDetails::default()
    })
}

/// `POST /v1/cloud/auth/device/code` (RFC 8628, section 3.1).
pub(super) async fn device_code_request(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let peer = connect_info.as_ref().map(|info| info.0.ip());
    let peer_ip = client_ip(&headers, connect_info.as_ref());
    if let Some(limited) = observe(&rate_limiter, CODE_REQUEST_LIMIT, &address_key(peer_ip)).await {
        return limited;
    }
    let Ok(request) = parse_form_or_json::<DeviceCodeRequest>(&headers, &body) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "The device code request is malformed.",
        );
    };
    let Some(client_id) = device_code_client(&registry, request.client_id.as_deref()) else {
        return invalid_client();
    };
    let mut details = match reported_details(&request) {
        Ok(details) => details,
        Err(message) => return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", message),
    };
    details.requester_ip = peer_ip.map(|ip| ip.to_string());
    details.approximate_location = crate::client_ip::resolve_client_location(&headers, peer);
    let pool = state.db_pool();
    let issued = match issue_device_code(pool, &client_id, &details).await {
        Ok(issued) => issued,
        Err(_) => return token_server_error(),
    };
    let _ = write_audit(
        pool,
        None,
        None,
        "auth.device_code.issued",
        serde_json::json!({ "clientId": client_id, "ip": details.requester_ip }),
    )
    .await;
    no_store(
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "device_code": issued.device_code,
                "user_code": issued.user_code,
                "verification_uri": format!(
                    "{}{VERIFICATION_PATH}",
                    crate::distribution::public_origin()
                ),
                "expires_in": DEVICE_CODE_LIFETIME_SECS,
                "interval": issued.interval_secs,
            })),
        )
            .into_response(),
    )
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct DeviceTokenRequest {
    grant_type: Option<String>,
    client_id: Option<String>,
    device_code: Option<String>,
}

/// An RFC 8628 polling error with optional extra fields.
fn poll_error(error: &'static str, description: &str, extra: serde_json::Value) -> Response {
    let mut body = serde_json::json!({
        "error": error,
        "error_description": description,
        "errorCode": error,
        "message": description,
    });
    if let (Some(body), serde_json::Value::Object(extra)) = (body.as_object_mut(), extra) {
        body.extend(extra);
    }
    no_store((StatusCode::BAD_REQUEST, Json(body)).into_response())
}

fn denied_description(reason: &str) -> &'static str {
    match reason {
        denied_reason::ORGANIZATION_POLICY => {
            "Your organization does not allow sign-in with a code. Sign in with a browser instead."
        }
        denied_reason::ACCOUNT_NOT_ADMITTED => "This account cannot sign in to this server.",
        _ => "The sign-in was denied.",
    }
}

fn access_denied(reason: &str) -> Response {
    poll_error(
        "access_denied",
        denied_description(reason),
        serde_json::json!({ "reason": reason }),
    )
}

fn registration_for(details: &DeviceDetails) -> NormalizedDeviceRegistration {
    let mut registration = match (&details.device_public_key, &details.device_key_algorithm) {
        (Some(public_key), Some(key_algorithm)) => NormalizedDeviceRegistration {
            display_name: None,
            platform: None,
            os_version: None,
            app_version: None,
            approximate_location: None,
            public_key: public_key.clone(),
            key_algorithm: key_algorithm.clone(),
        },
        _ => legacy_device_registration(DEVICE_CODE_PLACEHOLDER_DEVICE_NAME),
    };
    if details.device_name.is_some() {
        registration.display_name = details.device_name.clone();
    }
    registration.platform = details.device_platform.clone();
    registration.os_version = details.device_os_version.clone();
    registration.app_version = details.device_app_version.clone();
    registration.approximate_location = details.approximate_location.clone();
    registration
}

/// `POST /v1/cloud/auth/device/token` (RFC 8628, section 3.4): the device
/// polls until the person approves, denies, or the code expires.
pub(super) async fn device_token(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let peer_ip = client_ip(&headers, connect_info.as_ref());
    if let Some(limited) = observe(&rate_limiter, POLL_LIMIT, &address_key(peer_ip)).await {
        return limited;
    }
    let Ok(request) = parse_form_or_json::<DeviceTokenRequest>(&headers, &body) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "The token request is malformed.",
        );
    };
    let Some(client_id) = device_code_client(&registry, request.client_id.as_deref()) else {
        return invalid_client();
    };
    if request.grant_type.as_deref() != Some(DEVICE_CODE_GRANT_TYPE) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "unsupported_grant_type",
            "Use the device_code grant.",
        );
    }
    let Some(device_code) = request.device_code.as_deref().filter(|c| !c.is_empty()) else {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "device_code is required.",
        );
    };
    let pool = state.db_pool();
    let Ok(mut tx) = pool.begin().await else {
        return token_server_error();
    };
    let outcome = match poll(&mut tx, device_code, &client_id).await {
        Ok(outcome) => outcome,
        Err(_) => return token_server_error(),
    };
    let (account_id, details) = match outcome {
        PollOutcome::Approved {
            account_id,
            details,
        } => (account_id, details),
        PollOutcome::AlreadyUsed { sign_in_id } => {
            // Like a reused authorization code: revoke what the first
            // redemption issued.
            if let Some(sign_in_id) = sign_in_id.as_deref() {
                if revoke_sign_in_in_transaction(&mut tx, sign_in_id, DEVICE_CODE_REUSE)
                    .await
                    .is_err()
                {
                    return token_server_error();
                }
            }
            return match tx.commit().await {
                Ok(()) => invalid_grant("The device code was already used."),
                Err(_) => token_server_error(),
            };
        }
        other => {
            if tx.commit().await.is_err() {
                return token_server_error();
            }
            return match other {
                PollOutcome::Pending => poll_error(
                    "authorization_pending",
                    "Waiting for approval.",
                    serde_json::json!({}),
                ),
                PollOutcome::SlowDown { interval_secs } => poll_error(
                    "slow_down",
                    "Polling too often. Wait longer between requests.",
                    serde_json::json!({ "interval": interval_secs }),
                ),
                PollOutcome::Denied { reason } => access_denied(&reason),
                PollOutcome::Expired => poll_error(
                    "expired_token",
                    "The code expired. Start again.",
                    serde_json::json!({}),
                ),
                _ => invalid_grant("The device code is invalid."),
            };
        }
    };
    // The policy may have changed since the approval.
    match device_code_sign_in_blocked_by(pool, &account_id).await {
        Ok(None) => {}
        Ok(Some(_)) => {
            if deny_at_redemption(&mut tx, device_code, denied_reason::ORGANIZATION_POLICY)
                .await
                .is_err()
                || tx.commit().await.is_err()
            {
                return token_server_error();
            }
            return access_denied(denied_reason::ORGANIZATION_POLICY);
        }
        Err(_) => return token_server_error(),
    }
    if let Err(error) = state.admission().authorize_account(pool, &account_id).await {
        if deny_at_redemption(&mut tx, device_code, denied_reason::ACCOUNT_NOT_ADMITTED)
            .await
            .is_ok()
        {
            let _ = tx.commit().await;
        }
        return error.response();
    }
    let started = match begin_sign_in(
        &mut tx,
        &account_id,
        &registration_for(&details),
        &client_id,
        serde_json::json!({
            "ip": peer_ip.map(|ip| ip.to_string()),
            "method": "device_code",
        }),
    )
    .await
    {
        Ok(started) => started,
        Err(response) => return response,
    };
    if link_sign_in(&mut tx, device_code, &started.issued.sign_in_id)
        .await
        .is_err()
        || tx.commit().await.is_err()
    {
        return token_server_error();
    }
    finish_sign_in(&state, started, true).await
}
