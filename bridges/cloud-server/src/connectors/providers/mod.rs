//! Connector providers: OAuth endpoints and scope sets as data, plus the
//! [`ConnectorProvider`] trait the broker and the OAuth flow call into.
//!
//! PR 1 ships the framework only. [`OAuth2ConnectorProvider`] performs the
//! standard code exchange, refresh, and revoke for every provider below and
//! exposes no tools yet; provider-specific tool adapters land in PR 3.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde_json::Value;

use super::models::ConnectorToolGroup;

mod oauth2;
#[cfg(test)]
pub(crate) mod stub;

#[cfg(test)]
pub(crate) use oauth2::token_grant_from_json;
pub use oauth2::OAuth2ConnectorProvider;

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
}

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_AUTH_PARAMS: &[(&str, &str)] = &[
    ("access_type", "offline"),
    ("prompt", "consent"),
    ("include_granted_scopes", "true"),
];

pub static GOOGLE_CALENDAR: ProviderSpec = ProviderSpec {
    id: "google_calendar",
    display_name: "Google Calendar",
    env_prefix: "GOOGLE",
    auth_url: GOOGLE_AUTH_URL,
    token_url: GOOGLE_TOKEN_URL,
    revoke_url: Some(GOOGLE_REVOKE_URL),
    read_scopes: &["https://www.googleapis.com/auth/calendar.readonly"],
    act_scopes: &["https://www.googleapis.com/auth/calendar.events"],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: GOOGLE_AUTH_PARAMS,
};

pub static GMAIL: ProviderSpec = ProviderSpec {
    id: "gmail",
    display_name: "Gmail",
    env_prefix: "GOOGLE",
    auth_url: GOOGLE_AUTH_URL,
    token_url: GOOGLE_TOKEN_URL,
    revoke_url: Some(GOOGLE_REVOKE_URL),
    read_scopes: &["https://www.googleapis.com/auth/gmail.readonly"],
    act_scopes: &[
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.modify",
    ],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: GOOGLE_AUTH_PARAMS,
};

pub static GITHUB: ProviderSpec = ProviderSpec {
    id: "github",
    display_name: "GitHub",
    env_prefix: "GITHUB",
    auth_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    // GitHub revokes OAuth app grants through a Basic-authenticated
    // `DELETE /applications/{client_id}/grant`; see `revoke` below.
    revoke_url: Some("https://api.github.com/applications"),
    read_scopes: &["read:user", "notifications"],
    act_scopes: &["repo"],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: &[],
};

pub static SLACK: ProviderSpec = ProviderSpec {
    id: "slack",
    display_name: "Slack",
    env_prefix: "SLACK",
    auth_url: "https://slack.com/oauth/v2/authorize",
    token_url: "https://slack.com/api/oauth.v2.access",
    revoke_url: Some("https://slack.com/api/auth.revoke"),
    read_scopes: &[
        "channels:read",
        "channels:history",
        "groups:read",
        "groups:history",
        "users:read",
    ],
    act_scopes: &["chat:write"],
    scope_param: ScopeParam::SlackUserScope,
    supports_pkce: false,
    extra_auth_params: &[],
};

/// Every provider that can be connected today.
pub static PROVIDER_SPECS: [&ProviderSpec; 4] = [&GOOGLE_CALENDAR, &GMAIL, &GITHUB, &SLACK];

/// Providers the product names but that cannot be connected yet.
pub const NOT_YET_AVAILABLE_PROVIDERS: &[&str] = &["outlook"];

pub fn provider_spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDER_SPECS.iter().copied().find(|spec| spec.id == id)
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
}

/// A tool a provider exposes, with the group that decides who may call it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectorToolDescriptor {
    pub name: &'static str,
    pub group: ConnectorToolGroup,
    pub description: &'static str,
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
}

impl ProviderError {
    /// Fixed wording for audit summaries. Raw provider text never reaches
    /// the audit log, which the owner reads in settings.
    pub fn audit_phrase(&self) -> &'static str {
        match self {
            Self::Unauthorized => "The connector needs a new sign-in.",
            Self::Request(_) | Self::NotConfigured(_) => "The service was unreachable.",
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

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
    ) -> Result<Value, ProviderError>;
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
        for spec in PROVIDER_SPECS {
            registry.insert(Arc::new(OAuth2ConnectorProvider {
                spec,
                http: http.clone(),
            }));
        }
        registry
    }

    pub fn insert(&mut self, provider: Arc<dyn ConnectorProvider>) {
        self.providers.insert(provider.spec().id, provider);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ConnectorProvider>> {
        self.providers.get(id).cloned()
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
