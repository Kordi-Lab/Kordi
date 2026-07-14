use std::collections::{BTreeMap, HashMap, HashSet};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use futures_util::{stream, Stream, StreamExt};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::model::{ChannelPointer, ReleaseAsset, ReleaseManifest};
use super::store::{
    collect_bounded_metadata, MinioReleaseStore, ReleaseCatalogStore, ReleaseObjectStream,
    ReleaseStoreBackend, ReleaseStoreConfig, ReleaseStoreError, MAX_RELEASE_METADATA_BYTES,
};

const VERSION: &str = "0.0.1-beta.6";

async fn minio_head_object_with_response(
    response: &'static [u8],
) -> Result<u64, ReleaseStoreError> {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 4096];
        let bytes_read = socket.read(&mut request).await.unwrap();
        assert!(request[..bytes_read].starts_with(b"HEAD "));
        socket.write_all(response).await.unwrap();
    });
    let store = MinioReleaseStore::new(ReleaseStoreConfig {
        endpoint: format!("http://{address}").parse().unwrap(),
        region: "us-east-1".to_string(),
        bucket: "kordi-releases".to_string(),
        access_key: "test-access-key".to_string(),
        secret_key: "test-secret-key".to_string(),
    })
    .unwrap();

    let result = store.head_object("test-object").await;
    server.await.unwrap();
    result
}

#[tokio::test]
async fn minio_head_object_reads_the_content_length_header() {
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 1333\r\nConnection: close\r\n\r\n";

    assert_eq!(
        minio_head_object_with_response(response).await.unwrap(),
        1333
    );
}

#[tokio::test]
async fn minio_head_object_rejects_a_missing_content_length_header() {
    let response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";

    assert_eq!(
        minio_head_object_with_response(response).await.unwrap_err(),
        ReleaseStoreError::Unavailable
    );
}

#[tokio::test]
async fn minio_head_object_rejects_a_malformed_content_length_header() {
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: not-a-number\r\nConnection: close\r\n\r\n";

    assert_eq!(
        minio_head_object_with_response(response).await.unwrap_err(),
        ReleaseStoreError::Unavailable
    );
}

#[tokio::test]
async fn minio_head_object_rejects_duplicate_content_length_headers() {
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 1333\r\nContent-Length: 1333\r\nConnection: close\r\n\r\n";

    assert_eq!(
        minio_head_object_with_response(response).await.unwrap_err(),
        ReleaseStoreError::Unavailable
    );
}

#[tokio::test]
async fn metadata_stream_stops_as_soon_as_the_limit_is_exceeded() {
    let emitted = Arc::new(AtomicUsize::new(0));
    let counter = emitted.clone();
    let chunks = stream::iter([
        Ok(Bytes::from_static(b"123456")),
        Ok(Bytes::from_static(b"789012")),
        Ok(Bytes::from_static(b"must-not-be-read")),
    ])
    .inspect(move |_| {
        counter.fetch_add(1, Ordering::SeqCst);
    });

    assert_eq!(
        collect_bounded_metadata(chunks, 10).await.unwrap_err(),
        ReleaseStoreError::MetadataTooLarge
    );
    assert_eq!(emitted.load(Ordering::SeqCst), 2);
}

#[derive(Default)]
struct MemoryBackend {
    objects: Mutex<HashMap<String, Bytes>>,
    failed: Mutex<HashSet<String>>,
    head_sizes: Mutex<HashMap<String, u64>>,
}

impl MemoryBackend {
    fn put(&self, key: impl Into<String>, bytes: impl Into<Bytes>) {
        self.objects
            .lock()
            .unwrap()
            .insert(key.into(), bytes.into());
    }

    fn fail(&self, key: impl Into<String>) {
        self.failed.lock().unwrap().insert(key.into());
    }
}

