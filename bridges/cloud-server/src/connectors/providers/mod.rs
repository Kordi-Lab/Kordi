//! Connector providers: the [`ConnectorProvider`] trait the broker, the OAuth
//! flow, webhooks, and the polling job call into, plus the registry.
//!
//! OAuth endpoints and scopes live in `specs.rs`. [`OAuth2ConnectorProvider`]
//! performs the standard code exchange, refresh, and revoke; each service in
//! `google_calendar.rs`, `gmail.rs`, `github.rs`, and `slack.rs` adds its
//! tools, event polling, and settings through [`service::ServiceAdapter`].

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::Value;

use super::models::ConnectorToolGroup;
use super::ConnectorHooks;

pub mod github;
pub mod gmail;
pub mod google_calendar;
pub mod http;
mod oauth2;
pub mod service;
pub mod slack;
mod specs;
#[cfg(test)]
pub(crate) mod stub;

#[cfg(test)]
pub(crate) use oauth2::token_grant_from_json;
pub use oauth2::OAuth2ConnectorProvider;
pub use service::{ServiceAdapter, ServiceProvider};
pub use specs::{
    provider_spec, GITHUB, GMAIL, GOOGLE_CALENDAR, NOT_YET_AVAILABLE_PROVIDERS, PROVIDER_SPECS,
    SLACK,
};

/// How the provider wants scopes on the authorize URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeParam {
    /// `scope=a b c`
    SpaceSeparated,
    /// `user_scope=a,b,c` (Slack user tokens)
    SlackUserScope,
}

#[derive(Debug)]
pub struct ProviderSpec {
    /// Stable id used in routes and the `provider` column.
    pub id: &'static str,
    pub display_name: &'static str,
    /// `KORDI_CONNECTOR_<prefix>_CLIENT_ID` and `_CLIENT_SECRET`.
    pub env_prefix: &'static str,
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub revoke_url: Option<&'static str>,
    pub read_scopes: &'static [&'static str],
    pub act_scopes: &'static [&'static str],
    pub scope_param: ScopeParam,
    pub supports_pkce: bool,
    pub extra_auth_params: &'static [(&'static str, &'static str)],
    /// Provider-native scope to the catalog scope ids the clients show
    /// (`<provider>.<thing>.<access>`).
    pub catalog_scopes: &'static [(&'static str, &'static [&'static str])],
}

impl ProviderSpec {
    /// Scopes to request for `grant`. An `act` grant also asks for the read
    /// scopes so a provider that replaces scopes keeps read working.
    pub fn requested_scopes(&self, grant: ConnectorToolGroup) -> Vec<&'static str> {
        match grant {
            ConnectorToolGroup::Read => self.read_scopes.to_vec(),
            ConnectorToolGroup::Act => self
                .read_scopes
                .iter()
                .chain(self.act_scopes.iter())
                .copied()
                .collect(),
        }
    }

    /// Catalog scope ids covered by `granted` provider-native scopes, in
    /// catalog order and without duplicates.
    pub fn catalog_scope_ids(&self, granted: &[String]) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for (native, catalog) in self.catalog_scopes {
            if granted.iter().any(|scope| scope == native) {
                for id in *catalog {
                    if !ids.iter().any(|existing| existing == id) {
                        ids.push((*id).to_string());
                    }
                }
            }
        }
        ids
    }
}

/// The connector OAuth client for one provider. Separate from the sign-in
/// clients in `auth/oauth.rs`.
#[derive(Clone)]
pub struct ConnectorOAuthClient {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
}

impl std::fmt::Debug for ConnectorOAuthClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorOAuthClient")
            .field("client_id", &self.client_id)
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

pub fn client_id_env(spec: &ProviderSpec) -> String {
    format!("KORDI_CONNECTOR_{}_CLIENT_ID", spec.env_prefix)
}

pub fn client_secret_env(spec: &ProviderSpec) -> String {
    format!("KORDI_CONNECTOR_{}_CLIENT_SECRET", spec.env_prefix)
}

pub fn connector_callback_url(public_base: &str) -> String {
    format!(
        "{}/v1/cloud/connectors/oauth/callback",
        public_base.trim_end_matches('/')
    )
}

