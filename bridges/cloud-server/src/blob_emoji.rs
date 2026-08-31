use std::{collections::HashMap, path::PathBuf, sync::LazyLock};

use axum::{
    body::Body,
    extract::Path,
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const MAX_ASSET_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobEmojiAsset {
    file: String,
    size_bytes: usize,
    sha256: String,
}

#[derive(Deserialize)]
struct BlobEmojiCatalog {
    schema: u8,
    emoji: Vec<BlobEmojiAsset>,
}

static ASSETS: LazyLock<Result<HashMap<String, BlobEmojiAsset>, ()>> = LazyLock::new(|| {
    let catalog: BlobEmojiCatalog =
        serde_json::from_str(include_str!("../../../shared/blob-emoji/catalog.json"))
            .map_err(|_| ())?;
    if catalog.schema != 2 {
        return Err(());
    }
    let mut assets = HashMap::with_capacity(catalog.emoji.len());
    for asset in catalog.emoji {
        if !asset.file.ends_with(".webp")
            || !asset
                .file
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || asset.size_bytes == 0
            || asset.size_bytes > MAX_ASSET_BYTES
            || asset.sha256.len() != 64
            || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || assets.insert(asset.file.clone(), asset).is_some()
        {
            return Err(());
        }
    }
    Ok(assets)
});

pub fn routes() -> Router {
    Router::new().route(
        "/assets/blob-emoji/:sha256/:file",
        get(asset_get).head(asset_head),
    )
}

fn asset_root() -> PathBuf {
    std::env::var_os("KORDI_BLOB_EMOJI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../shared/blob-emoji/assets")
        })
}

async fn asset_get(Path((sha256, file)): Path<(String, String)>) -> Response {
    asset_response(sha256, file, false).await
}

async fn asset_head(Path((sha256, file)): Path<(String, String)>) -> Response {
    asset_response(sha256, file, true).await
}

async fn asset_response(sha256: String, file: String, head_only: bool) -> Response {
    let Ok(assets) = ASSETS.as_ref() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(asset) = assets.get(&file) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if sha256 != asset.sha256 {
        return StatusCode::NOT_FOUND.into_response();
    }

    let bytes = match tokio::fs::read(asset_root().join(&asset.file)).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    if bytes.len() != asset.size_bytes || hex::encode(Sha256::digest(&bytes)) != asset.sha256 {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }

    let mut response = Response::new(if head_only {
        Body::empty()
    } else {
        Body::from(bytes)
    });
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&asset.size_bytes.to_string()).expect("validated Blob Emoji size"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(CACHE_CONTROL),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{}\"", asset.sha256))
            .expect("validated Blob Emoji digest"),
    );
    headers.insert(
        HeaderName::from_static("x-checksum-sha256"),
        HeaderValue::from_str(&asset.sha256).expect("validated Blob Emoji digest"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    fn fixture() -> BlobEmojiAsset {
        ASSETS
            .as_ref()
            .expect("valid Blob Emoji catalog")
            .values()
            .next()
            .expect("Blob Emoji fixture")
            .clone()
    }

    #[tokio::test]
    async fn serves_only_catalogued_content_addressed_assets() {
        let asset = fixture();
        let path = format!("/assets/blob-emoji/{}/{}", asset.sha256, asset.file);
        for method in [Method::GET, Method::HEAD] {
            let response = routes()
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
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/webp");
            assert_eq!(response.headers()[header::CACHE_CONTROL], CACHE_CONTROL);
            assert_eq!(response.headers()["x-checksum-sha256"], asset.sha256);
            let body = response.into_body().collect().await.unwrap().to_bytes();
            if method == Method::GET {
                assert_eq!(body.len(), asset.size_bytes);
                assert_eq!(hex::encode(Sha256::digest(&body)), asset.sha256);
            } else {
                assert!(body.is_empty());
            }
        }

        for path in [
            format!("/assets/blob-emoji/{}/missing.webp", asset.sha256),
            format!("/assets/blob-emoji/{}/{}", "0".repeat(64), asset.file),
        ] {
            let response = routes()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
    }
}
