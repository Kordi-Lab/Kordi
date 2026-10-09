//! Access-token refresh for the broker, serialized per connector.
//!
//! A refresh runs in a transaction that holds
//! `pg_advisory_xact_lock(hashtext(connector_id))`. After the lock the
//! secret is read again, so a caller that waited behind another refresh uses
//! the token that refresh stored instead of spending the refresh token a
//! second time. The refreshed secret is written with an update that only
//! touches a live connector, so a disconnect that lands mid-refresh stays
//! final.
//!
//! The same locked step serves the forced refresh after a provider answers
//! 401 ([`execute_with_retry`]) and the polling job ([`usable_secret`]).

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipher;

use super::broker::{load_secret, open_secret, read_sealed_secret, seal_secret};
use super::models::ConnectorRecord;
use super::providers::{ConnectorProvider, ConnectorSecret, ProviderError};
use super::store;
use super::ConnectorRuntime;

#[derive(Debug)]
pub(crate) enum RefreshFailure {
    /// No refresh token, or the provider answered `invalid_grant`. The
    /// connector is marked `needs_reauth`.
    NeedsReauth,
    /// The provider failed in a way that may pass on retry.
    Provider(ProviderError),
    /// The connector was disconnected while the refresh ran.
    Disconnected,
    /// The refreshed credential could not be read or stored.
    Storage,
}

impl RefreshFailure {
    /// Fixed wording for the audit row.
    pub(crate) fn audit_phrase(&self) -> &'static str {
        match self {
            Self::NeedsReauth => "The connector needs a new sign-in.",
            Self::Provider(error) => error.audit_phrase(),
            Self::Disconnected => "The connector was disconnected.",
            Self::Storage => "The refreshed credential could not be saved.",
        }
    }
}

/// Returns `secret` when it is still fresh, otherwise a refreshed secret that
/// is already stored.
pub(crate) async fn refresh_if_needed(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    provider: &dyn ConnectorProvider,
    connector_id: &str,
    secret: ConnectorSecret,
) -> Result<ConnectorSecret, RefreshFailure> {
    if !secret.needs_refresh(Utc::now()) {
        return Ok(secret);
    }
    let still_stale = |current: &ConnectorSecret| current.needs_refresh(Utc::now());
    refresh_locked(pool, cipher, provider, connector_id, still_stale).await
}

/// Refreshes after the provider rejected `rejected` with a 401, unless
/// another call already stored a different token while this one waited.
pub(crate) async fn refresh_rejected(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    provider: &dyn ConnectorProvider,
    connector_id: &str,
    rejected: &ConnectorSecret,
) -> Result<ConnectorSecret, RefreshFailure> {
    let still_rejected = |current: &ConnectorSecret| current.access_token == rejected.access_token;
    refresh_locked(pool, cipher, provider, connector_id, still_rejected).await
}

/// Takes the per-connector lock, reloads the secret, and refreshes it when
/// `still_needed` holds for the reloaded secret. A refreshed secret that
/// cannot be stored is an error, never a token used once and lost.
async fn refresh_locked(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    provider: &dyn ConnectorProvider,
    connector_id: &str,
    still_needed: impl Fn(&ConnectorSecret) -> bool,
) -> Result<ConnectorSecret, RefreshFailure> {
    let storage = |context: &str, error: &dyn std::fmt::Display| {
        eprintln!("[connectors] refresh {connector_id} {context}: {error}");
        RefreshFailure::Storage
    };
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| storage("begin", &error))?;
    query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(connector_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| storage("lock", &error))?;
    let sealed = read_sealed_secret(&mut *tx, connector_id)
        .await
        .map_err(|error| storage("reload", &error))?
        .ok_or(RefreshFailure::Disconnected)?;
    let current = open_secret(cipher, &sealed).map_err(|error| storage("open", &error))?;
    if !still_needed(&current) {
        // Another call refreshed while this one waited for the lock.
        return Ok(current);
    }
    if current.refresh_token.is_none() {
        store::mark_needs_reauth(&mut *tx, connector_id)
            .await
            .map_err(|error| storage("mark needs_reauth", &error))?;
        tx.commit()
            .await
            .map_err(|error| storage("commit", &error))?;
        return Err(RefreshFailure::NeedsReauth);
    }
    let client = provider.oauth_client().map_err(RefreshFailure::Provider)?;
    let refreshed = match provider.refresh(&client, &current).await {
        Ok(refreshed) => refreshed,
        Err(ProviderError::Unauthorized) => {
            eprintln!("[connectors] refresh {connector_id}: grant is no longer valid");
            store::mark_needs_reauth(&mut *tx, connector_id)
                .await
                .map_err(|error| storage("mark needs_reauth", &error))?;
            tx.commit()
                .await
                .map_err(|error| storage("commit", &error))?;
            return Err(RefreshFailure::NeedsReauth);
        }
        Err(error) => {
            eprintln!("[connectors] refresh {connector_id}: {error}");
            return Err(RefreshFailure::Provider(error));
        }
    };
    let sealed = seal_secret(cipher, &refreshed).map_err(|error| storage("seal", &error))?;
    let stored = store::update_refreshed_secret(&mut *tx, connector_id, &sealed)
        .await
        .map_err(|error| storage("store", &error))?;
    if !stored {
        return Err(RefreshFailure::Disconnected);
    }
    tx.commit()
        .await
        .map_err(|error| storage("commit", &error))?;
    Ok(refreshed)
}

/// A decrypted, current credential for the polling job and subscription
/// renewal, refreshed through the locked step when it is about to expire.
pub(crate) async fn usable_secret(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    provider: &dyn ConnectorProvider,
    connector_id: &str,
) -> Result<ConnectorSecret, String> {
    let cipher = runtime
        .cipher
        .as_deref()
        .ok_or_else(|| "connector encryption is not configured".to_string())?;
    let secret = load_secret(pool, cipher, connector_id)
        .await
        .map_err(|error| error.to_string())?;
    refresh_if_needed(pool, cipher, provider, connector_id, secret)
        .await
        .map_err(|failure| failure.audit_phrase().to_string())
}

/// Runs one tool with the connector's settings. When the provider answers
/// 401 to a token that has a refresh token, refreshes once through the
/// locked step and retries once: a token can be revoked or rotated before
/// its stated expiry. A failed refresh keeps the original 401.
pub(crate) async fn execute_with_retry(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    provider: &dyn ConnectorProvider,
    connector: &ConnectorRecord,
    tool: &str,
    args: &serde_json::Value,
    secret: ConnectorSecret,
) -> Result<serde_json::Value, ProviderError> {
    let settings = &connector.settings;
    let first = provider.execute(tool, args, &secret, settings).await;
    if !matches!(first, Err(ProviderError::Unauthorized)) || secret.refresh_token.is_none() {
        return first;
    }
    let connector_id = connector.connector_id.as_str();
    match refresh_rejected(pool, cipher, provider, connector_id, &secret).await {
        Ok(refreshed) => provider.execute(tool, args, &refreshed, settings).await,
        Err(failure) => {
            eprintln!(
                "[connectors] retry {connector_id} after 401: {}",
                failure.audit_phrase()
            );
            first
        }
    }
}
