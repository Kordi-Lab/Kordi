//! Changing the primary email: a code goes to the new address, and the
//! change happens only when that code comes back.
//!
//! One account per verified email: an address that is another account's
//! primary email, or that a provider verified for another account, is never
//! taken. Starting a change with such an address answers like any other
//! start but sends nothing, so the answer does not reveal the other account.

use super::proof::{check_proof, consume_proof, ProofRequest};
use super::*;
use crate::auth::signup_email::{
    consume_account_code, request_account_code, AccountCodePurpose, SignupCodeChallenge,
    SignupCodeError,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StartEmailChangeRequest {
    new_email: String,
    #[serde(flatten)]
    proof: ProofRequest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VerifyEmailChangeRequest {
    verification_id: String,
    verification_code: String,
}

/// Whether another account already holds `email` as its primary email or
/// as a provider-verified identity email.
async fn email_taken<'e, E>(
    executor: E,
    account_id: &str,
    email: &str,
) -> Result<bool, Box<Response>>
where
    E: sqlx_core::executor::Executor<'e, Database = sqlx_postgres::Postgres>,
{
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_accounts WHERE LOWER(primary_email) = $1 AND account_id <> $2 \
         UNION ALL \
         SELECT 1 FROM cloud_account_identities \
         WHERE LOWER(email) = $1 AND email_verified AND account_id <> $2 \
         LIMIT 1",
    )
    .bind(email)
    .bind(account_id)
    .fetch_optional(executor)
    .await
    .map_err(|_| server_error())?;
    Ok(row.is_some())
}

fn email_not_available() -> Response {
    err(
        "email_not_available",
        "This email can't be used. Try another address.",
        StatusCode::CONFLICT,
    )
}

/// The answer to a start whose address is taken: shaped like a sent code.
fn unsent_challenge() -> SignupCodeChallenge {
    SignupCodeChallenge {
        verification_id: format!("email_{}", uuid::Uuid::new_v4().simple()),
        expires_at: (Utc::now() + ChronoDuration::minutes(10)).to_rfc3339(),
        retry_after_seconds: 60,
    }
}

/// `POST /v1/cloud/account/security/email/change`
pub(super) async fn start_email_change(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(request): Json<StartEmailChangeRequest>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change(&headers, connect_info.as_ref()).await {
        return *response;
    }
    let new_email = match validate_email(&request.new_email) {
        Ok(email) => email,
        Err(error) => return map_email_format(error),
    };
    let account = match load_account(caller.pool(), &session.account_id).await {
        Ok(account) => account,
        Err(response) => return *response,
    };
    if account.email().as_deref() == Some(new_email.as_str()) {
        return err(
            "email_unchanged",
            "This is already your email.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(service) = state.signup_email() else {
        return email_unavailable();
    };
    let proof = match check_proof(&caller, &account, &request.proof).await {
        Ok(proof) => proof,
        Err(response) => return *response,
    };
    // An email-code proof is spent before the new address gets its code.
    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    if let Err(error) = consume_proof(
        &mut tx,
        &state,
        &proof,
        &session.account_id,
        account.email().as_deref(),
    )
    .await
    {
        return commit_failed_code(tx, error).await;
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    if let Err(response) = caller.charge_proof().await {
        return *response;
    }
    let taken = match email_taken(caller.pool(), &session.account_id, &new_email).await {
        Ok(taken) => taken,
        Err(response) => return *response,
    };
    let challenge = if taken {
        unsent_challenge()
    } else {
        match request_account_code(
            caller.pool(),
            service,
            AccountCodePurpose::ChangeEmail,
            &session.account_id,
            &new_email,
        )
        .await
        {
            Ok(challenge) => challenge,
            Err(SignupCodeError::Unavailable) => return email_unavailable(),
            Err(error) => return super::super::signup_email_handlers::signup_code_error(error),
        }
    };
    let _ = write_audit(
        caller.pool(),
        Some(&session.account_id),
        Some(&session.device_id),
        "account.email_change.requested",
        serde_json::json!({ "sent": !taken }),
    )
    .await;
    (StatusCode::OK, Json(challenge)).into_response()
}

/// `POST /v1/cloud/account/security/email/change/verify`
pub(super) async fn verify_email_change(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(request): Json<VerifyEmailChangeRequest>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change(&headers, connect_info.as_ref()).await {
        return *response;
    }
    let Some(service) = state.signup_email() else {
        return email_unavailable();
    };
    if let Err(response) = caller.charge_proof().await {
        return *response;
    }
    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    // The account lock serializes this change with password changes,
    // primary email verification, and other email changes.
    let account = match lock_account(&mut tx, &session.account_id).await {
        Ok(account) => account,
        Err(response) => return *response,
    };
    let pending: Option<(String,)> = match query_as(
        "SELECT email FROM cloud_account_email_change_codes \
         WHERE account_id = $1 AND verification_id = $2",
    )
    .bind(&session.account_id)
    .bind(&request.verification_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(row) => row,
        Err(_) => return *server_error(),
    };
    let Some((new_email,)) = pending else {
        return super::super::signup_email_handlers::signup_code_error(SignupCodeError::Invalid);
    };
    if let Err(error) = consume_account_code(
        &mut tx,
        service,
        AccountCodePurpose::ChangeEmail,
        &session.account_id,
        &new_email,
        &request.verification_id,
        request.verification_code.trim(),
    )
    .await
    {
        return commit_failed_code(tx, error).await;
    }
    match email_taken(&mut *tx, &session.account_id, &new_email).await {
        Ok(false) => {}
        Ok(true) => {
            return match tx.commit().await {
                Ok(()) => email_not_available(),
                Err(_) => *server_error(),
            };
        }
        Err(response) => return *response,
    }
    let now = Utc::now().to_rfc3339();
    let updated = query(
        "UPDATE cloud_accounts SET primary_email = $2, primary_email_verified_at = $3, \
         updated_at = $3 WHERE account_id = $1",
    )
    .bind(&session.account_id)
    .bind(&new_email)
    .bind(&now)
    .execute(&mut *tx)
    .await;
    if updated.is_err() {
        // The unique email index caught a concurrent claim.
        return email_not_available();
    }
    // Codes sent to the previous address no longer prove anything.
    for table in ["cloud_account_email_codes", "cloud_account_reauth_codes"] {
        if query(&format!("DELETE FROM {table} WHERE account_id = $1"))
            .bind(&session.account_id)
            .execute(&mut *tx)
            .await
            .is_err()
        {
            return *server_error();
        }
    }
    if let Err(response) = audit_in_transaction(
        &mut tx,
        &session,
        "account.email_changed",
        serde_json::json!({ "previousEmailVerified": account.email_verified }),
    )
    .await
    {
        return *response;
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    Json(serde_json::json!({
        "email": { "address": new_email, "verified": true },
    }))
    .into_response()
}
