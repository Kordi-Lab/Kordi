use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

use super::routes_test_support::{body_json, seed_release, test_router, MemoryBackend};

#[tokio::test]
async fn exact_version_metadata_exposes_only_public_release_notes() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri("/updates/releases/0.0.1-beta.6/metadata")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        body_json(response).await,
        serde_json::json!({
            "schemaVersion": 1,
            "version": release.version,
            "notes": release.notes,
            "pubDate": release.pub_date,
            "changelogUrl": release.changelog_url,
        })
    );
}

#[tokio::test]
async fn exact_version_metadata_fails_closed_for_missing_or_invalid_versions() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release(&backend, "0.0.1-beta.6", "beta");
    let router = test_router(backend);

    for path in [
        "/updates/releases/0.0.1-beta.5/metadata",
        "/updates/releases/not-a-version/metadata",
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}
