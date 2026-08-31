use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use semver::Version;
use serde::Serialize;
use url::Url;

use crate::server::ServerState;

use super::model::{select_update, ReleaseAsset, UpdateDecision};
use super::store::{ReleaseCatalogStore, ReleaseStoreError};

mod asset;

use asset::asset_response;

const DEFAULT_PUBLIC_BASE_URL: &str = "https://kordi.ai";
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
        .route("/updates/releases/:version/metadata", get(release_metadata))
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
struct PublicReleaseMetadata {
    schema_version: u32,
    version: String,
    notes: String,
    pub_date: String,
    changelog_url: String,
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

struct UpdateEvent<'a> {
    correlation_id: &'a str,
    channel: &'a str,
    target: &'a str,
    architecture: &'a str,
    outcome: &'a str,
    release_version: Option<&'a str>,
    asset: Option<&'a ReleaseAsset>,
}

fn update_event_response(mut response: Response, event: UpdateEvent<'_>) -> Response {
    let safe_component = |value: &str| value.chars().take(64).collect::<String>();
    let event_json = serde_json::json!({
        "event": "desktop_update",
        "correlationId": event.correlation_id,
        "channel": event.channel,
        "target": safe_component(event.target),
        "architecture": safe_component(event.architecture),
        "outcome": event.outcome,
        "httpStatus": response.status().as_u16(),
        "releaseVersion": event.release_version,
        "sizeBytes": event.asset.map(|value| value.size_bytes),
        "sha256": event.asset.map(|value| value.sha256.as_str()),
    });
    eprintln!("{event_json}");
    if let Ok(value) = HeaderValue::from_str(event.correlation_id) {
        response
            .headers_mut()
            .insert(HeaderName::from_static("x-kordi-update-id"), value);
    }
    response
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

fn release_store(state: &ServerState) -> Result<ReleaseCatalogStore, Box<Response>> {
    state
        .release_store()
        .cloned()
        .ok_or_else(|| Box::new(unavailable()))
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
    let correlation_id = uuid::Uuid::new_v4().to_string();
    let respond = |response, outcome, release_version, asset| {
        update_event_response(
            response,
            UpdateEvent {
                correlation_id: &correlation_id,
                channel,
                target: &target,
                architecture: &arch,
                outcome,
                release_version,
                asset,
            },
        )
    };
    if !safe_route_component(&target) || !safe_route_component(&arch) {
        return respond(not_found(), "invalid_platform", None, None);
    }
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return respond(*response, "store_unconfigured", None, None),
    };
    let catalog = match store.load_channel(channel).await {
        Ok(Some(catalog)) => catalog,
        Ok(None) => {
            return respond(
                StatusCode::NO_CONTENT.into_response(),
                "channel_unpublished",
                None,
                None,
            )
        }
        Err(_) => return respond(unavailable(), "catalog_unavailable", None, None),
    };
    let decision = match select_update(&catalog.release, &target, &arch, &current_version) {
        Ok(decision) => decision,
        Err(super::model::MetadataError::CurrentVersion) => {
            return respond(not_found(), "invalid_current_version", None, None)
        }
        Err(_) => return respond(unavailable(), "catalog_invalid", None, None),
    };
    let asset = match decision {
        UpdateDecision::Update(asset) => asset,
        UpdateDecision::NoUpdate => {
            return respond(
                StatusCode::NO_CONTENT.into_response(),
                "no_update",
                Some(&catalog.release.version),
                None,
            )
        }
        UpdateDecision::Unsupported => {
            return respond(
                StatusCode::NO_CONTENT.into_response(),
                "unsupported_platform",
                Some(&catalog.release.version),
                None,
            )
        }
    };
    let Some(signature) = asset.signature.clone() else {
        return respond(
            unavailable(),
            "signature_unavailable",
            Some(&catalog.release.version),
            Some(asset),
        );
    };
    let url = format!(
        "{}/updates/releases/{}/{}",
        public_base_url(),
        catalog.release.version,
        asset.file_name
    );
    let response = (
        [(header::CACHE_CONTROL, "no-store")],
        Json(TauriUpdateResponse {
            version: catalog.release.version.clone(),
            notes: catalog.release.notes.clone(),
            pub_date: catalog.release.pub_date.clone(),
            url,
            signature,
        }),
    )
        .into_response();
    respond(
        response,
        "update_available",
        Some(&catalog.release.version),
        Some(asset),
    )
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

async fn release_metadata(
    State(state): State<Arc<ServerState>>,
    Path(version): Path<String>,
) -> Response {
    if Version::parse(&version).is_err() {
        return not_found();
    }
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return *response,
    };
    let release = match store.load_version(&version).await {
        Ok(Some(release)) => release,
        Ok(None) | Err(ReleaseStoreError::NotFound) => return not_found(),
        Err(_) => return unavailable(),
    };
    (
        [(header::CACHE_CONTROL, IMMUTABLE_CACHE_CONTROL)],
        Json(PublicReleaseMetadata {
            schema_version: release.schema_version,
            version: release.version,
            notes: release.notes,
            pub_date: release.pub_date,
            changelog_url: release.changelog_url,
        }),
    )
        .into_response()
}

