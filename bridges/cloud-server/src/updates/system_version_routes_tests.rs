use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use tower::ServiceExt;

use super::routes_test_support::{
    body_json, seed_release_with_minimum, test_router, MemoryBackend,
};

const OS_HEADER: &str = "x-kordi-os-version";

fn request(path: &str, versions: &[&str]) -> Request<Body> {
    let mut request = Request::builder().uri(path);
    for version in versions {
        request = request.header(OS_HEADER, *version);
    }
    request.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn required_system_version_fails_closed_on_both_channels() {
    for channel in ["beta", "acceptance"] {
        let backend = Arc::new(MemoryBackend::default());
        seed_release_with_minimum(&backend, "0.0.2-beta.6", channel, Some("13.0"));
        let router = test_router(backend);
        let prefix = if channel == "beta" { "" } else { "acceptance/" };
        let path = format!("/updates/desktop/{prefix}darwin/aarch64/0.0.2-beta.5.2");
        for versions in [
            vec![],
            vec!["12.7.6"],
            vec!["unknown"],
            vec!["13"],
            vec!["13.0-beta"],
            vec!["013.0"],
            vec!["13.0,14.0"],
            vec!["13.0", "14.0"],
            vec!["13.0", "13.0"],
            vec!["65536.0"],
        ] {
            let response = router
                .clone()
                .oneshot(request(&path, &versions))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NO_CONTENT,
                "{channel}: {versions:?}"
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::VARY], OS_HEADER);
        }
        for version in ["13.0", "13.0.0", "13.6.1", "14.0", "27.0.1"] {
            let response = router
                .clone()
                .oneshot(request(&path, &[version]))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{channel}: {version}");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::VARY], OS_HEADER);
            let body = body_json(response).await;
            assert_eq!(body["version"], "0.0.2-beta.6");
            assert_eq!(
                body["url"],
                "https://kordi.ai/updates/releases/0.0.2-beta.6/Kordi.app.tar.gz"
            );
            assert!(body.get("minimumSystemVersion").is_none());
        }
    }
}

#[tokio::test]
async fn system_version_comparison_respects_minor_and_patch_components() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release_with_minimum(&backend, "0.0.2-beta.6", "beta", Some("13.2.1"));
    let router = test_router(backend);
    let path = "/updates/desktop/darwin/aarch64/0.0.2-beta.5.2";
    for (version, expected) in [
        ("13.2", StatusCode::NO_CONTENT),
        ("13.2.0", StatusCode::NO_CONTENT),
        ("13.1.99", StatusCode::NO_CONTENT),
        ("13.2.1", StatusCode::OK),
        ("13.10", StatusCode::OK),
        ("14.0", StatusCode::OK),
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(request(path, &[version]))
                .await
                .unwrap()
                .status(),
            expected,
            "{version}"
        );
    }
}

#[tokio::test]
async fn legacy_release_without_minimum_preserves_headerless_update_behavior() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release_with_minimum(&backend, "0.0.2-beta.5.2", "beta", None);
    assert!(
        serde_json::to_value(release).unwrap()["platforms"]["darwin-aarch64"]
            .get("minimumSystemVersion")
            .is_none()
    );
    let router = test_router(backend);
    for versions in [vec![], vec!["12.0"], vec!["unknown"], vec!["12.0", "13.0"]] {
        let response = router
            .clone()
            .oneshot(request(
                "/updates/desktop/darwin/aarch64/0.0.2-beta.5.1",
                &versions,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

#[tokio::test]
async fn minimum_does_not_change_manual_download_or_existing_version_selection() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release_with_minimum(&backend, "0.0.2-beta.6", "beta", Some("13.0"));
    let router = test_router(backend);
    for path in [
        "/updates/releases/latest/Kordi.dmg",
        "/updates/releases/0.0.2-beta.6/Kordi_0.0.2-beta.6_aarch64.dmg",
    ] {
        let response = router.clone().oneshot(request(path, &[])).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-apple-diskimage"
        );
    }
    let legacy = body_json(
        router
            .clone()
            .oneshot(request("/updates/releases/version", &[]))
            .await
            .unwrap(),
    )
    .await;
    assert!(legacy.get("downloadUrl").is_none());
    assert!(legacy.get("signature").is_none());
    assert_eq!(
        legacy["changelogUrl"],
        "https://kordi.ai/updates/releases/latest/Kordi.dmg"
    );
    for path in [
        "/updates/desktop/darwin/aarch64/0.0.2-beta.6",
        "/updates/desktop/darwin/aarch64/0.0.2-beta.7",
        "/updates/desktop/windows/x86_64/0.0.2-beta.5.2",
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(request(path, &["14.0"]))
                .await
                .unwrap()
                .status(),
            StatusCode::NO_CONTENT
        );
    }
}

#[tokio::test]
async fn invalid_minimum_metadata_is_unavailable_instead_of_an_update() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release_with_minimum(&backend, "0.0.2-beta.6", "beta", Some("13.x"));
    let response = test_router(backend)
        .oneshot(request(
            "/updates/desktop/darwin/aarch64/0.0.2-beta.5.2",
            &["14.0"],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::VARY], OS_HEADER);
}
