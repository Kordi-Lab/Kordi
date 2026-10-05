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
    Json(req): Json<SignupCodeRequest>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }
    let email = match validate_email(&req.email) {
        Ok(email) => email,
        Err(error) => return map_email_format(error),
    };
    let Some(service) = state.signup_email() else {
        return signup_code_error(SignupCodeError::Unavailable);
    };
    let existing: Result<Option<(String,)>, _> =
        query_as("SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = $1")
            .bind(&email)
            .fetch_optional(state.db_pool())
            .await;
    match existing {
        Ok(Some(_)) => {
            return err(
                "email_in_use",
                "An account with this email already exists. Sign in instead.",
                StatusCode::CONFLICT,
            )
        }
        Err(_) => return signup_code_error(SignupCodeError::Database),
        Ok(None) => {}
    }
    match request_signup_code(state.db_pool(), service, &email).await {
        Ok(challenge) => (StatusCode::OK, Json(challenge)).into_response(),
        Err(error) => signup_code_error(error),
    }
}

pub(super) fn signup_code_error(error: SignupCodeError) -> Response {
    match error {
        SignupCodeError::Invalid => err("invalid_verification_code", "The email code is invalid or expired. Request a new code and try again.", StatusCode::BAD_REQUEST),
        SignupCodeError::Limited(seconds) => limited_response(std::time::Duration::from_secs(seconds)),
        SignupCodeError::Unavailable => err("email_delivery_unavailable", "Email verification is temporarily unavailable. Try again later or continue with Google or GitHub.", StatusCode::SERVICE_UNAVAILABLE),
        SignupCodeError::Database => err("server_error", "Could not verify email. Try again.", StatusCode::INTERNAL_SERVER_ERROR),
    }
}
