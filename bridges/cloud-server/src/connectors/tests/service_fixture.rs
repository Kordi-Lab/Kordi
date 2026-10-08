//! Real service providers wired to a local HTTP stub, connected through the
//! OAuth flow, for database-backed tests.

use super::http_stub::HttpStub;
use super::*;
use crate::connectors::providers::{
    github, gmail, slack, ConnectorOAuthClient, ConnectorProvider, ServiceAdapter, ServiceProvider,
};
use crate::connectors::ConnectorHooks;

fn test_client() -> ConnectorOAuthClient {
    ConnectorOAuthClient {
        client_id: "test-client".into(),
        client_secret: "test-client-secret".into(),
        redirect_uri: providers::connector_callback_url("https://kordi.test"),
    }
}

fn wire<A: ServiceAdapter>(
    stub: &HttpStub,
    mut provider: ServiceProvider<A>,
) -> Arc<dyn ConnectorProvider> {
    provider.oauth = provider
        .oauth
        .with_test_endpoints(stub.url("/token"), test_client());
    Arc::new(provider)
}

/// A runtime whose GitHub, Gmail, and Slack providers call `stub`.
pub(super) fn service_runtime(stub: &HttpStub, hooks: ConnectorHooks) -> ConnectorRuntime {
    let http = reqwest::Client::new();
    let mut registry = ProviderRegistry::default();
    registry.insert(wire(
        stub,
        github::provider(http.clone(), Some(stub.base.clone())),
    ));
    registry.insert(wire(
        stub,
        gmail::provider(http.clone(), Some(stub.base.clone())),
    ));
    registry.insert(wire(stub, slack::provider(http, Some(stub.base.clone()))));
    ConnectorRuntime::new(Some(Arc::new(TestCipher)), registry).with_hooks(hooks)
}

/// Runs the OAuth flow for `provider_id` against the stub token endpoint
/// (which the caller has primed) and returns the connector id.
pub(super) async fn connect_service(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    provider_id: &str,
    grant: ConnectorToolGroup,
) -> String {
    let auth_url = oauth::start_grant(pool, runtime, account_id, provider_id, grant, None)
        .await
        .unwrap();
    let outcome = oauth::complete_grant(
        pool,
        runtime,
        Some(&state_from_auth_url(&auth_url)),
        Some("service-code"),
        None,
    )
    .await;
    outcome.result.unwrap().connector_id
}

pub(super) fn unique_number() -> u64 {
    u64::from(Uuid::new_v4().as_u128() as u32) + 1_000_000
}

/// Stored events for a connector as (kind, external id), limited to
/// external ids starting with `prefix` (a concurrent polling test may add
/// notifications to any connector).
pub(super) async fn stored_events(
    pool: &PgPool,
    connector_id: &str,
    prefix: &str,
) -> Vec<(String, String)> {
    query_as(
        "SELECT kind, external_id FROM cloud_connector_events WHERE connector_id = $1 \
         AND starts_with(external_id, $2) ORDER BY external_id",
    )
    .bind(connector_id)
    .bind(prefix)
    .fetch_all(pool)
    .await
    .unwrap()
}
