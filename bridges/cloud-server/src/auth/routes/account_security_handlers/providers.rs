//! `DELETE /v1/cloud/account/security/providers/:provider`: unlink a sign-in
//! provider, unless it is the account's last way to sign in.

use super::*;
use crate::auth::accounts::OAuthProviderId;

fn not_linked() -> Response {
    err(
        "provider_not_linked",
        "This sign-in method is not linked.",
        StatusCode::NOT_FOUND,
    )
}

pub(super) async fn unlink_provider(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
) -> Response {
    let caller = Caller {
        state: &state,
        rate_limiter: &rate_limiter,
        session: &session,
    };
    if let Err(response) = caller.charge_change().await {
        return *response;
    }
    let Some(provider) = OAuthProviderId::parse(&provider) else {
        return not_linked();
    };
    let provider = provider.as_str();
    let Ok(mut tx) = caller.pool().begin().await else {
        return *server_error();
    };
    let account = match lock_account(&mut tx, &session.account_id).await {
        Ok(account) => account,
        Err(response) => return *response,
    };
    let linked: Vec<(String,)> =
        match query_as("SELECT provider FROM cloud_account_identities WHERE account_id = $1")
            .bind(&session.account_id)
            .fetch_all(&mut *tx)
            .await
        {
            Ok(rows) => rows,
            Err(_) => return *server_error(),
        };
    if !linked.iter().any(|(linked,)| linked == provider) {
        return not_linked();
    }
    let password_sign_in = account.password_hash.is_some() && account.email().is_some();
    let other_providers = linked.iter().filter(|(linked,)| linked != provider).count();
    if !password_sign_in && other_providers == 0 {
        return err(
            "last_sign_in_method",
            "Set a password or link another sign-in method first.",
            StatusCode::CONFLICT,
        );
    }
    if query("DELETE FROM cloud_account_identities WHERE account_id = $1 AND provider = $2")
        .bind(&session.account_id)
        .bind(provider)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return *server_error();
    }
    if let Err(response) = audit_in_transaction(
        &mut tx,
        &session,
        "account.provider_unlinked",
        serde_json::json!({ "provider": provider }),
    )
    .await
    {
        return *response;
    }
    if tx.commit().await.is_err() {
        return *server_error();
    }
    if provider == OAuthProviderId::Apple.as_str() {
        // Apple asks apps to revoke the user's tokens once they are no
        // longer used.
        crate::auth::oauth::apple::revoke_apple_tokens_for_account(&state, &session.account_id)
            .await;
    }
    StatusCode::NO_CONTENT.into_response()
}
