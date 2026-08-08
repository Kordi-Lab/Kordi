use std::collections::{BTreeMap, HashMap};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use bytes::Bytes;
use futures_util::{stream, Stream};
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use sqlx_postgres::PgPoolOptions;

use crate::events::EventBus;
use crate::server::ServerState;

use super::model::{ChannelPointer, ReleaseAsset, ReleaseManifest};
use super::routes::routes;
use super::store::{
    ReleaseCatalogStore, ReleaseObjectStream, ReleaseStoreBackend, ReleaseStoreError,
};

#[derive(Default)]
pub(super) struct MemoryBackend {
    objects: Mutex<HashMap<String, Bytes>>,
}

impl MemoryBackend {
    pub(super) fn put(&self, key: impl Into<String>, bytes: impl Into<Bytes>) {
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

pub(super) fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn signature() -> String {
    base64::engine::general_purpose::STANDARD.encode(
        b"untrusted comment: signature from minisign secret key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n",
    )
}

pub(super) fn seed_release(
    backend: &MemoryBackend,
    version: &str,
    channel: &str,
) -> ReleaseManifest {
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

pub(super) fn test_router(backend: Arc<MemoryBackend>) -> axum::Router {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    let state = ServerState::new(pool, EventBus::noop())
        .with_release_store(ReleaseCatalogStore::new(backend));
    routes(Arc::new(state))
}

pub(super) async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}