/// Builds the client from explicit values; `None` when either half is blank.
pub fn oauth_client_from_values(
    client_id: &str,
    client_secret: &str,
    public_base: &str,
) -> Option<ConnectorOAuthClient> {
    let client_id = client_id.trim();
    let client_secret = client_secret.trim();
    if client_id.is_empty() || client_secret.is_empty() {
        return None;
    }
    Some(ConnectorOAuthClient {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        redirect_uri: connector_callback_url(public_base),
    })
}

pub fn oauth_client_from_env(spec: &ProviderSpec) -> Result<ConnectorOAuthClient, ProviderError> {
    let client_id = std::env::var(client_id_env(spec)).unwrap_or_default();
    let client_secret = std::env::var(client_secret_env(spec)).unwrap_or_default();
    oauth_client_from_values(
        &client_id,
        &client_secret,
        &crate::auth::oauth::public_base_url(),
    )
    .ok_or_else(|| ProviderError::NotConfigured(not_configured_message(spec)))
}

pub fn not_configured_message(spec: &ProviderSpec) -> String {
    format!(
        "{} connections are not available on this server yet. Set {} and {}.",
        spec.display_name,
        client_id_env(spec),
        client_secret_env(spec)
    )
}

/// A provider credential in memory. Not `Serialize`, and `Debug` redacts,
/// so it cannot reach a response or a log line by accident.
#[derive(Clone, PartialEq, Eq)]
pub struct ConnectorSecret {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl std::fmt::Debug for ConnectorSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectorSecret")
            .field("access_token", &"[redacted]")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[redacted]"),
            )
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl ConnectorSecret {
    /// True when the access token is past, or within a minute of, expiry.
    pub fn needs_refresh(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .is_some_and(|expires_at| expires_at <= now + ChronoDuration::seconds(60))
    }
}

/// Result of a code exchange.
#[derive(Debug, Clone)]
pub struct TokenGrant {
    pub secret: ConnectorSecret,
    /// Scopes the provider reports as granted, when it reports them.
    pub granted_scopes: Option<Vec<String>>,
    /// The account at the provider, when the token response names it
    /// (Slack: `<team id>:<user id>`). Webhooks find connectors by it.
    pub provider_account_id: Option<String>,
}

/// A tool a provider exposes, with the group that decides who may call it.
/// Names match `^[a-zA-Z0-9_-]+$` because model providers reject dots.
/// Argument schemas live in `connectors::tool_schemas`, keyed by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectorToolDescriptor {
    pub name: &'static str,
    pub group: ConnectorToolGroup,
    pub description: &'static str,
}

/// The argument schema of a service connector tool, when one of the
/// providers here defines it.
pub fn input_schema(tool: &str) -> Option<Value> {
    google_calendar::input_schema(tool)
        .or_else(|| gmail::input_schema(tool))
        .or_else(|| github::input_schema(tool))
        .or_else(|| slack::input_schema(tool))
}

/// One event a provider reported through polling or a webhook.
#[derive(Debug, Clone, PartialEq)]
pub struct PolledEvent {
    pub kind: String,
    /// Unique per occurrence; the store records each one once.
    pub external_id: String,
    pub occurred_at: DateTime<Utc>,
    /// Compact, token-free summary of the event.
    pub payload: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("{0}")]
    NotConfigured(String),
    #[error("unknown connector tool")]
    UnknownTool,
    /// The credential is gone for good (`invalid_grant`, or a 401 from a
    /// tool call). The connector needs a new sign-in.
    #[error("the provider rejected the credential")]
    Unauthorized,
    /// The provider could not be reached. Retryable.
    #[error("provider request failed: {0}")]
    Request(String),
    /// The provider answered with an error other than `invalid_grant`.
    /// Retryable; the connector stays connected.
    #[error("provider rejected the request: {0}")]
    Rejected(String),
    #[error("provider response was not understood")]
    InvalidResponse,
    /// The tool arguments or settings were rejected before any provider
    /// call. The message is ours and safe to show.
    #[error("{0}")]
    InvalidInput(String),
}

impl ProviderError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidInput(message.into())
    }
}

