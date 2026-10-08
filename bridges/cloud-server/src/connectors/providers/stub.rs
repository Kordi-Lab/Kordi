//! In-memory provider for tests. Records every call it receives.

use std::sync::Mutex;

use async_trait::async_trait;
use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};

use super::*;

pub(crate) static STUB: ProviderSpec = ProviderSpec {
    id: "stub",
    display_name: "Stub",
    env_prefix: "STUB",
    auth_url: "https://stub.invalid/authorize",
    token_url: "https://stub.invalid/token",
    revoke_url: Some("https://stub.invalid/revoke"),
    read_scopes: &["stub.read"],
    act_scopes: &["stub.act"],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: &[],
    catalog_scopes: &[
        ("stub.read", &["stub.items.read"]),
        ("stub.act", &["stub.items.write"]),
    ],
};

pub(crate) const STUB_READ_TOOL: &str = "stub_list_items";
pub(crate) const STUB_ACT_TOOL: &str = "stub_post_item";

static STUB_TOOLS: [ConnectorToolDescriptor; 2] = [
    ConnectorToolDescriptor {
        name: STUB_READ_TOOL,
        group: ConnectorToolGroup::Read,
        description: "List items.",
    },
    ConnectorToolDescriptor {
        name: STUB_ACT_TOOL,
        group: ConnectorToolGroup::Act,
        description: "Post an item.",
    },
];

#[derive(Default)]
pub(crate) struct StubConnectorProvider {
    calls: Mutex<Vec<String>>,
}

impl StubConnectorProvider {
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

#[async_trait]
impl ConnectorProvider for StubConnectorProvider {
    fn spec(&self) -> &'static ProviderSpec {
        &STUB
    }

    fn tools(&self) -> &[ConnectorToolDescriptor] {
        &STUB_TOOLS
    }

    fn oauth_client(&self) -> Result<ConnectorOAuthClient, ProviderError> {
        Ok(ConnectorOAuthClient {
            client_id: "stub-client".to_string(),
            client_secret: "stub-client-secret".to_string(),
            redirect_uri: connector_callback_url("https://kordi.test"),
        })
    }

    async fn exchange_code(
        &self,
        _client: &ConnectorOAuthClient,
        code: &str,
        _code_verifier: Option<&str>,
    ) -> Result<TokenGrant, ProviderError> {
        self.record(format!("exchange:{code}"));
        Ok(TokenGrant {
            secret: ConnectorSecret {
                access_token: format!("stub-access-{code}"),
                refresh_token: Some(format!("stub-refresh-{code}")),
                expires_at: Some(Utc::now() + ChronoDuration::hours(1)),
            },
            granted_scopes: None,
            provider_account_id: Some(format!("stub-user-{code}")),
        })
    }

    async fn refresh(
        &self,
        _client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<ConnectorSecret, ProviderError> {
        self.record("refresh".to_string());
        Ok(ConnectorSecret {
            access_token: format!("{}-refreshed", secret.access_token),
            refresh_token: secret.refresh_token.clone(),
            expires_at: Some(Utc::now() + ChronoDuration::hours(1)),
        })
    }

    async fn revoke(
        &self,
        _client: &ConnectorOAuthClient,
        _secret: &ConnectorSecret,
    ) -> Result<(), ProviderError> {
        self.record("revoke".to_string());
        Err(ProviderError::Request("stub revoke is unreachable".into()))
    }

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        _settings: &Value,
    ) -> Result<Value, ProviderError> {
        if self.tool_group(tool).is_none() {
            return Err(ProviderError::UnknownTool);
        }
        // Record which credential was used so tests can check refresh, but
        // return only tool output, as real providers must.
        self.record(format!("execute:{tool}:{}", secret.access_token));
        Ok(json!({ "tool": tool, "echo": args }))
    }
}
