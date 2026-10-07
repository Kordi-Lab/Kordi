//! Capabilities and route wiring.

use super::*;

// ---------------------------------------------------------------------------
// 5. Capabilities and route wiring (no database needed)

#[tokio::test]
async fn capabilities_report_connectors_version() {
    let app = crate::server::router(lazy_state(stub_runtime().0));
    let response = app
        .oneshot(
            Request::get("/v1/cloud/auth/capabilities")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["connectorsVersion"], 1);
    assert_eq!(body["password"], true);
    assert!(body["oauthProviders"].is_array());
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
