//! Synthetic Calendar OAuth callbacks and native completion; no Google requests.

use super::http_stub::HttpStub;
use super::service_fixture::{connect_service, service_runtime};
use super::*;

#[tokio::test]
async fn calendar_readiness_requires_both_provider_setup_and_credential_storage() {
    let stub = HttpStub::start().await;
    let mut runtime = service_runtime(&stub, Default::default());
    assert!(
        super::super::routes::provider_readiness(&runtime)
            .iter()
            .find(|entry| entry.provider == "google_calendar")
            .unwrap()
            .oauth_ready
    );
    runtime.cipher = None;
    assert!(super::super::routes::provider_readiness(&runtime)
        .iter()
        .all(|entry| !entry.oauth_ready));
    let (runtime, _) = stub_runtime();
    assert!(super::super::routes::provider_readiness(&runtime)
        .iter()
        .all(|entry| !entry.oauth_ready));
    let message = providers::not_configured_message(&providers::GOOGLE_CALENDAR);
    assert!(message.contains("Ask your Kordi administrator"));
    assert!(!message.contains("CLIENT_SECRET") && !message.contains("CLIENT_ID"));
}

async fn complete_calendar(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    owner: &str,
    grant: ConnectorToolGroup,
) -> ConnectorRecord {
    let id = connect_service(pool, runtime, owner, "google_calendar", grant).await;
    store::load_account_connector(pool, owner, &id)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn calendar_routes_advertise_readiness_and_accept_explicit_read_only_consent() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let runtime = service_runtime(&stub, Default::default());
    let (_, token) = signed_in_account(&pool, "calendar_routes").await;
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool, EventBus::noop()).with_connector_runtime(runtime),
    ));
    let listed = body_json(
        app.clone()
            .oneshot(authed("GET", "/v1/cloud/connectors", &token, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        listed["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["provider"] == "google_calendar")
            .unwrap()["oauthReady"],
        true
    );
    let response = app
        .oneshot(authed(
            "POST",
            "/v1/cloud/connectors/google_calendar/oauth/start",
            &token,
            Some(json!({"grant": "read_only"})),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let url = url::Url::parse(body["authUrl"].as_str().unwrap()).unwrap();
    let scope = url
        .query_pairs()
        .find(|(key, _)| key == "scope")
        .unwrap()
        .1
        .to_string();
    assert_eq!(scope, providers::GOOGLE_CALENDAR.read_scopes.join(" "));
}

#[tokio::test]
async fn calendar_consent_tracks_provider_scopes_without_implicitly_enabling_act() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let runtime = service_runtime(&stub, Default::default());
    let (owner, _) = signed_in_account(&pool, "calendar_read").await;
    let spec = &providers::GOOGLE_CALENDAR;
    let read = spec.read_scopes.join(" ");
    let broad = spec.requested_scopes(ConnectorToolGroup::Act).join(" ");
    let token = |scope: &str| json!({"access_token": "synthetic-token", "token_type": "Bearer", "scope": scope});
    stub.respond("POST", "/token", token(&read));
    let first = complete_calendar(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert!(!first.act_enabled && first.act_scopes.is_empty());

    // A previously granted Google permission can be returned during read consent.
    stub.respond("POST", "/token", token(&broad));
    let broad_read = complete_calendar(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert_eq!(broad_read.connector_id, first.connector_id);
    assert!(
        !broad_read.act_scopes.is_empty(),
        "report the provider grant accurately"
    );
    assert!(
        !broad_read.act_enabled,
        "provider scope is not Kordi acting consent"
    );
    let explicit = complete_calendar(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    assert!(explicit.act_enabled);
    let reconnected = complete_calendar(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert!(
        !reconnected.act_enabled,
        "a read-only reconnect turns acting off"
    );

    // The new token is read only: do not merge stale write scope into its summary.
    stub.respond("POST", "/token", token(&read));
    let downgraded = complete_calendar(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert!(downgraded.act_scopes.is_empty() && !downgraded.act_enabled);
    assert_eq!(downgraded.read_scopes, spec.read_scopes);
    assert_eq!(
        store::agent_grants(&pool, std::slice::from_ref(&first.connector_id))
            .await
            .unwrap()[&first.connector_id],
        vec![store::default_agent_id(&owner)]
    );
}

#[tokio::test]
async fn new_calendar_read_consent_with_existing_provider_write_scope_starts_act_off() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let runtime = service_runtime(&stub, Default::default());
    let (owner, _) = signed_in_account(&pool, "calendar_broad_read").await;
    stub.respond("POST", "/token", json!({"access_token": "synthetic-token", "token_type": "Bearer", "scope": providers::GOOGLE_CALENDAR.requested_scopes(ConnectorToolGroup::Act).join(" ")}));
    let record = complete_calendar(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert!(!record.act_scopes.is_empty());
    assert!(!record.act_enabled);
}