impl ProviderError {
    /// Fixed wording for audit summaries. Raw provider text never reaches
    /// the audit log, which the owner reads in settings.
    pub fn audit_phrase(&self) -> &'static str {
        match self {
            Self::Unauthorized => "The connector needs a new sign-in.",
            Self::Request(_) | Self::NotConfigured(_) => "The service was unreachable.",
            Self::InvalidInput(_) => "The tool input was rejected.",
            Self::Rejected(_) | Self::InvalidResponse | Self::UnknownTool => {
                "The service rejected the request."
            }
        }
    }
}

#[async_trait]
pub trait ConnectorProvider: Send + Sync {
    fn spec(&self) -> &'static ProviderSpec;

    /// Every tool this provider exposes, with its group.
    fn tools(&self) -> &[ConnectorToolDescriptor];

    fn tool_group(&self, tool: &str) -> Option<ConnectorToolGroup> {
        self.tools()
            .iter()
            .find(|descriptor| descriptor.name == tool)
            .map(|descriptor| descriptor.group)
    }

    /// The connector OAuth client, or `NotConfigured` with a clear message.
    fn oauth_client(&self) -> Result<ConnectorOAuthClient, ProviderError> {
        oauth_client_from_env(self.spec())
    }

    async fn exchange_code(
        &self,
        client: &ConnectorOAuthClient,
        code: &str,
        code_verifier: Option<&str>,
    ) -> Result<TokenGrant, ProviderError>;

    async fn refresh(
        &self,
        client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<ConnectorSecret, ProviderError>;

    async fn revoke(
        &self,
        client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<(), ProviderError>;

    /// Runs one tool. `settings` is the connector's validated settings
    /// (for example the Slack channels the person chose).
    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        settings: &Value,
    ) -> Result<Value, ProviderError>;

    /// Validates and normalizes settings for `PUT /:id/settings`. Providers
    /// without settings accept only an empty object.
    fn validate_settings(&self, settings: &Value) -> Result<Value, String> {
        match settings.as_object() {
            Some(map) if map.is_empty() => Ok(settings.clone()),
            _ => Err(format!("{} has no settings.", self.spec().display_name)),
        }
    }

    /// The provider account behind a fresh credential, stored at grant time
    /// so webhooks can find the connector.
    async fn account_identity(
        &self,
        _secret: &ConnectorSecret,
    ) -> Result<Option<String>, ProviderError> {
        Ok(None)
    }

    /// True when this server receives live events for the provider, so the
    /// polling job skips it.
    fn live_subscription(&self, _hooks: &ConnectorHooks) -> bool {
        false
    }

    /// Creates or renews the live subscription for one connector.
    async fn subscribe(
        &self,
        _secret: &ConnectorSecret,
        _hooks: &ConnectorHooks,
    ) -> Result<(), ProviderError> {
        Ok(())
    }

    /// Events since `since`, for providers without a live subscription.
    async fn poll(
        &self,
        _secret: &ConnectorSecret,
        _since: DateTime<Utc>,
        _settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        Ok(Vec::new())
    }
}

/// Providers by id. Production uses [`ProviderRegistry::production`]; tests
/// insert the stub.
#[derive(Clone, Default)]
pub struct ProviderRegistry {
    providers: HashMap<&'static str, Arc<dyn ConnectorProvider>>,
}

impl ProviderRegistry {
    pub fn production() -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        let mut registry = Self::default();
        registry.insert(Arc::new(google_calendar::provider(http.clone(), None)));
        registry.insert(Arc::new(gmail::provider(http.clone(), None)));
        registry.insert(Arc::new(github::provider(http.clone(), None)));
        registry.insert(Arc::new(slack::provider(http, None)));
        registry
    }

    pub fn insert(&mut self, provider: Arc<dyn ConnectorProvider>) {
        self.providers.insert(provider.spec().id, provider);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ConnectorProvider>> {
        self.providers.get(id).cloned()
    }

    pub fn all(&self) -> impl Iterator<Item = &Arc<dyn ConnectorProvider>> {
        self.providers.values()
    }
}

/// Splits a provider scope string on commas and whitespace.
pub fn parse_scope_list(value: &str) -> Vec<String> {
    value
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect()
}
