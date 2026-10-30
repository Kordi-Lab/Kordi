use super::routes_test_support::{sha256, test_router, MemoryBackend};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

fn fixture() -> (Arc<MemoryBackend>, serde_json::Value) {
    let backend = Arc::new(MemoryBackend::default());
    backend.put(
        "desktop/releases/1.2.3/sources/bun.part0000",
        "source bytes",
    );
    let manifest = serde_json::json!({"schemaVersion":1,"version":"1.2.3","releaseCommit":"a".repeat(40),"catalogSha256":"b".repeat(64),"pubDate":"2026-01-01T00:00:00Z","materials":[],"files":[{"fileName":"bun.part0000","sha256":sha256(b"source bytes"),"sizeBytes":12}]});
    backend.put(
        "desktop/releases/1.2.3/sources/manifest.json",
        serde_json::to_vec(&manifest).unwrap(),
    );
    (backend, manifest)
}
#[tokio::test]
async fn source_downloads_are_public_bounded_and_support_ranges() {
    let (backend, _) = fixture();
    let app = test_router(backend);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/updates/releases/1.2.3/sources/manifest.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/updates/releases/1.2.3/sources/bun.part0000")
                .header("Range", "bytes=0-5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        &response.into_body().collect().await.unwrap().to_bytes()[..],
        b"source"
    );
}
#[tokio::test]
async fn source_downloads_never_expose_unlisted_objects() {
    let (backend, _) = fixture();
    backend.put("desktop/releases/1.2.3/sources/unlisted.txt", "not listed");
    for name in ["unlisted.txt", "..%2Fprivate.txt"] {
        let response = test_router(backend.clone())
            .oneshot(
                Request::builder()
                    .uri(format!("/updates/releases/1.2.3/sources/{name}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
#[tokio::test]
async fn malformed_source_manifests_fail_closed() {
    let (backend, mut manifest) = fixture();
    manifest["files"][0]["fileName"] = "../private.txt".into();
    backend.put(
        "desktop/releases/1.2.3/sources/manifest.json",
        serde_json::to_vec(&manifest).unwrap(),
    );
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri("/updates/releases/1.2.3/sources/manifest.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}
