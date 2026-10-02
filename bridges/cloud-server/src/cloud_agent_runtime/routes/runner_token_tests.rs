//! Runner routes check the shared runner token before reading a request body,
//! without a database: the refusal happens before any extractor runs.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::Poll;

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use sqlx_postgres::PgPoolOptions;
use tower::util::ServiceExt;

use crate::events::EventBus;
use crate::server::ServerState;

fn router() -> axum::Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    super::routes(Arc::new(ServerState::new(pool, EventBus::noop())))
}

/// An endless body that counts how often it is read. One chunk is larger
/// than any limit a runner route accepts.
fn counting_body(reads: Arc<AtomicUsize>) -> Body {
    let chunk = Bytes::from(vec![b'{'; 11 * 1024 * 1024]);
    Body::from_stream(futures_util::stream::poll_fn(move |_| {
        reads.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(Some(Ok::<_, std::io::Error>(chunk.clone())))
    }))
}

/// The same value as the canary lease tests, which share this process.
const RUNNER_TOKEN: &str = "canary-lease-test-runner-token";

const RUNNER_PATHS: [&str; 11] = [
    "/v1/cloud/agent-runs/lease",
    "/v1/cloud/agent-runs/car_test/omp-context",
    "/v1/cloud/agent-runs/car_test/subsession-progress",
    "/v1/cloud/agent-runs/car_test/task-operator",
    "/v1/cloud/agent-runs/car_test/plan-card",
    "/v1/cloud/agent-runs/car_test/context",
    "/v1/cloud/agent-runs/car_test/running",
    "/v1/cloud/agent-runs/car_test/complete",
    "/v1/cloud/agent-runs/car_test/fail",
    "/v1/cloud/agent-runs/car_test/provider-auth",
    "/v1/cloud/agent-runs/car_test/artifacts",
];

fn complete_request(authorization: Option<&str>, body: Body) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri("/v1/cloud/agent-runs/car_test/complete")
        .header("content-type", "application/json");
    if let Some(value) = authorization {
        request = request.header("authorization", value);
    }
    request.body(body).unwrap()
}

#[tokio::test]
async fn an_authorized_runner_request_still_reads_its_body() {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let reads = Arc::new(AtomicUsize::new(0));
    let response = router()
        .oneshot(complete_request(
            Some(&format!("Bearer {RUNNER_TOKEN}")),
            counting_body(reads.clone()),
        ))
        .await
        .unwrap();

    // The body limit, not the runner token, refuses this request.
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(reads.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
async fn runner_routes_refuse_requests_without_the_runner_token_before_reading_the_body() {
    for authorization in [None, Some("Bearer not-the-runner-token")] {
        for path in RUNNER_PATHS {
            let reads = Arc::new(AtomicUsize::new(0));
            let mut request = Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json");
            if let Some(value) = authorization {
                request = request.header("authorization", value);
            }
            let response = router()
                .oneshot(request.body(counting_body(reads.clone())).unwrap())
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["errorCode"], "invalid_runner_token", "{path}");
            assert_eq!(reads.load(Ordering::SeqCst), 0, "{path} read the body");
        }
    }
}
