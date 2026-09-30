//! Lease requests that select a run by id, without a database: the refusal
//! happens before any query.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use sqlx_postgres::PgPoolOptions;
use tower::util::ServiceExt;

use crate::cloud_agent_runtime::runs::CANARY_LEASES_ENV;
use crate::events::EventBus;
use crate::server::ServerState;

const RUNNER_TOKEN: &str = "canary-lease-test-runner-token";

fn router() -> axum::Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    super::routes(Arc::new(ServerState::new(pool, EventBus::noop())))
}

fn lease(body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/cloud/agent-runs/lease")
        .header("authorization", format!("Bearer {RUNNER_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn a_lease_request_cannot_select_a_regular_run_by_id() {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    std::env::remove_var(CANARY_LEASES_ENV);
    let run_id = format!("car_{}", uuid::Uuid::new_v4().simple());

    let response = router()
        .oneshot(lease(serde_json::json!({
            "runnerId": "canary-lease-test",
            "canaryRunId": run_id,
        })))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["errorCode"], "canary_lease_not_allowed");
}
