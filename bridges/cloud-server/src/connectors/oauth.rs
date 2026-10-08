//! OAuth grants for connectors, and provider revoke on disconnect.
//!
//! Uses the connector client registrations (`KORDI_CONNECTOR_*`), never the
//! sign-in clients. State is one-use, bound to the signed-in account, the
//! provider, and the grant, and expires after ten minutes.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use sqlx_postgres::PgPool;

use crate::auth::oauth::{is_allowed_oauth_redirect, pkce_challenge, random_url_token};

use super::broker::{load_secret, seal_secret};
use super::models::{ConnectorRecord, ConnectorToolGroup, OAuthPendingFragment};
use super::oauth_complete::{park_grant, GrantScopes};
use super::providers::{
    ConnectorOAuthClient, ProviderError, ProviderSpec, ScopeParam, NOT_YET_AVAILABLE_PROVIDERS,
};
use super::store::{self, ConnectorOAuthState};
use super::ConnectorRuntime;

pub const OAUTH_STATE_TTL_MINUTES: i64 = 10;

#[derive(Debug)]
pub enum StartError {
    /// The provider-auth cipher is not configured on this server.
    Unavailable,
    UnknownProvider,
    NotYetAvailable,
    NotConfigured(String),
    InvalidRedirect,
    Database(sqlx_core::Error),
}

/// Builds the provider authorize URL for one grant.
pub fn build_auth_url(
    spec: &ProviderSpec,
    client: &ConnectorOAuthClient,
    grant: ConnectorToolGroup,
    state_id: &str,
    code_verifier: &str,
) -> String {
    let mut url = url::Url::parse(spec.auth_url).expect("valid connector authorize url");
    let scopes = spec.requested_scopes(grant);
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", &client.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("state", state_id);
        match spec.scope_param {
            ScopeParam::SpaceSeparated => {
                pairs.append_pair("scope", &scopes.join(" "));
            }
            ScopeParam::SlackUserScope => {
                pairs.append_pair("user_scope", &scopes.join(","));
            }
        }
        if spec.supports_pkce {
            pairs
                .append_pair("code_challenge", &pkce_challenge(code_verifier))
                .append_pair("code_challenge_method", "S256");
        }
        for (key, value) in spec.extra_auth_params {
            pairs.append_pair(key, value);
        }
    }
    url.to_string()
}

