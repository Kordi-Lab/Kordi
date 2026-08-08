use std::sync::{Arc, OnceLock};

use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use super::routes_test_support::{body_json, seed_release, sha256, test_router, MemoryBackend};

#[derive(Debug, PartialEq, Eq)]
enum Beta5ConfirmationAction {
    NativeInstaller(String),
    OpenProductUrl(String),
    None,
}

fn shipped_beta5_confirmation_action(json: &serde_json::Value) -> Beta5ConfirmationAction {
    if let Some(download_url) = json
        .get("downloadUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Beta5ConfirmationAction::NativeInstaller(download_url.to_string());
    }
    if let Some(changelog_url) = json
        .get("changelogUrl")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Beta5ConfirmationAction::OpenProductUrl(changelog_url.to_string());
    }
    Beta5ConfirmationAction::None
}

#[tokio::test]
async fn valid_beta_channel_returns_exact_tauri_manifest() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri("/updates/desktop/darwin/aarch64/0.0.1-beta.5.1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let correlation_id = response
        .headers()
        .get("x-kordi-update-id")
        .unwrap()
        .to_str()
        .unwrap();
    uuid::Uuid::parse_str(correlation_id).unwrap();
    assert_eq!(
        body_json(response).await,
        serde_json::json!({
            "version": "0.0.1-beta.6",
            "notes": "Kordi 0.0.1-beta.6",
            "pub_date": "2026-07-13T00:00:00Z",
            "url": "https://kordi.ai/updates/releases/0.0.1-beta.6/Kordi.app.tar.gz",
            "signature": release.platforms["darwin-aarch64"].signature,
        })
    );
}

#[tokio::test]
async fn updater_returns_204_for_equal_newer_unsupported_and_unpublished_clients() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release(&backend, "0.0.1-beta.6", "beta");
    let router = test_router(backend);
    for path in [
        "/updates/desktop/darwin/aarch64/0.0.1-beta.6",
        "/updates/desktop/darwin/aarch64/0.0.1-beta.7",
        "/updates/desktop/windows/x86_64/0.0.1-beta.5",
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT, "{path}");
    }

    let empty = test_router(Arc::new(MemoryBackend::default()));
    let response = empty
        .oneshot(
            Request::builder()
                .uri("/updates/desktop/darwin/aarch64/0.0.1-beta.5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn malformed_client_and_corrupt_catalog_fail_closed() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release(&backend, "0.0.1-beta.6", "beta");
    let router = test_router(backend.clone());
    let malformed = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/updates/desktop/darwin/aarch64/latest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(malformed.status(), StatusCode::NOT_FOUND);

    backend.put("desktop/channels/beta/latest.json", b"broken".as_slice());
    let corrupt = router
        .oneshot(
            Request::builder()
                .uri("/updates/desktop/darwin/aarch64/0.0.1-beta.5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(corrupt.status(), StatusCode::SERVICE_UNAVAILABLE);
    let text = String::from_utf8(
        corrupt
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(!text.contains("minio"));
    assert!(!text.contains("desktop/channels"));
}

#[tokio::test]
async fn acceptance_endpoint_reads_only_the_acceptance_pointer() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release(&backend, "0.0.1-beta.6", "beta");
    seed_release(&backend, "0.0.1-beta.7", "acceptance");
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri("/updates/desktop/acceptance/darwin/aarch64/0.0.1-beta.6")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await["version"], "0.0.1-beta.7");
}

#[tokio::test]
async fn immutable_artifact_get_and_head_are_allow_listed_with_integrity_headers() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let path = format!(
        "/updates/releases/{}/{}",
        release.version, release.manual.file_name
    );
    let router = test_router(backend);

    for method in [Method::GET, Method::HEAD] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(&path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            release.manual.content_type
        );
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            release.manual.size_bytes.to_string()
        );
        assert_eq!(
            response.headers()["x-checksum-sha256"],
            release.manual.sha256
        );
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        if method == Method::GET {
            assert_eq!(sha256(&body), release.manual.sha256);
        } else {
            assert!(body.is_empty());
        }
    }
}

#[tokio::test]
async fn stable_dmg_uses_beta_channel_and_no_store_cache_policy() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri("/updates/releases/latest/Kordi.dmg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(sha256(&body), release.manual.sha256);
}

