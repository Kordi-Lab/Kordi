//! The approval page endpoints. Both need the web session cookie, the exact
//! public `Origin`, and the CSRF header, like the browser sign-in page.

use super::*;
use crate::auth::device_code::{decide, find_pending, normalize_user_code, APPROVAL_WARNING};

/// Codes one signed-in account may look up. A typo costs one attempt, and
/// guessing the 2^32 code space is out of reach.
const LOOKUP_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "device-code-lookup",
    limit: 10,
    window: std::time::Duration::from_secs(10 * 60),
};

/// Decisions one signed-in account may record.
const DECISION_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "device-code-decision",
    limit: 10,
    window: std::time::Duration::from_secs(10 * 60),
};

#[derive(Debug, Deserialize)]
pub(in crate::auth::routes) struct UserCodeRequest {
    #[serde(rename = "userCode")]
    user_code: String,
    #[serde(default)]
    decision: Option<String>,
}

fn invalid_user_code() -> Response {
    oauth_error(
        StatusCode::NOT_FOUND,
        "invalid_user_code",
        "This code is not valid or has expired. Check it and try again.",
    )
}

/// The shared checks of the approval page endpoints: same-origin web
/// session, per-address and per-account limits, and a well-formed code.
async fn page_request(
    state: &ServerState,
    rate_limiter: &CloudRateLimiter,
    headers: &HeaderMap,
    peer_ip: Option<IpAddr>,
    limit: AccountActionLimit,
    user_code: &str,
) -> Result<(CloudSession, String), Response> {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
        return Err(limited_response(retry_after));
    }
    let session = authenticated_web_session(state, headers)
        .await
        .map_err(|response| *response)?;
    if let Some(limited) = observe(rate_limiter, limit, &session.account_id).await {
        return Err(limited);
    }
    let code = normalize_user_code(user_code).ok_or_else(invalid_user_code)?;
    Ok((session, code))
}

/// `POST /v1/cloud/auth/device/lookup`: the device behind a typed code, for
/// the approval page.
pub(in crate::auth::routes) async fn device_lookup(
    State(state): State<Arc<ServerState>>,
    Extension(registry): Extension<Arc<AppClientRegistry>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(request): Json<UserCodeRequest>,
) -> Response {
    let peer_ip = client_ip(&headers, connect_info.as_ref());
    let (_, code) = match page_request(
        &state,
        &rate_limiter,
        &headers,
        peer_ip,
        LOOKUP_LIMIT,
        &request.user_code,
    )
    .await
    {
        Ok(checked) => checked,
        Err(response) => return response,
    };
    let pending = match find_pending(state.db_pool(), &code).await {
        Ok(Some(pending)) => pending,
        Ok(None) => return invalid_user_code(),
        Err(_) => return token_server_error(),
    };
    let details = pending.details;
    no_store(
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "appName": registry.client(&pending.client_id).map(|client| client.name.clone()),
                "deviceName": details.device_name,
                "platform": details.device_platform,
                "osVersion": details.device_os_version,
                "appVersion": details.device_app_version,
                "ipAddress": details.requester_ip,
                "approximateLocation": details.approximate_location,
                "requestedAt": pending.created_at.to_rfc3339(),
                "expiresAt": pending.expires_at.to_rfc3339(),
                "warning": APPROVAL_WARNING,
            })),
        )
            .into_response(),
    )
}

/// `POST /v1/cloud/auth/device/decision`: `{"userCode", "decision":
/// "approve" | "deny"}` from the approval page.
pub(in crate::auth::routes) async fn device_decision(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(request): Json<UserCodeRequest>,
) -> Response {
    let peer_ip = client_ip(&headers, connect_info.as_ref());
    let approve = match request.decision.as_deref() {
        Some("approve") => true,
        Some("deny") => false,
        _ => {
            return oauth_error(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "decision must be approve or deny.",
            )
        }
    };
    let (session, code) = match page_request(
        &state,
        &rate_limiter,
        &headers,
        peer_ip,
        DECISION_LIMIT,
        &request.user_code,
    )
    .await
    {
        Ok(checked) => checked,
        Err(response) => return response,
    };
    let pool = state.db_pool();
    let blocked_by = if approve {
        match device_code_sign_in_blocked_by(pool, &session.account_id).await {
            Ok(blocked_by) => blocked_by,
            Err(_) => return token_server_error(),
        }
    } else {
        None
    };
    let denied = blocked_by
        .as_ref()
        .map(|_| denied_reason::ORGANIZATION_POLICY);
    let approved = approve && blocked_by.is_none();
    match decide(pool, &code, &session.account_id, approved, denied).await {
        Ok(true) => {}
        Ok(false) => return invalid_user_code(),
        Err(_) => return token_server_error(),
    }
    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        if approved {
            "auth.device_code.approved"
        } else {
            "auth.device_code.denied"
        },
        serde_json::json!({
            "reason": denied.unwrap_or(if approved { "" } else { denied_reason::USER_DENIED }),
            "ip": peer_ip.map(|ip| ip.to_string()),
        }),
    )
    .await;
    if let Some(organization) = blocked_by {
        return oauth_error(
            StatusCode::FORBIDDEN,
            "device_code_not_allowed",
            &format!(
                "{organization} does not allow sign-in with a code. Sign in with a browser on that device instead."
            ),
        );
    }
    no_store(
        (
            StatusCode::OK,
            Json(serde_json::json!({ "status": if approved { "approved" } else { "denied" } })),
        )
            .into_response(),
    )
}