/// Creates the one-use state and returns the provider authorize URL.
pub async fn start_grant(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    provider_id: &str,
    grant: ConnectorToolGroup,
    redirect_after: Option<&str>,
) -> Result<String, StartError> {
    if runtime.cipher.is_none() {
        return Err(StartError::Unavailable);
    }
    let provider_id = provider_id.trim();
    if NOT_YET_AVAILABLE_PROVIDERS.contains(&provider_id) {
        return Err(StartError::NotYetAvailable);
    }
    let provider = runtime
        .providers
        .get(provider_id)
        .ok_or(StartError::UnknownProvider)?;
    let spec = provider.spec();
    let client = provider.oauth_client().map_err(|error| match error {
        ProviderError::NotConfigured(message) => StartError::NotConfigured(message),
        other => StartError::NotConfigured(other.to_string()),
    })?;
    let redirect_after = redirect_after
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(target) = redirect_after {
        if !is_allowed_oauth_redirect(target) {
            return Err(StartError::InvalidRedirect);
        }
    }
    let state = ConnectorOAuthState {
        state_id: random_url_token("connector_state"),
        account_id: account_id.to_string(),
        provider: spec.id.to_string(),
        grant,
        redirect_after: redirect_after.map(str::to_string),
        code_verifier: random_url_token("connector_verifier"),
        expires_at: Utc::now() + ChronoDuration::minutes(OAUTH_STATE_TTL_MINUTES),
    };
    store::insert_oauth_state(pool, &state)
        .await
        .map_err(StartError::Database)?;
    Ok(build_auth_url(
        spec,
        &client,
        grant,
        &state.state_id,
        &state.code_verifier,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateError {
    /// Unknown, or already consumed by an earlier callback.
    UnknownOrUsed,
    Expired,
}

/// Checks a state row returned by `store::consume_oauth_state`. Consuming
/// deletes the row, so a second callback with the same state gets `None`.
pub fn check_consumed_state(
    consumed: Option<ConnectorOAuthState>,
    now: DateTime<Utc>,
) -> Result<ConnectorOAuthState, StateError> {
    let state = consumed.ok_or(StateError::UnknownOrUsed)?;
    if state.expires_at <= now {
        return Err(StateError::Expired);
    }
    Ok(state)
}

/// Where the callback sends the browser and what it reports.
#[derive(Debug)]
pub struct CallbackOutcome {
    pub redirect_after: Option<String>,
    pub result: Result<OAuthPendingFragment, CallbackError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackError {
    pub code: &'static str,
    pub message: String,
}

impl CallbackError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Splits granted scopes into the read and act sets the provider defines.
/// When the provider does not report scopes, the requested ones are used.
pub fn classify_granted_scopes(
    spec: &ProviderSpec,
    grant: ConnectorToolGroup,
    granted: Option<&[String]>,
) -> (Vec<String>, Vec<String>) {
    let requested = spec
        .requested_scopes(grant)
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let granted = granted.unwrap_or(&requested);
    let pick = |defined: &[&str]| {
        defined
            .iter()
            .filter(|scope| granted.iter().any(|value| value == *scope))
            .map(|scope| scope.to_string())
            .collect::<Vec<_>>()
    };
    let act = match grant {
        ConnectorToolGroup::Act => pick(spec.act_scopes),
        ConnectorToolGroup::Read => Vec::new(),
    };
    (pick(spec.read_scopes), act)
}

/// Handles the provider redirect back to the server: exchanges the code and
/// parks the sealed tokens as a pending grant. The grant is applied only when
/// the account that started it completes it (`oauth_complete::finish_grant`).
pub async fn complete_grant(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    state_id: Option<&str>,
    code: Option<&str>,
    provider_error: Option<&str>,
) -> CallbackOutcome {
    let fail = |redirect_after: Option<String>, error: CallbackError| CallbackOutcome {
        redirect_after,
        result: Err(error),
    };
    let Some(state_id) = state_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return fail(
            None,
            CallbackError::new("invalid_oauth_state", "Missing OAuth state."),
        );
    };
    let consumed = match store::consume_oauth_state(pool, state_id).await {
        Ok(consumed) => consumed,
        Err(error) => {
            eprintln!("[connectors] consume OAuth state: {error}");
            return fail(
                None,
                CallbackError::new("server_error", "Could not load OAuth state."),
            );
        }
    };
    let state = match check_consumed_state(consumed, Utc::now()) {
        Ok(state) => state,
        Err(StateError::UnknownOrUsed) => {
            return fail(
                None,
                CallbackError::new(
                    "invalid_oauth_state",
                    "OAuth state expired or was already used.",
                ),
            )
        }
        Err(StateError::Expired) => {
            return fail(
                None,
                CallbackError::new("invalid_oauth_state", "OAuth state expired."),
            )
        }
    };
    let redirect_after = state
        .redirect_after
        .clone()
        .filter(|target| is_allowed_oauth_redirect(target));
    if let Some(error) = provider_error {
        let message = if error == "access_denied" {
            "Access was not granted.".to_string()
        } else {
            format!("The provider returned an error: {}", truncate(error, 200))
        };
        return fail(
            redirect_after,
            CallbackError::new("provider_denied", message),
        );
    }
    let Some(code) = code.map(str::trim).filter(|value| !value.is_empty()) else {
        return fail(
            redirect_after,
            CallbackError::new("invalid_oauth_code", "Missing OAuth code."),
        );
    };
    let Some(provider) = runtime.providers.get(&state.provider) else {
        return fail(
            redirect_after,
            CallbackError::new("unknown_provider", "Unknown connector provider."),
        );
    };
    let spec = provider.spec();
    let Some(cipher) = runtime.cipher.as_deref() else {
        return fail(
            redirect_after,
            CallbackError::new(
                "connectors_unavailable",
                "Connectors are not available on this server.",
            ),
        );
    };
    let client = match provider.oauth_client() {
        Ok(client) => client,
        Err(error) => {
            return fail(
                redirect_after,
                CallbackError::new("oauth_not_configured", error.to_string()),
            )
        }
    };
    let token = match provider
        .exchange_code(&client, code, Some(&state.code_verifier))
        .await
    {
        Ok(token) => token,
        Err(error) => {
            eprintln!("[connectors] exchange {} code: {error}", spec.id);
            return fail(
                redirect_after,
                CallbackError::new("oauth_exchange_failed", "Could not finish the connection."),
            );
        }
    };
    let (read_scopes, act_scopes) =
        classify_granted_scopes(spec, state.grant, token.granted_scopes.as_deref());
    if read_scopes.is_empty() && act_scopes.is_empty() {
        return fail(
            redirect_after,
            CallbackError::new(
                "scopes_not_granted",
                "The requested access was not granted.",
            ),
        );
    }
    let sealed = match seal_secret(cipher, &token.secret) {
        Ok(sealed) => sealed,
        Err(error) => {
            eprintln!("[connectors] seal {} secret: {error}", spec.id);
            return fail(
                redirect_after,
                CallbackError::new("server_error", "Could not store the connection."),
            );
        }
    };
    let provider_account_id = match token.provider_account_id.clone() {
        Some(account) => Some(account),
        // Best effort: without it, webhooks cannot reach this connector and
        // the polling job covers it instead.
        None => provider
            .account_identity(&token.secret)
            .await
            .unwrap_or_else(|error| {
                eprintln!("[connectors] {} account identity: {error}", spec.id);
                None
            }),
    };
    let result = park_grant(
        pool,
        &state,
        spec.id,
        GrantScopes {
            read_scopes,
            act_scopes,
            provider_account_id,
        },
        sealed,
    )
    .await;
    CallbackOutcome {
        redirect_after,
        result,
    }
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Percent-encodes a fragment value; spaces become `%20`, as native URL
/// parsers do not decode `+` in fragments.
fn fragment_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// The redirect URL for the app, mirroring the sign-in callback: the result
/// rides in the fragment so it never reaches a server log.
pub fn callback_redirect_url(redirect_after: &str, outcome: &CallbackOutcome) -> String {
    let mut url = redirect_after.to_string();
    url.push(if url.contains('#') { '&' } else { '#' });
    match &outcome.result {
        Ok(fragment) => {
            url.push_str("kordi_connector=");
            url.push_str(&URL_SAFE_NO_PAD.encode(serde_json::to_vec(fragment).unwrap_or_default()));
        }
        Err(error) => {
            url.push_str("kordi_connector_error=");
            url.push_str(&fragment_component(&error.message));
            url.push_str("&kordi_connector_error_code=");
            url.push_str(&fragment_component(error.code));
        }
    }
    url
}

/// Best-effort revoke at the provider, then the local disconnect. Provider
/// errors are logged and never block the local deletion.
pub async fn disconnect_connector(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    record: &ConnectorRecord,
) -> Result<u64, sqlx_core::Error> {
    revoke_at_provider(pool, runtime, record).await;
    store::disconnect(pool, record).await
}

async fn revoke_at_provider(pool: &PgPool, runtime: &ConnectorRuntime, record: &ConnectorRecord) {
    let Some(provider) = runtime.providers.get(&record.provider) else {
        return;
    };
    let Some(cipher) = runtime.cipher.as_deref() else {
        eprintln!(
            "[connectors] revoke {}: encryption is not configured",
            record.connector_id
        );
        return;
    };
    let secret = match load_secret(pool, cipher, &record.connector_id).await {
        Ok(secret) => secret,
        Err(error) => {
            eprintln!("[connectors] revoke {}: {error}", record.connector_id);
            return;
        }
    };
    let result = match provider.oauth_client() {
        Ok(client) => provider.revoke(&client, &secret).await,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!(
            "[connectors] revoke {} at {}: {error}",
            record.connector_id, record.provider
        );
    }
}
