use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use semver::Version;
use serde::Serialize;
use url::Url;

use crate::server::ServerState;

use super::model::{select_update, ReleaseAsset, UpdateDecision};
use super::store::{ReleaseCatalogStore, ReleaseStoreError};

const DEFAULT_PUBLIC_BASE_URL: &str = "https://coordinar.io";
const IMMUTABLE_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route(
            "/updates/desktop/:target/:arch/:current_version",
            get(beta_update),
        )
        .route(
            "/updates/desktop/acceptance/:target/:arch/:current_version",
            get(acceptance_update),
        )
        .route(
            "/updates/releases/latest/Kordi.dmg",
            get(stable_dmg_get).head(stable_dmg_head),
        )
        .route(
            "/updates/releases/:version/:asset",
            get(immutable_asset_get).head(immutable_asset_head),
        )
        .route("/updates/releases/version", get(legacy_release_version))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct PublicError {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
    message: &'static str,
}

#[derive(Debug, Serialize)]
struct TauriUpdateResponse {
    version: String,
    notes: String,
    pub_date: String,
    url: String,
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyReleaseVersionResponse {
    version: String,
    changelog_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_command: Option<String>,
}

fn public_error(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(PublicError {
            error_code: code,
            message,
        }),
    )
        .into_response()
}

fn not_found() -> Response {
    public_error(
        StatusCode::NOT_FOUND,
        "release_not_found",
        "The requested desktop release was not found.",
    )
}

fn unavailable() -> Response {
    public_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "release_unavailable",
        "Desktop release storage is temporarily unavailable.",
    )
}

fn public_base_url() -> String {
    let configured = std::env::var("KORDI_CLOUD_PUBLIC_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());
    let candidate = configured.as_deref().unwrap_or(DEFAULT_PUBLIC_BASE_URL);
    let Ok(url) = Url::parse(candidate) else {
        return DEFAULT_PUBLIC_BASE_URL.to_string();
    };
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return DEFAULT_PUBLIC_BASE_URL.to_string();
    }
    candidate.to_string()
}

fn release_store(state: &ServerState) -> Result<ReleaseCatalogStore, Response> {
    state.release_store().cloned().ok_or_else(unavailable)
}

async fn beta_update(
    State(state): State<Arc<ServerState>>,
    Path((target, arch, current_version)): Path<(String, String, String)>,
) -> Response {
    update_for_channel(state, "beta", target, arch, current_version).await
}

async fn acceptance_update(
    State(state): State<Arc<ServerState>>,
    Path((target, arch, current_version)): Path<(String, String, String)>,
) -> Response {
    update_for_channel(state, "acceptance", target, arch, current_version).await
}

async fn update_for_channel(
    state: Arc<ServerState>,
    channel: &str,
    target: String,
    arch: String,
    current_version: String,
) -> Response {
    if !safe_route_component(&target) || !safe_route_component(&arch) {
        return not_found();
    }
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let catalog = match store.load_channel(channel).await {
        Ok(Some(catalog)) => catalog,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(_) => return unavailable(),
    };
    let decision = match select_update(&catalog.release, &target, &arch, &current_version) {
        Ok(decision) => decision,
        Err(super::model::MetadataError::CurrentVersion) => return not_found(),
        Err(_) => return unavailable(),
    };
    let UpdateDecision::Update(asset) = decision else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let Some(signature) = asset.signature.clone() else {
        return unavailable();
    };
    let url = format!(
        "{}/updates/releases/{}/{}",
        public_base_url(),
        catalog.release.version,
        asset.file_name
    );
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(TauriUpdateResponse {
            version: catalog.release.version,
            notes: catalog.release.notes,
            pub_date: catalog.release.pub_date,
            url,
            signature,
        }),
    )
        .into_response()
}

fn safe_route_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.to_ascii_lowercase().contains("%2")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

async fn immutable_asset_get(
    State(state): State<Arc<ServerState>>,
    Path((version, asset)): Path<(String, String)>,
) -> Response {
    immutable_asset(state, version, asset, false).await
}

async fn immutable_asset_head(
    State(state): State<Arc<ServerState>>,
    Path((version, asset)): Path<(String, String)>,
) -> Response {
    immutable_asset(state, version, asset, true).await
}

