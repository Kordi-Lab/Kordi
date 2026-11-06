//! Browser application API, organization, and realtime session boundaries.
use super::*;

pub(in crate::auth::routes) async fn cookie_session_middleware(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let reads = matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    let session = if reads {
        cookie_session(&state, &headers)
            .await
            .map(|(session, _)| session)
    } else {
        authenticated_web_session(&state, &headers).await
    };
    match session {
        Ok(session) => {
            use crate::organizations::requests::{load_for_session, RequestOrganization};
            match load_for_session(state.db_pool(), &session.token_id).await {
                Ok(Some(claim)) => {
                    RequestOrganization::attach(&mut req, &session.account_id, &claim, &headers)
                }
                Ok(None) => return *login_required(),
                Err(_) => {
                    return err(
                        "server_error",
                        "Could not validate session.",
                        StatusCode::INTERNAL_SERVER_ERROR,
                    )
                }
            }
            if let Some(organization) = req.extensions().get::<RequestOrganization>() {
                use crate::organizations::requests::Mismatch;
                if matches!(
                    organization.mismatch,
                    Some(Mismatch::Header { .. } | Mismatch::MembershipEnded { .. })
                ) {
                    return super::app_sign_in_handlers::no_store((
                        StatusCode::CONFLICT,
                        Json(serde_json::json!({
                            "errorCode": "organization_mismatch",
                            "message": "The browser organization changed. Retry in the selected organization.",
                            "organizationId": organization.organization_id,
                        })),
                    ).into_response());
                }
            }
            req.extensions_mut().insert(session);
            super::app_sign_in_handlers::no_store(next.run(req).await)
        }
        Err(response) => *response,
    }
}

pub(super) fn web_account_matches(headers: &HeaderMap, account_id: &str) -> bool {
    match headers.get(WEB_ACCOUNT_HEADER) {
        Some(value) => value.to_str().is_ok_and(|value| value == account_id),
        None => true,
    }
}

/// WebSockets cannot set a CSRF header. Exact Origin and a web-only cookie
/// prevent a cross-site page from opening an authenticated socket.
pub(crate) async fn web_socket_session(
    state: &ServerState,
    headers: &HeaderMap,
    expected_account: Option<&str>,
) -> Result<CloudSession, Box<Response>> {
    if !origin_is_public(headers) {
        return Err(origin_error());
    }
    let (session, _) = cookie_session(state, headers).await?;
    if expected_account.is_some_and(|account| account != session.account_id) {
        return Err(login_required());
    }
    Ok(session)
}

/// `GET /v1/cloud/auth/web/session`: the signed-in account and the CSRF
/// token, or `401 login_required`.
pub(in crate::auth::routes) async fn web_session_status(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Response {
    let (session, token) = match cookie_session(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let claim =
        match crate::organizations::requests::load_for_session(state.db_pool(), &session.token_id)
            .await
        {
            Ok(claim) => claim,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not restore session.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            }
        };
    let organization_id = claim.and_then(|claim| {
        if claim.claim_active {
            claim.claimed.or(claim.personal)
        } else {
            claim.personal
        }
    });
    match owner_account_response_row(state.db_pool(), &session.account_id).await {
        Ok(Some(account)) => super::app_sign_in_handlers::no_store(
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "account": account,
                    "csrfToken": web_csrf_token(&token),
                    "session": { "deviceId": session.device_id, "organizationId": organization_id },
                })),
            )
                .into_response(),
        ),
        _ => err(
            "server_error",
            "Could not load account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