async fn immutable_asset_get(
    State(state): State<Arc<ServerState>>,
    Path((version, asset)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    immutable_asset(state, version, asset, headers, false).await
}

async fn immutable_asset_head(
    State(state): State<Arc<ServerState>>,
    Path((version, asset)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    immutable_asset(state, version, asset, headers, true).await
}

async fn immutable_asset(
    state: Arc<ServerState>,
    version: String,
    file_name: String,
    headers: HeaderMap,
    head_only: bool,
) -> Response {
    if Version::parse(&version).is_err() || !safe_route_component(&file_name) {
        return not_found();
    }
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return *response,
    };
    let allowed = match store.load_allowed_asset(&version, &file_name).await {
        Ok(Some(allowed)) => allowed,
        Ok(None) | Err(ReleaseStoreError::NotFound) => return not_found(),
        Err(_) => return unavailable(),
    };
    asset_response(
        &store,
        &allowed.asset,
        &allowed.release.pub_date,
        &headers,
        head_only,
        IMMUTABLE_CACHE_CONTROL,
    )
    .await
}

async fn stable_dmg_get(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    stable_dmg(state, headers, false).await
}

async fn stable_dmg_head(State(state): State<Arc<ServerState>>, headers: HeaderMap) -> Response {
    stable_dmg(state, headers, true).await
}

async fn stable_dmg(state: Arc<ServerState>, headers: HeaderMap, head_only: bool) -> Response {
    let store = match release_store(&state) {
        Ok(store) => store,
        Err(response) => return *response,
    };
    let catalog = match store.load_channel("beta").await {
        Ok(Some(catalog)) => catalog,
        Ok(None) | Err(ReleaseStoreError::NotFound) => return not_found(),
        Err(_) => return unavailable(),
    };
    asset_response(
        &store,
        &catalog.release.manual,
        &catalog.release.pub_date,
        &headers,
        head_only,
        "no-store",
    )
    .await
}

async fn legacy_release_version(State(state): State<Arc<ServerState>>) -> Response {
    let response = match state.release_store() {
        None => legacy_environment_fallback(),
        Some(store) => match store.load_channel("beta").await {
            Ok(Some(catalog)) => LegacyReleaseVersionResponse {
                version: catalog.release.version,
                changelog_url: format!("{}/updates/releases/latest/Kordi.dmg", public_base_url()),
                download_url: None,
                signature: None,
                install_command: Some(
                    "Download Kordi from kordi.ai and drag it to Applications once.".to_string(),
                ),
            },
            Ok(None) | Err(_) => legacy_environment_fallback(),
        },
    };
    ([(header::CACHE_CONTROL, "no-store")], Json(response)).into_response()
}

fn legacy_environment_fallback() -> LegacyReleaseVersionResponse {
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
            .unwrap_or_else(|| "https://kordi.ai/updates/releases/version".to_string()),
        // The shipped beta.5 client treats any downloadUrl as authorization to
        // invoke its legacy unverified native installer. Keep these fields absent
        // so beta.5 can only open changelogUrl for the one-time manual bootstrap.
        download_url: None,
        signature: None,
        install_command: optional_env("KORDI_RELEASE_INSTALL_COMMAND"),
    }
}
