//! The authenticated completion step of a connector grant.
//!
//! The OAuth callback is unauthenticated: whoever's browser lands on it
//! carries the provider consent, not necessarily the Kordi account that
//! started the flow. So the callback only parks the exchanged tokens, sealed,
//! under a one-use completion code and hands the code to the app in the
//! redirect fragment. The app then calls
//! `POST /v1/cloud/connectors/oauth/complete` with its own session, and the
//! grant is applied only when that session is the account that started it.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use sqlx_postgres::PgPool;

use super::models::{ConnectorRecord, OAuthPendingFragment, PENDING_GRANT_STATUS};
use super::oauth::CallbackError;
use super::store::{self, ConnectorOAuthState, GrantUpdate, PendingGrant, SealedSecret};
use super::ConnectorRuntime;

pub const PENDING_GRANT_TTL_MINUTES: i64 = 10;
const MAX_COMPLETION_CODE_LEN: usize = 256;

fn new_completion_code() -> String {
    format!(
        "connector_completion_{}",
        URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
    )
}

/// What the callback learned about a grant besides the credential.
pub(super) struct GrantScopes {
    pub read_scopes: Vec<String>,
    pub act_scopes: Vec<String>,
    /// The provider account behind the grant, used to route webhooks.
    pub provider_account_id: Option<String>,
}

/// Parks the sealed tokens from a callback and returns the fragment the app
/// receives.
pub(super) async fn park_grant(
    pool: &PgPool,
    state: &ConnectorOAuthState,
    provider: &str,
    scopes: GrantScopes,
    sealed: SealedSecret,
) -> Result<OAuthPendingFragment, CallbackError> {
    let GrantScopes {
        read_scopes,
        act_scopes,
        provider_account_id,
    } = scopes;
    let pending = PendingGrant {
        completion_code: new_completion_code(),
        state_id: state.state_id.clone(),
        account_id: state.account_id.clone(),
        provider: provider.to_string(),
        grant: state.grant,
        read_scopes,
        act_scopes,
        provider_account_id,
        sealed,
        expires_at: Utc::now() + ChronoDuration::minutes(PENDING_GRANT_TTL_MINUTES),
    };
    if let Err(error) = store::insert_pending_grant(pool, &pending).await {
        eprintln!("[connectors] park {provider} grant: {error}");
        return Err(CallbackError::new(
            "server_error",
            "Could not store the connection.",
        ));
    }
    Ok(OAuthPendingFragment {
        completion_code: pending.completion_code,
        provider: pending.provider,
        grant: pending.grant,
        status: PENDING_GRANT_STATUS,
    })
}

#[derive(Debug)]
pub enum FinishError {
    /// The provider-auth cipher is not configured on this server.
    Unavailable,
    /// Unknown, or already used by an earlier completion.
    NotFound,
    /// Another account started this grant. The pending grant is discarded.
    Mismatch,
    Expired,
    Database(sqlx_core::Error),
}

/// Applies a parked grant for the signed-in `account_id`. The pending row is
/// deleted before any check, so a code works at most once whatever the
/// outcome.
pub async fn finish_grant(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    completion_code: &str,
) -> Result<ConnectorRecord, FinishError> {
    if runtime.cipher.is_none() {
        return Err(FinishError::Unavailable);
    }
    let code = completion_code.trim();
    if code.is_empty() || code.len() > MAX_COMPLETION_CODE_LEN {
        return Err(FinishError::NotFound);
    }
    let pending = store::take_pending_grant(pool, code)
        .await
        .map_err(FinishError::Database)?
        .ok_or(FinishError::NotFound)?;
    if pending.account_id != account_id {
        eprintln!(
            "[connectors] discarded a {} grant completed by another account",
            pending.provider
        );
        return Err(FinishError::Mismatch);
    }
    if pending.expires_at <= Utc::now() {
        return Err(FinishError::Expired);
    }
    let provider = runtime
        .providers
        .get(&pending.provider)
        .ok_or(FinishError::NotFound)?;
    let spec = provider.spec();
    let summary = format!(
        "Granted {} access to {}.",
        pending.grant.as_str(),
        spec.display_name
    );
    store::apply_grant(
        pool,
        GrantUpdate {
            account_id: &pending.account_id,
            provider: spec.id,
            read_scopes: &pending.read_scopes,
            act_scopes: &pending.act_scopes,
            enable_act: pending.grant == super::models::ConnectorToolGroup::Act,
            provider_account_id: pending.provider_account_id.as_deref(),
            audit_tool_group: pending.grant,
            audit_summary: &summary,
        },
        &pending.sealed,
    )
    .await
    .map_err(FinishError::Database)
}
