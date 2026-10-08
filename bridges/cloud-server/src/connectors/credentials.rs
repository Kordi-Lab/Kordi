//! Server-side credential refresh outside the broker's call path: a forced
//! refresh after a provider answers 401, and a current credential for the
//! polling job and subscription renewal. Everything here stays inside the
//! server; callers use the secret to reach the provider and never return it.

use chrono::Utc;
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipher;

use super::broker::{load_secret, seal_secret};
use super::models::ConnectorRecord;
use super::providers::{ConnectorProvider, ConnectorSecret, ProviderError};
use super::store;
use super::ConnectorRuntime;

pub(crate) const RECONNECT_MESSAGE: &str = "The connector credential expired. Reconnect it.";

/// Refreshes the credential through the provider and stores the new one.
pub(crate) async fn refresh_now(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    provider: &dyn ConnectorProvider,
    connector: &ConnectorRecord,
    secret: &ConnectorSecret,
) -> Result<ConnectorSecret, &'static str> {
    if secret.refresh_token.is_none() {
        let _ = store::mark_needs_reauth(pool, &connector.connector_id).await;
        return Err(RECONNECT_MESSAGE);
    }
    let client = provider.oauth_client().map_err(|_| RECONNECT_MESSAGE)?;
    let refreshed = match provider.refresh(&client, secret).await {
        Ok(refreshed) => refreshed,
        Err(error) => {
            eprintln!("[connectors] refresh {}: {error}", connector.connector_id);
            if matches!(error, ProviderError::Unauthorized) {
                let _ = store::mark_needs_reauth(pool, &connector.connector_id).await;
            }
            return Err(RECONNECT_MESSAGE);
        }
    };
    let sealed = seal_secret(cipher, &refreshed).map_err(|_| RECONNECT_MESSAGE)?;
    if let Err(error) = store::write_secret(pool, &connector.connector_id, &sealed).await {
        eprintln!(
            "[connectors] store refreshed secret {}: {error}",
            connector.connector_id
        );
    }
    Ok(refreshed)
}

/// A decrypted, current credential for the polling job and subscription
/// renewal. Refreshes when the token is expired or about to expire.
pub(crate) async fn usable_secret(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    provider: &dyn ConnectorProvider,
    connector: &ConnectorRecord,
) -> Result<ConnectorSecret, String> {
    let cipher = runtime
        .cipher
        .as_deref()
        .ok_or_else(|| "connector encryption is not configured".to_string())?;
    let secret = load_secret(pool, cipher, &connector.connector_id)
        .await
        .map_err(|error| error.to_string())?;
    if !secret.needs_refresh(Utc::now()) {
        return Ok(secret);
    }
    refresh_now(pool, cipher, provider, connector, &secret)
        .await
        .map_err(str::to_string)
}

/// Runs one tool with the connector's settings. When the provider answers
/// 401 to a token that has a refresh token, refreshes once and retries: a
/// token can be revoked or rotated before its stated expiry.
pub(crate) async fn execute_with_retry(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    provider: &std::sync::Arc<dyn ConnectorProvider>,
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
    match refresh_now(pool, cipher, provider.as_ref(), connector, &secret).await {
        Ok(refreshed) => provider.execute(tool, args, &refreshed, settings).await,
        Err(_) => first,
    }
}
