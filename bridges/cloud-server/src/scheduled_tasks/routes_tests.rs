//! The scheduled-task runner route checks the shared runner token before it
//! reads a request body, without a database: the refusal happens before any
//! extractor runs.

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

const CLAIM_PATH: &str = "/v1/cloud/scheduled-task-runs/claim";
/// The same value as the other runner token tests, which share this process.
const RUNNER_TOKEN: &str = "canary-lease-test-runner-token";

fn router() -> axum::Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    super::routes(Arc::new(ServerState::new(pool, EventBus::noop())))
}

/// An endless body that counts how often it is read.
fn counting_body(reads: Arc<AtomicUsize>) -> Body {
    let chunk = Bytes::from(vec![b'{'; 64 * 1024]);
    Body::from_stream(futures_util::stream::poll_fn(move |_| {
        reads.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(Some(Ok::<_, std::io::Error>(chunk.clone())))
    }))
}

fn claim_request(authorization: Option<&str>, body: Body) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri(CLAIM_PATH)
        .header("content-type", "application/json");
    if let Some(value) = authorization {
        request = request.header("authorization", value);
    }
    request.body(body).unwrap()
}

#[tokio::test]
async fn claims_without_the_runner_token_are_refused_before_the_body_is_read() {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    for authorization in [
        None,
        Some("Bearer not-the-runner-token"),
        Some(RUNNER_TOKEN),
    ] {
        let reads = Arc::new(AtomicUsize::new(0));
        let response = router()
            .oneshot(claim_request(authorization, counting_body(reads.clone())))
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{authorization:?}"
        );
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["errorCode"], "invalid_runner_token");
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "{authorization:?} read the body"
        );
    }
}

#[tokio::test]
async fn an_authorized_claim_still_reaches_its_body() {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let response = router()
        .oneshot(claim_request(
            Some(&format!("Bearer {RUNNER_TOKEN}")),
            Body::from(r#"{"runnerId":"#),
        ))
        .await
        .unwrap();

    // The JSON extractor, not the runner token, refuses this request.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