async fn immutable_asset(
    state: Arc<ServerState>,
    version: String,
    file_name: String,
    head_only: bool,
) -> Response {
    if Version::parse(&version).is_err() || !safe_route_component(&file_name) {
        return not_found();
    }
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let allowed = match store.load_allowed_asset(&version, &file_name).await {
        Ok(Some(allowed)) => allowed,
        Ok(None) | Err(ReleaseStoreError::NotFound) => return not_found(),
        Err(_) => return unavailable(),
    };
    asset_response(&store, &allowed.asset, head_only, IMMUTABLE_CACHE_CONTROL).await
}

async fn stable_dmg_get(State(state): State<Arc<ServerState>>) -> Response {
    stable_dmg(state, false).await
}

async fn stable_dmg_head(State(state): State<Arc<ServerState>>) -> Response {
    stable_dmg(state, true).await
}

async fn stable_dmg(state: Arc<ServerState>, head_only: bool) -> Response {
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let catalog = match store.load_channel("beta").await {
        Ok(Some(catalog)) => catalog,
        Ok(None) | Err(ReleaseStoreError::NotFound) => return not_found(),
        Err(_) => return unavailable(),
    };
    asset_response(&store, &catalog.release.manual, head_only, "no-store").await
}

async fn asset_response(
    store: &ReleaseCatalogStore,
    asset: &ReleaseAsset,
    head_only: bool,
    cache_control: &'static str,
) -> Response {
    let body = if head_only {
        if store.verify_asset_size(asset).await.is_err() {
            return unavailable();
        }
        Body::empty()
    } else {
        let object = match store.open_asset(asset).await {
            Ok(object) => object,
            Err(ReleaseStoreError::NotFound) => return not_found(),
            Err(_) => return unavailable(),
        };
        Body::from_stream(object.body)
    };

    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    let Ok(content_type) = HeaderValue::from_str(&asset.content_type) else {
        return unavailable();
    };
    let Ok(content_length) = HeaderValue::from_str(&asset.size_bytes.to_string()) else {
        return unavailable();
    };
    let Ok(checksum) = HeaderValue::from_str(&asset.sha256) else {
        return unavailable();
    };
    let Ok(etag) = HeaderValue::from_str(&format!("\"{}\"", asset.sha256)) else {
        return unavailable();
    };
    headers.insert(header::CONTENT_TYPE, content_type);
    headers.insert(header::CONTENT_LENGTH, content_length);
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    headers.insert(HeaderName::from_static("x-checksum-sha256"), checksum);
    headers.insert(header::ETAG, etag);
    response
}

async fn legacy_release_version(State(state): State<Arc<ServerState>>) -> Response {
    let response = match state.release_store() {
        None => legacy_environment_fallback(true),
        Some(store) => match store.load_channel("beta").await {
            Ok(Some(catalog)) => LegacyReleaseVersionResponse {
                version: catalog.release.version,
                changelog_url: catalog.release.changelog_url,
                download_url: Some(format!(
                    "{}/updates/releases/latest/Kordi.dmg",
                    public_base_url()
                )),
                signature: catalog
                    .release
                    .platforms
                    .values()
                    .find_map(|asset| asset.signature.clone()),
                install_command: Some(
                    "Download, install, and relaunch Kordi automatically from coordinar.io."
                        .to_string(),
                ),
            },
            Ok(None) => legacy_environment_fallback(true),
            Err(_) => legacy_environment_fallback(false),
        },
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(response)).into_response()
}

fn legacy_environment_fallback(allow_download: bool) -> LegacyReleaseVersionResponse {
    let optional_env = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    LegacyReleaseVersionResponse {
        version: optional_env("KORDI_RELEASE_VERSION")
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        changelog_url: optional_env("KORDI_RELEASE_CHANGELOG_URL")
            .unwrap_or_else(|| "https://coordinar.io/updates/releases/version".to_string()),
        download_url: allow_download
            .then(|| optional_env("KORDI_RELEASE_DOWNLOAD_URL"))
            .flatten(),
        signature: allow_download
            .then(|| optional_env("KORDI_RELEASE_SIGNATURE"))
            .flatten(),
        install_command: optional_env("KORDI_RELEASE_INSTALL_COMMAND"),
    }
}
