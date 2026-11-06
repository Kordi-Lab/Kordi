//! Proof that the account holder is present for a sensitive change: the
//! current password when the account has one; otherwise a code emailed to
//! the primary email, or a sign-in within the last ten minutes.

use super::*;
use crate::auth::signup_email::{consume_account_code, request_account_code, AccountCodePurpose};

/// How recent a sign-in must be to stand in for a password or email code.
pub(in crate::auth::routes) const RECENT_SIGN_IN_MINUTES: i64 = 10;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProofRequest {
    #[serde(default)]
    current_password: Option<String>,
    #[serde(default)]
    verification_id: Option<String>,
    #[serde(default)]
    verification_code: Option<String>,
}

/// A checked proof. An email code is consumed later, inside the change's
/// transaction, so a failed change cannot spend it.
pub(super) enum Proof {
    Password,
    EmailCode { id: String, code: String },
    RecentSignIn,
}

/// When the session's sign-in happened. An app's access token is renewed
/// every hour, so its sign-in's start counts, not the token's.
async fn signed_in_at(
    pool: &PgPool,
    token_id: &str,
) -> Result<Option<DateTime<Utc>>, Box<Response>> {
    let row: Option<(DateTime<Utc>,)> = query_as(
        "SELECT COALESCE(sign_in.created_at, token.created_at::timestamptz) \
         FROM cloud_refresh_tokens token \
         LEFT JOIN cloud_app_sign_ins sign_in ON sign_in.sign_in_id = token.app_sign_in_id \
         WHERE token.token_id = $1",
    )
    .bind(token_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| server_error())?;
    Ok(row.map(|(at,)| at))
}

pub(super) async fn signed_in_recently(
    pool: &PgPool,
    token_id: &str,
) -> Result<bool, Box<Response>> {
    let cutoff = Utc::now() - ChronoDuration::minutes(RECENT_SIGN_IN_MINUTES);
    Ok(signed_in_at(pool, token_id)
        .await?
        .is_some_and(|at| at > cutoff))
}

fn proof_error(code: &'static str, message: &'static str) -> Box<Response> {
    boxed_err(code, message, StatusCode::FORBIDDEN)
}

/// Checks the proof for a change to `account`.
pub(super) async fn check_proof(
    caller: &Caller<'_>,
    account: &SecurityAccount,
    request: &ProofRequest,
) -> Result<Proof, Box<Response>> {
    let pool = caller.pool();
    if let Some(hash) = account.password_hash.clone() {
        let Some(plaintext) = request.current_password.clone().filter(|v| !v.is_empty()) else {
            return Err(proof_error(
                "current_password_required",
                "Enter your current password.",
            ));
        };
        caller.charge_proof().await?;
        let verified = tokio::task::spawn_blocking(move || verify_password(&hash, &plaintext))
            .await
            .map_err(|_| server_error())?
            .map_err(|_| server_error())?;
        if !verified {
            let _ = write_audit(
                pool,
                Some(&caller.session.account_id),
                Some(&caller.session.device_id),
                "account.security.password_check_failed",
                serde_json::json!({}),
            )
            .await;
            return Err(proof_error(
                "invalid_current_password",
                "The current password is incorrect.",
            ));
        }
        return Ok(Proof::Password);
    }
    if let (Some(id), Some(code)) = (
        request.verification_id.clone(),
        request.verification_code.clone(),
    ) {
        caller.charge_proof().await?;
        return Ok(Proof::EmailCode {
            id,
            code: code.trim().to_string(),
        });
    }
    if signed_in_recently(pool, &caller.session.token_id).await? {
        return Ok(Proof::RecentSignIn);
    }
    Err(proof_error(
        "reauthentication_required",
        "Confirm it's you with the code we email you.",
    ))
}

/// Spends an email-code proof inside the change's transaction. Returns the
/// code error to report after the caller commits the failed guess.
pub(super) async fn consume_proof(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    state: &ServerState,
    proof: &Proof,
    account_id: &str,
    email: Option<&str>,
) -> Result<(), crate::auth::signup_email::SignupCodeError> {
    use crate::auth::signup_email::SignupCodeError;
    let Proof::EmailCode { id, code } = proof else {
        return Ok(());
    };
    let service = state.signup_email().ok_or(SignupCodeError::Unavailable)?;
    let email = email.ok_or(SignupCodeError::Invalid)?;
    consume_account_code(
        tx,
        service,
        AccountCodePurpose::Reauthenticate,
        account_id,
        email,
        id,
        code,
    )
    .await
}

/// `POST /v1/cloud/account/security/password/code`: email a code to the
/// primary email of an account without a password.
pub(super) async fn send_reauthentication_code(
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
    let account = match load_account(caller.pool(), &session.account_id).await {
        Ok(account) => account,
        Err(response) => return *response,
    };
    if account.password_hash.is_some() {
        return err(
            "current_password_required",
            "Enter your current password instead.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(email) = account.email() else {
        return err(
            "email_missing",
            "Add an email address first.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(service) = state.signup_email() else {
        return email_unavailable();
    };
    if let Err(response) = caller.charge_proof().await {
        return *response;
    }
    match request_account_code(
        caller.pool(),
        service,
        AccountCodePurpose::Reauthenticate,
        &session.account_id,
        &email,
    )
    .await
    {
        Ok(challenge) => (StatusCode::OK, Json(challenge)).into_response(),
        Err(crate::auth::signup_email::SignupCodeError::Unavailable) => email_unavailable(),
        Err(error) => super::super::signup_email_handlers::signup_code_error(error),
    }
}
