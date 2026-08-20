use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use url::Url;
use uuid::Uuid;

use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter, RateLimitDecision};
use crate::server::ServerState;

use self::rendering::{
    avatar_render_semaphore, cache_rendered_avatar, cached_rendered_avatar, render_png,
    AVATAR_RENDER_SIZE,
};

mod rendering;

pub const AVATAR_RENDERER_VERSION: &str = "dicebear-rust-10.6.0-styles-10.5.0";
pub const HUMAN_AVATAR_STYLE: &str = "lorelei";
pub const AGENT_AVATAR_STYLE: &str = "thumbs";
pub const AVATAR_UPLOAD_MAX_BYTES: usize = 200 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvatarDescriptor {
    pub entity_type: String,
    pub entity_id: String,
    pub source: String,
    pub style: String,
    pub seed: String,
    pub renderer_version: String,
    pub uploaded_asset: Option<String>,
    pub version: i64,
    pub updated_at: String,
}

impl AvatarDescriptor {
    pub fn image_url(&self) -> String {
        if self.source == "uploaded" {
            if let Some(asset) = self.uploaded_asset.as_deref() {
                return asset.to_string();
            }
        }
        generated_avatar_marker(&self.style, &self.seed, self.version)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvatarMutationRequest {
    pub action: String,
    #[serde(default)]
    pub uploaded_asset: Option<String>,
    #[serde(default)]
    pub seed: Option<String>,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct StoredAvatar {
    pub source: String,
    pub style: String,
    pub seed: String,
    pub renderer_version: String,
    pub avatar_url: Option<String>,
    pub version: i64,
    pub updated_at: String,
}

pub type StoredAvatarRow = (String, String, String, String, Option<String>, i64, String);

impl From<StoredAvatarRow> for StoredAvatar {
    fn from(row: StoredAvatarRow) -> Self {
        Self {
            source: row.0,
            style: row.1,
            seed: row.2,
            renderer_version: row.3,
            avatar_url: row.4,
            version: row.5,
            updated_at: row.6,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AvatarMutationError {
    Conflict,
    Invalid(String),
}

pub fn descriptor_from_parts(
    entity_type: String,
    entity_id: String,
    stored: StoredAvatar,
) -> AvatarDescriptor {
    AvatarDescriptor {
        entity_type,
        entity_id,
        uploaded_asset: (stored.source == "uploaded")
            .then_some(stored.avatar_url)
            .flatten(),
        source: stored.source,
        style: stored.style,
        seed: stored.seed,
        renderer_version: stored.renderer_version,
        version: stored.version,
        updated_at: stored.updated_at,
    }
}

pub fn generated_avatar_marker(style: &str, seed: &str, version: i64) -> String {
    format!("kordi-avatar://{AVATAR_RENDERER_VERSION}/{style}/{seed}?version={version}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeneratedAvatarMarker {
    pub renderer_version: String,
    pub style: String,
    pub seed: String,
    pub version: i64,
}

pub fn parse_generated_avatar_marker(value: &str) -> Option<GeneratedAvatarMarker> {
    let url = Url::parse(value.trim()).ok()?;
    if url.scheme() != "kordi-avatar" {
        return None;
    }
    let renderer_version = url.host_str()?.to_string();
    if renderer_version != AVATAR_RENDERER_VERSION {
        return None;
    }
    let mut segments = url.path_segments()?;
    let style = segments.next()?.to_string();
    let seed = segments.next()?.to_string();
    if segments.next().is_some() || !is_supported_style(&style) || !is_valid_avatar_seed(&seed) {
        return None;
    }
    let version = url.query_pairs().find_map(|(key, value)| {
        (key == "version")
            .then(|| value.parse::<i64>().ok())
            .flatten()
    })?;
    if version < 1 {
        return None;
    }
    Some(GeneratedAvatarMarker {
        renderer_version,
        style,
        seed,
        version,
    })
}

pub fn new_avatar_seed() -> String {
    Uuid::new_v4().simple().to_string()
}

pub fn clean_uploaded_avatar(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some((metadata, payload)) = raw.split_once(',') else {
        return Err("Avatar must be a PNG, JPEG, or WebP image.".to_string());
    };
    let media_type = match metadata.to_ascii_lowercase().as_str() {
        "data:image/png;base64" => "image/png",
        "data:image/jpeg;base64" => "image/jpeg",
        "data:image/webp;base64" => "image/webp",
        _ => return Err("Avatar must be a PNG, JPEG, or WebP image.".to_string()),
    };
    if decoded_base64_len(payload) > AVATAR_UPLOAD_MAX_BYTES {
        return Err("Avatar payload is too large after processing.".to_string());
    }
    let decoded = STANDARD
        .decode(payload)
        .map_err(|_| "Avatar image data is invalid.".to_string())?;
    if decoded.len() > AVATAR_UPLOAD_MAX_BYTES {
        return Err("Avatar payload is too large after processing.".to_string());
    }
    let has_expected_signature = match media_type {
        "image/png" => decoded.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => decoded.starts_with(b"\xff\xd8\xff"),
        "image/webp" => {
            decoded.starts_with(b"RIFF") && decoded.get(8..12) == Some(b"WEBP".as_slice())
        }
        _ => false,
    };
    if !has_expected_signature {
        return Err("Avatar image data does not match its file type.".to_string());
    }
    Ok(Some(raw.to_string()))
}

pub fn apply_avatar_mutation(
    current: &AvatarDescriptor,
    mutation: &AvatarMutationRequest,
    updated_at: &str,
) -> Result<AvatarDescriptor, AvatarMutationError> {
    if mutation
        .expected_version
        .is_some_and(|expected| expected != current.version)
    {
        return Err(AvatarMutationError::Conflict);
    }

    let mut next = current.clone();
    next.version = current.version.saturating_add(1);
    next.updated_at = updated_at.to_string();
    match mutation.action.trim() {
        "upload" => {
            let asset = clean_uploaded_avatar(mutation.uploaded_asset.as_deref())
                .map_err(AvatarMutationError::Invalid)?
                .ok_or_else(|| {
                    AvatarMutationError::Invalid("Choose an avatar image.".to_string())
                })?;
            next.source = "uploaded".to_string();
            next.uploaded_asset = Some(asset);
        }
        "regenerate" => {
            let seed = mutation
                .seed
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .ok_or_else(|| {
                    AvatarMutationError::Invalid(
                        "Choose a generated avatar before saving.".to_string(),
                    )
                })?;
            if !is_valid_avatar_seed(&seed) {
                return Err(AvatarMutationError::Invalid(
                    "Generated avatar seed is invalid.".to_string(),
                ));
            }
            next.source = "generated".to_string();
            next.seed = seed;
            next.uploaded_asset = None;
        }
        "remove_upload" => {
            next.source = "generated".to_string();
            next.uploaded_asset = None;
        }
        _ => {
            return Err(AvatarMutationError::Invalid(
                "Unsupported avatar action.".to_string(),
            ));
        }
    }
    next.renderer_version = AVATAR_RENDERER_VERSION.to_string();
    Ok(next)
}

pub async fn preserve_avatar_render_key(
    transaction: &mut Transaction<'_, Postgres>,
    avatar: &AvatarDescriptor,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_avatar_render_keys (renderer_version, style, seed)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(&avatar.renderer_version)
    .bind(&avatar.style)
    .bind(&avatar.seed)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub fn routes(state: Arc<ServerState>) -> Router {
    // ponytail: per-process throttling plus the durable render-key allowlist bounds
    // work today; give this route its own Redis namespace if replica-level abuse appears.
    let rate_limiter = Arc::new(CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 120,
        per_ip_window: Duration::from_secs(60),
        ..CloudRateLimitConfig::production()
    }));
    Router::new()
        .route(
            "/v1/avatars/:renderer/:style/:file_name",
            get(render_generated_avatar),
        )
        .route(
            "/v1/avatars/preview/:style/:file_name",
            get(render_avatar_preview),
        )
        .layer(Extension(rate_limiter))
        .with_state(state)
}

async fn render_generated_avatar(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path((renderer, style, file_name)): Path<(String, String, String)>,
) -> Response {
    if renderer != AVATAR_RENDERER_VERSION || !is_supported_style(&style) {
        return avatar_error(StatusCode::NOT_FOUND, "Avatar renderer was not found.");
    }
    let Some(seed) = file_name.strip_suffix(".png") else {
        return avatar_error(StatusCode::NOT_FOUND, "Avatar image was not found.");
    };
    if !is_valid_avatar_seed(seed) {
        return avatar_error(StatusCode::BAD_REQUEST, "Avatar seed is invalid.");
    }

    let cache_key = format!("{renderer}:{style}:{seed}:{AVATAR_RENDER_SIZE}");
    if let Some(bytes) = cached_rendered_avatar(&cache_key) {
        return avatar_png_response(bytes);
    }

    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(avatar_request_ip(&headers, connect_info.as_ref()))
        .await
    {
        return avatar_rate_limited(retry_after);
    }
    match canonical_avatar_render_key_exists(state.db_pool(), &renderer, &style, seed).await {
        Ok(true) => {}
        Ok(false) => return avatar_error(StatusCode::NOT_FOUND, "Avatar image was not found."),
        Err(error) => {
            eprintln!("[avatars] validate render key: {error}");
            return avatar_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Avatar could not be rendered.",
            );
        }
    }

    render_and_cache_avatar(&style, seed, cache_key).await
}

async fn render_avatar_preview(
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path((style, file_name)): Path<(String, String)>,
) -> Response {
    if !is_supported_style(&style) {
        return avatar_error(StatusCode::NOT_FOUND, "Avatar style was not found.");
    }
    let Some(seed) = file_name.strip_suffix(".png") else {
        return avatar_error(StatusCode::NOT_FOUND, "Avatar image was not found.");
    };
    if !is_valid_avatar_seed(seed) {
        return avatar_error(StatusCode::BAD_REQUEST, "Avatar seed is invalid.");
    }
    let cache_key = format!("{AVATAR_RENDERER_VERSION}:{style}:{seed}:{AVATAR_RENDER_SIZE}");
    if let Some(bytes) = cached_rendered_avatar(&cache_key) {
        return avatar_png_response(bytes);
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(avatar_request_ip(&headers, connect_info.as_ref()))
        .await
    {
        return avatar_rate_limited(retry_after);
    }
    render_and_cache_avatar(&style, seed, cache_key).await
}

async fn render_and_cache_avatar(style: &str, seed: &str, cache_key: String) -> Response {
    let style_for_render = style.to_string();
    let seed_for_render = seed.to_string();
    let Ok(render_permit) = avatar_render_semaphore().clone().try_acquire_owned() else {
        return avatar_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Avatar renderer is busy. Try again shortly.",
        );
    };
    let rendered =
        tokio::task::spawn_blocking(move || render_png(&style_for_render, &seed_for_render)).await;
    drop(render_permit);
    let bytes = match rendered {
        Ok(Ok(bytes)) => Arc::<[u8]>::from(bytes),
        _ => {
            return avatar_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Avatar could not be rendered.",
            )
        }
    };
    cache_rendered_avatar(cache_key, bytes.clone());
    avatar_png_response(bytes)
}

fn avatar_request_ip(
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<SocketAddr>>,
) -> Option<std::net::IpAddr> {
    let peer = connect_info.map(|info| info.0.ip())?;
    let trusted_proxy = match peer {
        std::net::IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
        std::net::IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    };
    if !trusted_proxy {
        return Some(peer);
    }
    headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
        .or(Some(peer))
}

async fn canonical_avatar_render_key_exists(
    pool: &sqlx_postgres::PgPool,
    renderer: &str,
    style: &str,
    seed: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(i32,)> = query_as(
        "SELECT 1 WHERE
            EXISTS (SELECT 1 FROM cloud_avatar_render_keys
                    WHERE renderer_version = $1 AND style = $2 AND seed = $3)
            OR EXISTS (SELECT 1 FROM cloud_accounts
                       WHERE avatar_renderer_version = $1 AND avatar_style = $2 AND avatar_seed = $3)
            OR EXISTS (SELECT 1 FROM cloud_agent_definitions
                       WHERE avatar_renderer_version = $1 AND avatar_style = $2 AND avatar_seed = $3)",
    )
    .bind(renderer)
    .bind(style)
    .bind(seed)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

fn is_supported_style(style: &str) -> bool {
    is_human_avatar_style(style) || style == AGENT_AVATAR_STYLE
}

pub fn is_human_avatar_style(style: &str) -> bool {
    style == HUMAN_AVATAR_STYLE
}

pub fn is_valid_avatar_seed(seed: &str) -> bool {
    !seed.is_empty()
        && seed.len() <= 128
        && seed
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
}

fn decoded_base64_len(encoded: &str) -> usize {
    let trimmed = encoded.trim_end_matches('=');
    (trimmed.len() * 3) / 4
}

fn avatar_png_response(bytes: Arc<[u8]>) -> Response {
    let mut response = bytes.to_vec().into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    response
}

fn avatar_error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        Json(json!({ "errorCode": "avatar_error", "message": message })),
    )
        .into_response()
}

fn avatar_rate_limited(retry_after: Duration) -> Response {
    let mut response = avatar_error(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many avatar requests. Try again shortly.",
    );
    if let Ok(value) = HeaderValue::from_str(&retry_after.as_secs().max(1).to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

#[cfg(test)]
#[path = "avatars_tests.rs"]
mod tests;
