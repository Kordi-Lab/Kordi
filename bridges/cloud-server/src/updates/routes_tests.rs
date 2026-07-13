use std::collections::{BTreeMap, HashMap};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::{header, Method, Request, StatusCode};
use base64::Engine;
use bytes::Bytes;
use futures_util::{stream, Stream};
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use sqlx_postgres::PgPoolOptions;
use tower::ServiceExt;

use crate::events::EventBus;
use crate::server::ServerState;

use super::model::{ChannelPointer, ReleaseAsset, ReleaseManifest};
use super::routes::routes;
use super::store::{
    ReleaseCatalogStore, ReleaseObjectStream, ReleaseStoreBackend, ReleaseStoreError,
};

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

#[derive(Default)]
struct MemoryBackend {
    objects: Mutex<HashMap<String, Bytes>>,
}

impl MemoryBackend {
    fn put(&self, key: impl Into<String>, bytes: impl Into<Bytes>) {
        self.objects
            .lock()
            .unwrap()
            .insert(key.into(), bytes.into());
    }
}

#[async_trait]
impl ReleaseStoreBackend for MemoryBackend {
    async fn get_metadata(&self, key: &str, max_bytes: usize) -> Result<Bytes, ReleaseStoreError> {
        let bytes = self
            .objects
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(ReleaseStoreError::NotFound)?;
        if bytes.len() > max_bytes {
            return Err(ReleaseStoreError::MetadataTooLarge);
        }
        Ok(bytes)
    }

    async fn head_object(&self, key: &str) -> Result<u64, ReleaseStoreError> {
        self.objects
            .lock()
            .unwrap()
            .get(key)
            .map(|bytes| bytes.len() as u64)
            .ok_or(ReleaseStoreError::NotFound)
    }

    async fn stream_object(&self, key: &str) -> Result<ReleaseObjectStream, ReleaseStoreError> {
        let bytes = self
            .objects
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(ReleaseStoreError::NotFound)?;
        let size_bytes = bytes.len() as u64;
        let body: Pin<Box<dyn Stream<Item = Result<Bytes, ReleaseStoreError>> + Send>> =
            Box::pin(stream::once(async move { Ok(bytes) }));
        Ok(ReleaseObjectStream { size_bytes, body })
    }
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn signature() -> String {
    base64::engine::general_purpose::STANDARD.encode(
        b"untrusted comment: signature from minisign secret key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
    )
}

fn seed_release(backend: &MemoryBackend, version: &str, channel: &str) -> ReleaseManifest {
    let dmg = format!("dmg:{version}").into_bytes();
    let updater = format!("updater:{version}").into_bytes();
    let prefix = format!("desktop/releases/{version}/macos/aarch64");
    let manual = ReleaseAsset {
        object_key: format!("{prefix}/Kordi_{version}_aarch64.dmg"),
        file_name: format!("Kordi_{version}_aarch64.dmg"),
        content_type: "application/x-apple-diskimage".to_string(),
        sha256: sha256(&dmg),
        size_bytes: dmg.len() as u64,
        signature: None,
    };
    let updater_asset = ReleaseAsset {
        object_key: format!("{prefix}/Kordi.app.tar.gz"),
        file_name: "Kordi.app.tar.gz".to_string(),
        content_type: "application/gzip".to_string(),
        sha256: sha256(&updater),
        size_bytes: updater.len() as u64,
        signature: Some(signature()),
    };
    let release = ReleaseManifest {
        schema_version: 1,
        version: version.to_string(),
        notes: format!("Kordi {version}"),
        pub_date: "2026-07-13T00:00:00Z".to_string(),
        changelog_url: format!(
            "https://github.com/Kordi-AI/Kordi/releases/tag/V{}",
            version.replace("0.0.1-beta.", "0.0.1.beta")
        ),
        manual,
        platforms: BTreeMap::from([("darwin-aarch64".to_string(), updater_asset)]),
    };
    let manifest = serde_json::to_vec(&release).unwrap();
    let manifest_key = format!("desktop/releases/{version}/release.json");
    let pointer = ChannelPointer {
        schema_version: 1,
        channel: channel.to_string(),
        release_manifest_key: manifest_key.clone(),
        release_manifest_sha256: sha256(&manifest),
    };
    backend.put(manifest_key, manifest);
    backend.put(
        format!("desktop/channels/{channel}/latest.json"),
        serde_json::to_vec(&pointer).unwrap(),
    );
    backend.put(&release.manual.object_key, dmg);
    backend.put(&release.platforms["darwin-aarch64"].object_key, updater);
    release
}

fn test_router(backend: Arc<MemoryBackend>) -> axum::Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    let state = ServerState::new(pool, EventBus::noop())
        .with_release_store(ReleaseCatalogStore::new(backend));
    routes(Arc::new(state))
}

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
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
            "url": "https://coordinar.io/updates/releases/0.0.1-beta.6/Kordi.app.tar.gz",
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
        "https://coordinar.io/updates/releases/latest/Kordi.dmg"
    );
    assert!(json.get("downloadUrl").is_none());
    assert!(json.get("signature").is_none());
    assert_eq!(
        shipped_beta5_confirmation_action(&json),
        Beta5ConfirmationAction::OpenProductUrl(
            "https://coordinar.io/updates/releases/latest/Kordi.dmg".to_string()
        )
    );
}

fn environment_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[tokio::test]
async fn legacy_metadata_never_authorizes_beta5_native_installation() {
    let _guard = environment_lock().lock().unwrap();
    unsafe {
        std::env::set_var("KORDI_RELEASE_VERSION", "0.0.1-beta.5");
        std::env::set_var(
            "KORDI_RELEASE_CHANGELOG_URL",
            "https://coordinar.io/updates/releases/version",
        );
        std::env::set_var(
            "KORDI_RELEASE_DOWNLOAD_URL",
            "https://coordinar.io/legacy/Kordi.dmg",
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
    assert_eq!(fallback["version"], "0.0.1-beta.5");
    assert!(fallback.get("downloadUrl").is_none());
    assert!(fallback.get("signature").is_none());
    assert_ne!(
        shipped_beta5_confirmation_action(&fallback),
        Beta5ConfirmationAction::NativeInstaller(
            "https://coordinar.io/legacy/Kordi.dmg".to_string()
        )
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
    assert_eq!(corrupt["version"], "0.0.1-beta.5");
    assert!(corrupt.get("downloadUrl").is_none());
    assert!(corrupt.get("signature").is_none());

    unsafe {
        std::env::remove_var("KORDI_RELEASE_VERSION");
        std::env::remove_var("KORDI_RELEASE_CHANGELOG_URL");
        std::env::remove_var("KORDI_RELEASE_DOWNLOAD_URL");
        std::env::remove_var("KORDI_RELEASE_SIGNATURE");
    }
}