#[async_trait]
impl ReleaseStoreBackend for MemoryBackend {
    async fn get_metadata(&self, key: &str, max_bytes: usize) -> Result<Bytes, ReleaseStoreError> {
        if self.failed.lock().unwrap().contains(key) {
            return Err(ReleaseStoreError::Unavailable);
        }
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
        if self.failed.lock().unwrap().contains(key) {
            return Err(ReleaseStoreError::Unavailable);
        }
        if let Some(size) = self.head_sizes.lock().unwrap().get(key) {
            return Ok(*size);
        }
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

fn asset(file_name: &str, updater: bool, bytes: &[u8]) -> ReleaseAsset {
    ReleaseAsset {
        object_key: format!("desktop/releases/{VERSION}/macos/aarch64/{file_name}"),
        file_name: file_name.to_string(),
        content_type: if updater {
            "application/gzip".to_string()
        } else {
            "application/x-apple-diskimage".to_string()
        },
        sha256: sha256(bytes),
        size_bytes: bytes.len() as u64,
        signature: updater.then(signature),
    }
}

fn seed(backend: &MemoryBackend, channel: &str) -> ReleaseManifest {
    let dmg = b"fixture dmg";
    let updater = b"fixture updater";
    let release = ReleaseManifest {
        schema_version: 1,
        version: VERSION.to_string(),
        notes: "Kordi beta.6".to_string(),
        pub_date: "2026-07-13T00:00:00Z".to_string(),
        changelog_url: "https://github.com/Kordi-AI/Kordi/releases/tag/V0.0.1.beta6".to_string(),
        manual: asset("Kordi_0.0.1-beta.6_aarch64.dmg", false, dmg),
        platforms: BTreeMap::from([(
            "darwin-aarch64".to_string(),
            asset("Kordi.app.tar.gz", true, updater),
        )]),
    };
    let manifest_bytes = serde_json::to_vec(&release).unwrap();
    let manifest_key = format!("desktop/releases/{VERSION}/release.json");
    let pointer = ChannelPointer {
        schema_version: 1,
        channel: channel.to_string(),
        release_manifest_key: manifest_key.clone(),
        release_manifest_sha256: sha256(&manifest_bytes),
    };
    backend.put(&manifest_key, manifest_bytes);
    backend.put(
        format!("desktop/channels/{channel}/latest.json"),
        serde_json::to_vec(&pointer).unwrap(),
    );
    backend.put(&release.manual.object_key, Bytes::from_static(dmg));
    backend.put(
        &release.platforms["darwin-aarch64"].object_key,
        Bytes::from_static(updater),
    );
    release
}

#[tokio::test]
async fn channel_load_verifies_pointer_manifest_digest_and_schema() {
    let backend = Arc::new(MemoryBackend::default());
    let expected = seed(&backend, "beta");
    let store = ReleaseCatalogStore::new(backend);

    let catalog = store.load_channel("beta").await.unwrap().unwrap();

    assert_eq!(catalog.release, expected);
    assert_eq!(catalog.pointer.channel, "beta");
}

#[tokio::test]
async fn missing_pointer_is_not_published_but_corruption_and_backend_failures_are_errors() {
    let backend = Arc::new(MemoryBackend::default());
    let store = ReleaseCatalogStore::new(backend.clone());
    assert!(store.load_channel("beta").await.unwrap().is_none());

    backend.put("desktop/channels/beta/latest.json", b"not json".as_slice());
    assert_eq!(
        store.load_channel("beta").await.unwrap_err(),
        ReleaseStoreError::InvalidMetadata
    );

    backend.put(
        "desktop/channels/beta/latest.json",
        vec![b'x'; MAX_RELEASE_METADATA_BYTES + 1],
    );
    assert_eq!(
        store.load_channel("beta").await.unwrap_err(),
        ReleaseStoreError::MetadataTooLarge
    );

    backend.fail("desktop/channels/acceptance/latest.json");
    assert_eq!(
        store.load_channel("acceptance").await.unwrap_err(),
        ReleaseStoreError::Unavailable
    );
}

#[tokio::test]
async fn strict_unpublished_tombstone_is_not_a_release_but_malformed_tombstones_fail_closed() {
    let backend = Arc::new(MemoryBackend::default());
    let key = "desktop/channels/beta/latest.json";
    backend.put(
        key,
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "channel": "beta",
            "unpublished": true,
        }))
        .unwrap(),
    );
    let store = ReleaseCatalogStore::new(backend.clone());
    assert!(store.load_channel("beta").await.unwrap().is_none());

    for malformed in [
        serde_json::json!({"schemaVersion": 1, "channel": "beta", "unpublished": false}),
        serde_json::json!({"schemaVersion": 1, "channel": "acceptance", "unpublished": true}),
        serde_json::json!({"schemaVersion": 1, "channel": "beta", "unpublished": true, "extra": 1}),
    ] {
        backend.put(key, serde_json::to_vec(&malformed).unwrap());
        assert_eq!(
            store.load_channel("beta").await.unwrap_err(),
            ReleaseStoreError::InvalidMetadata
        );
    }
}

#[tokio::test]
async fn digest_mismatch_fails_before_release_metadata_is_used() {
    let backend = Arc::new(MemoryBackend::default());
    seed(&backend, "beta");
    let key = format!("desktop/releases/{VERSION}/release.json");
    backend.put(key, b"{}".as_slice());
    let store = ReleaseCatalogStore::new(backend);

    assert_eq!(
        store.load_channel("beta").await.unwrap_err(),
        ReleaseStoreError::DigestMismatch
    );
}

#[tokio::test]
async fn version_asset_lookup_is_exact_and_allow_listed() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed(&backend, "beta");
    let store = ReleaseCatalogStore::new(backend);

    let allowed = store
        .load_allowed_asset(VERSION, "Kordi.app.tar.gz")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(allowed.asset, release.platforms["darwin-aarch64"]);
    assert!(store
        .load_allowed_asset(VERSION, "private.key")
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn object_length_mismatch_is_rejected_before_streaming() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed(&backend, "beta");
    let key = release.manual.object_key.clone();
    backend.head_sizes.lock().unwrap().insert(key, 999);
    let store = ReleaseCatalogStore::new(backend);
    let allowed = store
        .load_allowed_asset(VERSION, &release.manual.file_name)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        store.open_asset(&allowed.asset).await.unwrap_err(),
        ReleaseStoreError::LengthMismatch
    );
}

#[tokio::test]
async fn valid_object_stream_preserves_expected_size_and_bytes() {
    let backend = Arc::new(MemoryBackend::default());
    let release = seed(&backend, "beta");
    let store = ReleaseCatalogStore::new(backend);
    let mut object = store.open_asset(&release.manual).await.unwrap();
    let mut bytes = Vec::new();
    while let Some(chunk) = object.body.next().await {
        bytes.extend_from_slice(&chunk.unwrap());
    }
    assert_eq!(object.size_bytes, release.manual.size_bytes);
    assert_eq!(sha256(&bytes), release.manual.sha256);
}

#[test]
fn release_store_debug_and_errors_do_not_expose_credentials_or_internal_urls() {
    let config = ReleaseStoreConfig {
        endpoint: "http://minio.internal:9000".parse().unwrap(),
        region: "us-east-1".to_string(),
        bucket: "kordi-releases".to_string(),
        access_key: "reader-access-secret".to_string(),
        secret_key: "reader-secret-value".to_string(),
    };
    let debug = format!("{config:?}");
    assert!(!debug.contains("minio.internal"));
    assert!(!debug.contains("reader-access-secret"));
    assert!(!debug.contains("reader-secret-value"));
    assert!(!ReleaseStoreError::Unavailable.to_string().contains("http"));
}
