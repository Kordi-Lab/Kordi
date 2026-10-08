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
};

pub(crate) const STUB_READ_TOOL: &str = "stub.list_items";
pub(crate) const STUB_ACT_TOOL: &str = "stub.post_item";

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

/// Pauses the next refresh: the stub signals `entered`, then waits for
/// `release` before returning the refreshed credential.
#[derive(Clone, Default)]
pub(crate) struct RefreshGate {
    pub(crate) entered: Arc<tokio::sync::Notify>,
    pub(crate) release: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
pub(crate) struct StubConnectorProvider {
    calls: Mutex<Vec<String>>,
    refresh_gate: Mutex<Option<RefreshGate>>,
}

impl StubConnectorProvider {
    /// Holds the next refresh until the returned gate is released.
    pub(crate) fn pause_next_refresh(&self) -> RefreshGate {
        let gate = RefreshGate::default();
        *self.refresh_gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    pub(crate) fn refresh_count(&self) -> usize {
        self.calls()
            .iter()
            .filter(|call| *call == "refresh")
            .count()
    }

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
        })
    }

    async fn refresh(
        &self,
        _client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<ConnectorSecret, ProviderError> {
        self.record("refresh".to_string());
        let gate = self.refresh_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
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
    ) -> Result<Value, ProviderError> {
        if self.tool_group(tool).is_none() {
            return Err(ProviderError::UnknownTool);
        }
        // Record which credential was used so tests can check refresh, but
        // return only tool output, as real providers must.
        self.record(format!("execute:{tool}:{}", secret.access_token));
        if args.get("fail").and_then(Value::as_bool) == Some(true) {
            // Raw provider text that must never reach the audit log.
            return Err(ProviderError::Rejected(format!(
                "upstream said no to {}",
                secret.access_token
            )));
        }
        Ok(json!({ "tool": tool, "echo": args }))
    }
}