#[tokio::test]
async fn unpublished_beta_tombstone_disables_updater_and_stable_download_routes() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release(&backend, "0.0.1-beta.6", "beta");
    backend.put(
        "desktop/channels/beta/latest.json",
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "channel": "beta",
            "unpublished": true,
        }))
        .unwrap(),
    );
    let router = test_router(backend);

    let updater = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/updates/desktop/darwin/aarch64/0.0.1-beta.5")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(updater.status(), StatusCode::NO_CONTENT);

    let stable = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/updates/releases/latest/Kordi.dmg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stable.status(), StatusCode::NOT_FOUND);

    let legacy = router
        .oneshot(
            Request::builder()
                .uri("/updates/releases/version")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let legacy = body_json(legacy).await;
    assert!(legacy.get("downloadUrl").is_none());
    assert!(legacy.get("signature").is_none());
}

#[tokio::test]
async fn traversal_unknown_and_unlisted_artifacts_return_404() {
    let backend = Arc::new(MemoryBackend::default());
    seed_release(&backend, "0.0.1-beta.6", "beta");
    let router = test_router(backend);
    for path in [
        "/updates/releases/0.0.1-beta.6/private.key",
        "/updates/releases/not-a-version/Kordi.dmg",
        "/updates/releases/0.0.1-beta.6/%2e%2e%2fprivate.key",
        "/updates/releases/0.0.1-beta.6/nested%5cprivate.key",
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn beta5_legacy_metadata_uses_only_the_manual_product_download_path() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed_release(&backend, "0.0.1-beta.6", "beta");
    let response = test_router(backend)
        .oneshot(
            Request::builder()
                .uri("/updates/releases/version")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let json = body_json(response).await;
    assert_eq!(json["version"], release.version);
    assert_eq!(
        json["changelogUrl"],
        "https://kordi.ai/updates/releases/latest/Kordi.dmg"
    );
    assert!(json.get("downloadUrl").is_none());
    assert!(json.get("signature").is_none());
    assert_eq!(
        shipped_beta5_confirmation_action(&json),
        Beta5ConfirmationAction::OpenProductUrl(
            "https://kordi.ai/updates/releases/latest/Kordi.dmg".to_string()
        )
    );
}

fn environment_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[tokio::test]
async fn legacy_metadata_never_authorizes_beta5_native_installation() {
    let _guard = environment_lock().lock().await;
    unsafe {
        std::env::set_var("KORDI_RELEASE_VERSION", "0.0.1-beta.12");
        std::env::set_var(
            "KORDI_RELEASE_CHANGELOG_URL",
            "https://kordi.ai/updates/releases/0.0.1-beta.12/Kordi_0.0.1-beta.12_aarch64.dmg",
        );
        std::env::set_var(
            "KORDI_RELEASE_DOWNLOAD_URL",
            "https://kordi.ai/legacy/Kordi.dmg",
        );
        std::env::set_var("KORDI_RELEASE_SIGNATURE", "legacy-signature");
    }

    let backend = Arc::new(MemoryBackend::default());
    let router = test_router(backend.clone());
    let fallback = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/updates/releases/version")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let fallback = body_json(fallback).await;
    assert_eq!(fallback["version"], "0.0.1-beta.12");
    assert!(fallback.get("downloadUrl").is_none());
    assert!(fallback.get("signature").is_none());
    assert_ne!(
        shipped_beta5_confirmation_action(&fallback),
        Beta5ConfirmationAction::NativeInstaller("https://kordi.ai/legacy/Kordi.dmg".to_string())
    );

    backend.put("desktop/channels/beta/latest.json", b"corrupt".as_slice());
    let corrupt = router
        .oneshot(
            Request::builder()
                .uri("/updates/releases/version")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let corrupt = body_json(corrupt).await;
    assert_eq!(corrupt["version"], "0.0.1-beta.12");
    assert!(corrupt.get("downloadUrl").is_none());
    assert!(corrupt.get("signature").is_none());

    unsafe {
        std::env::remove_var("KORDI_RELEASE_VERSION");
        std::env::remove_var("KORDI_RELEASE_CHANGELOG_URL");
        std::env::remove_var("KORDI_RELEASE_DOWNLOAD_URL");
        std::env::remove_var("KORDI_RELEASE_SIGNATURE");
    }
}
