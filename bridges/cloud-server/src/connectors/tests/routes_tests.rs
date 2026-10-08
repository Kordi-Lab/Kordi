//! Capabilities and route wiring.

use super::*;

// ---------------------------------------------------------------------------
// 5. Capabilities and route wiring (no database needed)

fn runtime_without_cipher() -> ConnectorRuntime {
    let mut registry = ProviderRegistry::default();
    registry.insert(Arc::new(StubConnectorProvider::default()));
    ConnectorRuntime::new(None, registry)
}

async fn capabilities(runtime: ConnectorRuntime) -> Value {
    let app = crate::server::router(lazy_state(runtime));
    let response = app
        .oneshot(
            Request::get("/v1/cloud/auth/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

#[tokio::test]
async fn capabilities_report_connectors_version_only_with_the_cipher() {
    let body = capabilities(stub_runtime().0).await;
    assert_eq!(body["connectorsVersion"], 1);
    assert_eq!(body["password"], true);
    assert!(body["oauthProviders"].is_array());

    let body = capabilities(runtime_without_cipher()).await;
    assert!(
        body.get("connectorsVersion").is_none(),
        "a server without the encryption key hides connectors: {body}"
    );
    assert_eq!(body["password"], true);
}

#[tokio::test]
async fn start_grant_is_unavailable_without_the_cipher() {
    // The cipher check runs before any database access.
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    let started = oauth::start_grant(
        &pool,
        &runtime_without_cipher(),
        "acct_any",
        STUB.id,
        ConnectorToolGroup::Read,
        None,
    )
    .await;
    assert!(matches!(started, Err(oauth::StartError::Unavailable)));
    let finished =
        oauth_complete::finish_grant(&pool, &runtime_without_cipher(), "acct_any", "code").await;
    assert!(matches!(
        finished,
        Err(oauth_complete::FinishError::Unavailable)
    ));
}

#[tokio::test]
async fn connector_routes_require_a_session_or_the_runner_token() {
    let app = crate::server::router(lazy_state(stub_runtime().0));
    let list = app
        .clone()
        .oneshot(
            Request::get("/v1/cloud/connectors")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::UNAUTHORIZED);
    let broker = app
        .clone()
        .oneshot(
            Request::post(super::super::routes::BROKER_CALL_PATH)
                .header("content-type", "application/json")
                .header("authorization", "Bearer not-the-runner-token")
                .body(Body::from(
                    json!({"leaseId":"l","accountId":"a","agentId":"g","trigger":"background",
                           "connectorId":"c","tool":"t","args":{}})
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(broker.status(), StatusCode::UNAUTHORIZED);
    let complete = app
        .clone()
        .oneshot(
            Request::post("/v1/cloud/connectors/oauth/complete")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "completionCode": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::UNAUTHORIZED);
    let callback = app
        .oneshot(
            Request::get("/v1/cloud/connectors/oauth/callback")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(callback.status(), StatusCode::BAD_REQUEST);
}
