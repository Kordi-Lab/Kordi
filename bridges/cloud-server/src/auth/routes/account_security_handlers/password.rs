//! `POST /v1/cloud/account/security/password`: set a first password or
//! change the current one. A change signs out every other session.

use super::proof::{check_proof, consume_proof, Proof, ProofRequest};
use super::sessions::revoke_other_sessions_in_transaction;
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetPasswordRequest {
    new_password: String,
    #[serde(flatten)]
    proof: ProofRequest,
}

/// Why sessions end when a password changes, recorded on revoked sign-ins.
const PASSWORD_CHANGED: &str = "password_changed";

pub(super) async fn set_password(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(hasher_config): Extension<Arc<PasswordHasherConfig>>,
    Json(request): Json<SetPasswordRequest>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change().await {
        return *response;
    }
    if let Err(error) = validate_password_strength(&request.new_password) {
        return map_password_policy(error);
    }
    let account = match load_account(caller.pool(), &session.account_id).await {
        Ok(account) => account,
        Err(response) => return *response,
    };
    let Some(email) = account.email() else {
        return err(
            "email_missing",
            "Add an email address before setting a password.",
            StatusCode::BAD_REQUEST,
        );
    };
    let proof = match check_proof(&caller, &account, &request.proof).await {
        Ok(proof) => proof,
        Err(response) => return *response,
    };
    let config = *hasher_config;
    let plaintext = request.new_password.clone();
    let hash = match tokio::task::spawn_blocking(move || hash_password(&plaintext, config)).await {
        Ok(Ok(hash)) => hash,
        _ => return *server_error(),
    };

    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    let locked = match lock_account(&mut tx, &session.account_id).await {
        Ok(locked) => locked,
        Err(response) => return *response,
    };
    // The proof was checked against this password; a concurrent change
    // must be proven again.
    if locked.password_hash != account.password_hash || locked.email() != Some(email.clone()) {
        return err(
            "account_changed",
            "Your account changed. Reload the page and try again.",
            StatusCode::CONFLICT,
        );
    }
    if let Err(error) =
        consume_proof(&mut tx, &state, &proof, &session.account_id, Some(&email)).await
    {
        return commit_failed_code(tx, error).await;
    }
    let now = Utc::now().to_rfc3339();
    // A code read from the primary inbox also proves that email.
    let verified_by_code = matches!(proof, Proof::EmailCode { .. });
    if query(
        "UPDATE cloud_accounts SET password_hash = $2, password_algorithm = $3, \
         password_updated_at = $4, updated_at = $4, \
         primary_email_verified_at = CASE WHEN $5 THEN COALESCE(primary_email_verified_at, $4) \
           ELSE primary_email_verified_at END \
         WHERE account_id = $1",
    )
    .bind(&session.account_id)
    .bind(&hash)
    .bind(PASSWORD_ALGORITHM_ID)
    .bind(&now)
    .bind(verified_by_code)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return *server_error();
    }
    let changed = account.password_hash.is_some();
    let revoked_sessions = if changed {
        match revoke_other_sessions_in_transaction(&mut tx, &session, PASSWORD_CHANGED).await {
            Ok(count) => count,
            Err(_) => return *server_error(),
        }
    } else {
        0
    };
    let event = if changed {
        "account.password_changed"
    } else {
        "account.password_set"
    };
    let proof_kind = match proof {
        Proof::Password => "password",
        Proof::EmailCode { .. } => "email_code",
        Proof::RecentSignIn => "recent_sign_in",
    };
    if let Err(response) = audit_in_transaction(
        &mut tx,
        &session,
        event,
        serde_json::json!({ "proof": proof_kind, "revokedSessions": revoked_sessions }),
    )
    .await
    {
        return *response;
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    Json(serde_json::json!({
        "password": { "set": true, "updatedAt": now },
        "revokedSessions": revoked_sessions,
    }))
    .into_response()
}
