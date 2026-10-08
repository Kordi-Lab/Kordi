//! A service connector: the shared OAuth 2 half plus one service adapter.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{
    ConnectorHooks, ConnectorOAuthClient, ConnectorProvider, ConnectorSecret,
    ConnectorToolDescriptor, OAuth2ConnectorProvider, PolledEvent, ProviderError, ProviderSpec,
    TokenGrant,
};

/// The service-specific half of a connector: tools, settings, identity,
/// and events. Defaults mean "not supported".
#[async_trait]
pub trait ServiceAdapter: Send + Sync + 'static {
    fn tools(&self) -> &'static [ConnectorToolDescriptor];

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        settings: &Value,
    ) -> Result<Value, ProviderError>;

    /// `None` keeps the trait default (only an empty object).
    fn validate_settings(&self, _settings: &Value) -> Option<Result<Value, String>> {
        None
    }

    async fn account_identity(
        &self,
        _secret: &ConnectorSecret,
    ) -> Result<Option<String>, ProviderError> {
        Ok(None)
    }

    fn live_subscription(&self, _hooks: &ConnectorHooks) -> bool {
        false
    }

    async fn subscribe(
        &self,
        _secret: &ConnectorSecret,
        _hooks: &ConnectorHooks,
    ) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn poll(
        &self,
        _secret: &ConnectorSecret,
        _since: DateTime<Utc>,
        _settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        Ok(Vec::new())
    }
}

pub struct ServiceProvider<A> {
    pub oauth: OAuth2ConnectorProvider,
    pub adapter: A,
}

impl<A: ServiceAdapter> ServiceProvider<A> {
    pub fn new(oauth: OAuth2ConnectorProvider, adapter: A) -> Self {
        Self { oauth, adapter }
    }
}

#[async_trait]
impl<A: ServiceAdapter> ConnectorProvider for ServiceProvider<A> {
    fn spec(&self) -> &'static ProviderSpec {
        self.oauth.spec()
    }

    fn tools(&self) -> &[ConnectorToolDescriptor] {
        self.adapter.tools()
    }

    fn oauth_client(&self) -> Result<ConnectorOAuthClient, ProviderError> {
        self.oauth.oauth_client()
    }

    async fn exchange_code(
        &self,
        client: &ConnectorOAuthClient,
        code: &str,
        code_verifier: Option<&str>,
    ) -> Result<TokenGrant, ProviderError> {
        self.oauth.exchange_code(client, code, code_verifier).await
    }

    async fn refresh(
        &self,
        client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<ConnectorSecret, ProviderError> {
        self.oauth.refresh(client, secret).await
    }

    async fn revoke(
        &self,
        client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<(), ProviderError> {
        self.oauth.revoke(client, secret).await
    }

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        settings: &Value,
    ) -> Result<Value, ProviderError> {
        if self.tool_group(tool).is_none() {
            return Err(ProviderError::UnknownTool);
        }
        if !args.is_object() && !args.is_null() {
            return Err(ProviderError::invalid("Tool arguments must be an object."));
        }
        self.adapter.execute(tool, args, secret, settings).await
    }

    fn validate_settings(&self, settings: &Value) -> Result<Value, String> {
        match self.adapter.validate_settings(settings) {
            Some(result) => result,
            None => match settings.as_object() {
                Some(map) if map.is_empty() => Ok(settings.clone()),
                _ => Err(format!("{} has no settings.", self.spec().display_name)),
            },
        }
    }

    async fn account_identity(
        &self,
        secret: &ConnectorSecret,
    ) -> Result<Option<String>, ProviderError> {
        self.adapter.account_identity(secret).await
    }

    fn live_subscription(&self, hooks: &ConnectorHooks) -> bool {
        self.adapter.live_subscription(hooks)
    }

    async fn subscribe(
        &self,
        secret: &ConnectorSecret,
        hooks: &ConnectorHooks,
    ) -> Result<(), ProviderError> {
        self.adapter.subscribe(secret, hooks).await
    }

    async fn poll(
        &self,
        secret: &ConnectorSecret,
        since: DateTime<Utc>,
        settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        self.adapter.poll(secret, since, settings).await
    }
}
