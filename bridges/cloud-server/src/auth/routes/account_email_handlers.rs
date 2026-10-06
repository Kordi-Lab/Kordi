//! `POST /v1/cloud/auth/email/verification/code` and
//! `POST /v1/cloud/auth/email/verification`: the signed-in account proves it
//! can read its primary email.

use crate::auth::account_email::{
    account_email_to_verify, send_account_email_code, verify_account_email, AccountEmailError,
};
use crate::auth::rate_limit::EMAIL_VERIFICATION_LIMIT;
use crate::auth::signup_email::{SignupCodeError, SignupEmailService};

use super::signup_email_handlers::signup_code_error;
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountEmailVerificationRequest {
    verification_id: String,
    verification_code: String,
}

/// Resolves the email to verify after the cheap checks, charging the client
/// address first and the account only for requests that will do code work.
async fn prepare<'state>(
    state: &'state ServerState,
    rate_limiter: &CloudRateLimiter,
    session: &CloudSession,
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<SocketAddr>>,
) -> Result<(&'state SignupEmailService, String), Response> {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(client_ip(headers, connect_info))
        .await
    {
        return Err(limited_response(retry_after));
    }
    let email = account_email_to_verify(state.db_pool(), &session.account_id)
        .await
        .map_err(account_email_error)?;
    let service = state.signup_email().ok_or_else(|| {
        account_email_error(AccountEmailError::Code(SignupCodeError::Unavailable))
    })?;
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(EMAIL_VERIFICATION_LIMIT, &session.account_id)
        .await
    {
        return Err(limited_response(retry_after));
    }
    Ok((service, email))
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
        AccountEmailError::Code(SignupCodeError::Unavailable) => err(
            "email_delivery_unavailable",
            "Email verification is temporarily unavailable. Try again later.",
            StatusCode::SERVICE_UNAVAILABLE,
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
    let (service, email) = match prepare(
        &state,
        &rate_limiter,
        &session,
        &headers,
        connect_info.as_ref(),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    match send_account_email_code(state.db_pool(), service, &session.account_id, &email).await {
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
    let (service, _) = match prepare(
        &state,
        &rate_limiter,
        &session,
        &headers,
        connect_info.as_ref(),
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    // Guesses stay charged to the account budget; verification re-checks the
    // account under a row lock.
    if let Err(error) = verify_account_email(
        state.db_pool(),
        service,
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
