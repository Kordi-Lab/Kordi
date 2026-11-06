//! `POST /v1/cloud/account/security/delete`: delete the signed-in account
//! (docs/development/account-deletion.md). Needs the same proof as other
//! security changes. Answers `204`; every session of the account ends.

use super::proof::{check_proof, consume_proof, Proof, ProofRequest};
use super::*;

pub(super) async fn delete_account(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(request): Json<ProofRequest>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change(&headers, connect_info.as_ref()).await {
        return *response;
    }
    let account = match load_account(caller.pool(), &session.account_id).await {
        Ok(account) => account,
        Err(response) => return *response,
    };
    let proof = match check_proof(&caller, &account, &request).await {
        Ok(proof) => proof,
        Err(response) => return *response,
    };
    // Proven first, in a short transaction: the account is unchanged since
    // the proof was checked, and an emailed code is spent, so a wrong code or
    // a concurrent change touches nothing, connectors included. A deletion
    // that fails later needs a new code.
    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    if let Err(response) = require_unchanged(&mut tx, &session.account_id, &account).await {
        return *response;
    }
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
    // Outside any transaction: provider calls never hold the account lock.
    crate::account_deletion::prepare(&state, &session.account_id).await;

    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    if let Err(response) = require_unchanged(&mut tx, &session.account_id, &account).await {
        return *response;
    }
    let deletion =
        match crate::account_deletion::delete_in_transaction(&mut tx, &session.account_id).await {
            Ok(deletion) => deletion,
            Err(error) => {
                eprintln!("[account-deletion] Could not delete an account: {error}");
                return *server_error();
            }
        };
    let proof_kind = match proof {
        Proof::Password => "password",
        Proof::EmailCode { .. } => "email_code",
        Proof::RecentSignIn => "recent_sign_in",
    };
    let mut metadata = deletion.audit_metadata();
    metadata["proof"] = serde_json::Value::from(proof_kind);
    // The record keeps counts only: no account, device, name or email.
    if write_audit_in_transaction(&mut tx, "account.deleted", metadata)
        .await
        .is_err()
    {
        return *server_error();
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    crate::account_deletion::after_commit(state.clone(), session.account_id.clone(), deletion);
    StatusCode::NO_CONTENT.into_response()
}

/// Locks the account and refuses when its password or email changed since
/// the proof was checked; such a change must be proven again.
async fn require_unchanged(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    proven: &SecurityAccount,
) -> Result<(), Box<Response>> {
    let locked = lock_account(tx, account_id).await?;
    if locked.password_hash != proven.password_hash || locked.email() != proven.email() {
        return Err(boxed_err(
            "account_changed",
            "Your account changed. Reload the page and try again.",
            StatusCode::CONFLICT,
        ));
    }
    Ok(())
}

async fn write_audit_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    event_type: &str,
    metadata: serde_json::Value,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, NULL, NULL, $2, $3, $4)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(event_type)
    .bind(metadata.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}
