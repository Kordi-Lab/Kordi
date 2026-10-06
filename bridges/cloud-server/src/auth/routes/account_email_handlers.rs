//! `POST /v1/cloud/auth/email/verification/code` and
//! `POST /v1/cloud/auth/email/verification`: the signed-in account proves it
//! can read its primary email.

use crate::auth::account_email::{
    send_account_email_code, verify_account_email, AccountEmailError,
};
use crate::auth::rate_limit::EMAIL_VERIFICATION_LIMIT;

use super::signup_email_handlers::signup_code_error;
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountEmailVerificationRequest {
    verification_id: String,
    verification_code: String,
}

/// Charges the client address and the account before any code work.
async fn observe_limits(
    rate_limiter: &CloudRateLimiter,
    session: &CloudSession,
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<SocketAddr>>,
) -> Option<Response> {
    for decision in [
        rate_limiter
            .observe_ip(client_ip(headers, connect_info))
            .await,
        rate_limiter
            .observe_account_limit(EMAIL_VERIFICATION_LIMIT, &session.account_id)
            .await,
    ] {
        if let RateLimitDecision::Limited { retry_after } = decision {
            return Some(limited_response(retry_after));
        }
    }
    None
}

fn account_email_error(error: AccountEmailError) -> Response {
    match error {
        AccountEmailError::Missing => err(
            "email_missing",
            "This account has no email address to verify.",
            StatusCode::BAD_REQUEST,
        ),
        AccountEmailError::AlreadyVerified => err(
            "email_already_verified",
            "This account's email is already verified.",
            StatusCode::CONFLICT,
        ),
        AccountEmailError::Code(error) => signup_code_error(error),
    }
}

pub(super) async fn send_account_email_verification_code(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) =
        observe_limits(&rate_limiter, &session, &headers, connect_info.as_ref()).await
    {
        return limited;
    }
    match send_account_email_code(state.db_pool(), state.signup_email(), &session.account_id).await
    {
        Ok(challenge) => (StatusCode::OK, Json(challenge)).into_response(),
        Err(error) => account_email_error(error),
    }
}

pub(super) async fn verify_account_email_code(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(req): Json<AccountEmailVerificationRequest>,
) -> Response {
    if let Some(limited) =
        observe_limits(&rate_limiter, &session, &headers, connect_info.as_ref()).await
    {
        return limited;
    }
    if let Err(error) = verify_account_email(
        state.db_pool(),
        state.signup_email(),
        &session.account_id,
        &req.verification_id,
        &req.verification_code,
    )
    .await
    {
        return account_email_error(error);
    }
    let _ = write_audit(
        state.db_pool(),
        Some(&session.account_id),
        Some(&session.device_id),
        "account.email_verified",
        serde_json::json!({}),
    )
    .await;
    StatusCode::NO_CONTENT.into_response()
}
