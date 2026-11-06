use crate::auth::rate_limit::{SIGNUP_CODE_ADDRESS_LIMIT, SIGNUP_CODE_EMAIL_LIMIT};
use crate::auth::signup_email::{request_signup_code, SignupCodeError};

use super::*;

#[derive(Deserialize)]
pub(super) struct SignupCodeRequest {
    email: String,
}

pub(super) async fn send_signup_code(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(req): Json<SignupCodeRequest>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_address_limit(
            SIGNUP_CODE_ADDRESS_LIMIT,
            client_ip(&headers, connect_info.as_ref()),
        )
        .await
    {
        return limited_response(retry_after);
    }
    let email = match validate_email(&req.email) {
        Ok(email) => email,
        Err(error) => return map_email_format(error),
    };
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_identifier_limit(SIGNUP_CODE_EMAIL_LIMIT, &email)
        .await
    {
        return limited_response(retry_after);
    }
    let Some(service) = state.signup_email() else {
        return signup_code_error(SignupCodeError::Unavailable);
    };
    // An account without a password whose email is verified, such as one
    // created through Google or GitHub, may add a password with a code, so it
    // gets one exactly like a new address. Every other existing account must
    // sign in instead.
    let existing: Result<Option<(bool, bool)>, _> = query_as(
        "SELECT password_hash IS NOT NULL, primary_email_verified_at IS NOT NULL \
         FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&email)
    .fetch_optional(state.db_pool())
    .await;
    match existing {
        Ok(Some((has_password, email_verified))) if has_password || !email_verified => {
            return err(
                "email_in_use",
                "An account with this email already exists. Sign in instead.",
                StatusCode::CONFLICT,
            )
        }
        Err(_) => return signup_code_error(SignupCodeError::Database),
        Ok(_) => {}
    }
    match request_signup_code(state.db_pool(), service, &email).await {
        Ok(challenge) => (StatusCode::OK, Json(challenge)).into_response(),
        Err(error) => signup_code_error(error),
    }
}

pub(super) fn signup_code_error(error: SignupCodeError) -> Response {
    match error {
        SignupCodeError::AlreadyVerified => err("email_already_verified", "This account's email is already verified.", StatusCode::CONFLICT),
        SignupCodeError::Invalid => err("invalid_verification_code", "The email code is invalid or expired. Request a new code and try again.", StatusCode::BAD_REQUEST),
        SignupCodeError::Limited(seconds) => limited_response(std::time::Duration::from_secs(seconds)),
        SignupCodeError::Unavailable => err("email_delivery_unavailable", "Email verification is temporarily unavailable. Try again later or continue with Google or GitHub.", StatusCode::SERVICE_UNAVAILABLE),
        SignupCodeError::Database => err("server_error", "Could not verify email. Try again.", StatusCode::INTERNAL_SERVER_ERROR),
    }
}
