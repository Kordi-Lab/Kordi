use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use super::routes_test_support::{seed_release, test_router, MemoryBackend};
use super::store::ReleaseByteRange;

#[tokio::test]
async fn immutable_artifact_supports_bounded_open_ended_and_suffix_ranges() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let bytes = format!("dmg:{}", release.version).into_bytes();
    let path = format!(
        "/updates/releases/{}/{}",
        release.version, release.manual.file_name
    );
    let router = test_router(backend.clone());
    let cases = [
        ("bytes=1-3", 1, 3),
        ("bytes=4-", 4, bytes.len() - 1),
        ("bytes=-4", bytes.len() - 4, bytes.len() - 1),
        ("bytes=0-999", 0, bytes.len() - 1),
    ];

    for (header_value, start, end) in cases {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header(header::RANGE, header_value)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes {start}-{end}/{}", bytes.len())
        );
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            (end - start + 1).to_string()
        );
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            bytes[start..=end]
        );
    }

    assert_eq!(
        backend.streamed_ranges(),
        cases
            .into_iter()
            .map(|(_, start, end)| Some(ReleaseByteRange {
                start: start as u64,
                end_inclusive: end as u64,
                complete_length: bytes.len() as u64,
            }))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn invalid_and_unsatisfiable_ranges_return_416_without_opening_storage() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let path = format!(
        "/updates/releases/{}/{}",
        release.version, release.manual.file_name
    );
    let router = test_router(backend.clone());

    for range in [
        "bytes=999-",
        "bytes=4-3",
        "bytes=-0",
        "bytes=0-1,4-5",
        "items=0-1",
        "bytes=garbage",
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header(header::RANGE, range)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes */{}", release.manual.size_bytes)
        );
        assert!(to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty());
    }

    assert!(backend.streamed_ranges().is_empty());
}

#[tokio::test]
async fn if_range_requires_the_current_strong_validator() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let path = format!(
        "/updates/releases/{}/{}",
        release.version, release.manual.file_name
    );
    let response = test_router(backend.clone())
        .oneshot(
            Request::builder()
                .uri(path)
                .header(header::RANGE, "bytes=0-2")
                .header(header::IF_RANGE, "\"stale-validator\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_LENGTH],
        release.manual.size_bytes.to_string()
    );
    assert_eq!(backend.streamed_ranges(), vec![None]);
}

#[tokio::test]
async fn asset_stream_failures_terminate_the_response_body() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    backend.fail_stream(&release.manual.object_key);
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/updates/releases/{}/{}",
                    release.version, release.manual.file_name
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.into_body().collect().await.is_err());
}
