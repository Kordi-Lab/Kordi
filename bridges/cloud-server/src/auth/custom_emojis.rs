use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use image::{DynamicImage, ImageDecoder, ImageFormat, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use crate::attachments::{presign_download_url, presign_upload_url};
use crate::auth::routes::{cloud_session_admin_ids, cloud_session_participants, CloudSession};
use crate::server::ServerState;

const ORIGINAL_MAX_BYTES: i64 = 1024 * 1024;
const ORIGINAL_MAX_DIMENSION: u32 = 512;
const CANONICAL_DIMENSION: u32 = 128;
const CANONICAL_MAX_BYTES: usize = 128 * 1024;
const WORKSPACE_EMOJI_QUOTA: i64 = 250;
const USER_DAILY_SUBMISSION_QUOTA: i64 = 20;
const USER_UPLOAD_ATTEMPTS_PER_MINUTE: i64 = 5;

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/custom-emojis",
            get(list_custom_emojis).post(create_custom_emoji),
        )
        .route(
            "/v1/cloud/custom-emojis/:emoji_id",
            patch(update_custom_emoji),
        )
        .route(
            "/v1/cloud/custom-emojis/:emoji_id/aliases",
            post(create_custom_emoji_alias),
        )
        .route(
            "/v1/cloud/custom-emojis/:emoji_id/content",
            get(custom_emoji_content),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCustomEmojisQuery {
    scope_id: Option<String>,
    include_pending: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCustomEmojiRequest {
    scope_type: String,
    scope_id: Option<String>,
    name: String,
    attachment_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCustomEmojiRequest {
    name: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateCustomEmojiAliasRequest {
    alias: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomEmojiSummary {
    emoji_id: String,
    scope_type: String,
    scope_id: Option<String>,
    name: String,
    aliases: Vec<String>,
    asset_attachment_id: String,
    content_path: String,
    animated: bool,
    status: String,
    uploaded_by: String,
    approved_by: Option<String>,
    version: i32,
    width: i32,
    height: i32,
    mime_type: String,
    size_bytes: i64,
    sha256_hex: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomEmojiResponse {
    emoji: CustomEmojiSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomEmojiListResponse {
    emojis: Vec<CustomEmojiSummary>,
    can_manage: bool,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
    message: String,
}

type EmojiRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    bool,
    String,
    String,
    Option<String>,
    i32,
    String,
    i64,
    String,
    String,
    String,
);

fn err(code: &'static str, message: impl Into<String>, status: StatusCode) -> Response {
    (
        status,
        Json(ErrorBody {
            error_code: code,
            message: message.into(),
        }),
    )
        .into_response()
}

fn normalize_scope_id(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (!value.is_empty() && value.chars().count() <= 256).then(|| value.to_string())
}

fn normalize_emoji_name(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if !(2..=32).contains(&value.chars().count())
        || !value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (index > 0 && matches!(character, '_' | '-'))
        })
    {
        return None;
    }
    Some(value)
}

fn is_blocked_emoji_name(value: &str) -> bool {
    matches!(
        value,
        "admin"
            | "admins"
            | "all"
            | "channel"
            | "everyone"
            | "gif"
            | "giphy"
            | "here"
            | "kordi"
            | "moderator"
            | "stickers"
            | "system"
    )
}

fn summary_from_row(row: EmojiRow, aliases: Vec<String>) -> CustomEmojiSummary {
    let (
        emoji_id,
        scope_type,
        scope_id,
        name,
        asset_attachment_id,
        animated,
        status,
        uploaded_by,
        approved_by,
        version,
        mime_type,
        size_bytes,
        sha256_hex,
        created_at,
        updated_at,
    ) = row;
    CustomEmojiSummary {
        content_path: format!("/v1/cloud/custom-emojis/{emoji_id}/content"),
        emoji_id,
        scope_type,
        scope_id,
        name,
        aliases,
        asset_attachment_id,
        animated,
        status,
        uploaded_by,
        approved_by,
        version,
        width: CANONICAL_DIMENSION as i32,
        height: CANONICAL_DIMENSION as i32,
        mime_type,
        size_bytes,
        sha256_hex,
        created_at,
        updated_at,
    }
}

async fn load_emoji(
    state: &ServerState,
    emoji_id: &str,
) -> Result<Option<CustomEmojiSummary>, sqlx_core::Error> {
    let row: Option<EmojiRow> = query_as(
        "SELECT emoji_id, scope_type, scope_id, name, asset_attachment_id, animated, status, \
                uploaded_by, approved_by, version, mime_type, size_bytes, sha256_hex, \
                created_at, updated_at \
         FROM cloud_custom_emojis WHERE emoji_id = $1 AND deleted_at IS NULL",
    )
    .bind(emoji_id)
    .fetch_optional(state.db_pool())
    .await?;
    let Some(row) = row else { return Ok(None) };
    let aliases = query_as::<_, (String,)>(
        "SELECT alias FROM cloud_custom_emoji_aliases WHERE emoji_id = $1 ORDER BY alias ASC",
    )
    .bind(emoji_id)
    .fetch_all(state.db_pool())
    .await?
    .into_iter()
    .map(|(alias,)| alias)
    .collect();
    Ok(Some(summary_from_row(row, aliases)))
}

async fn workspace_access(
    state: &ServerState,
    account_id: &str,
    scope_id: &str,
) -> Result<(Vec<String>, bool), Response> {
    let participants = cloud_session_participants(state.db_pool(), scope_id)
        .await
        .map_err(|_| {
            err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
    if !participants
        .iter()
        .any(|participant| participant == account_id)
    {
        return Err(err(
            "not_a_participant",
            "You can only manage emoji for workspaces you participate in.",
            StatusCode::FORBIDDEN,
        ));
    }
    let admin_ids = cloud_session_admin_ids(state.db_pool(), scope_id)
        .await
        .map_err(|_| {
            err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
    Ok((
        participants,
        admin_ids.iter().any(|admin| admin == account_id),
    ))
}

fn process_static_emoji(bytes: Vec<u8>) -> Result<(Vec<u8>, String), &'static str> {
    let reader = image::ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "Could not inspect this image.")?;
    let format = reader
        .format()
        .ok_or("Could not identify this image format.")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("Use a PNG, JPEG, or WebP image.");
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| "Could not read this image.")?;
    if width == 0
        || height == 0
        || width > ORIGINAL_MAX_DIMENSION
        || height > ORIGINAL_MAX_DIMENSION
    {
        return Err("Emoji images must be no larger than 512 by 512 pixels.");
    }
    let mut decoder = image::ImageReader::with_format(Cursor::new(&bytes), format)
        .into_decoder()
        .map_err(|_| "Could not decode this image.")?;
    let orientation = decoder
        .orientation()
        .map_err(|_| "Could not read this image's orientation.")?;
    let mut decoded =
        DynamicImage::from_decoder(decoder).map_err(|_| "Could not decode this image.")?;
    decoded.apply_orientation(orientation);
    let scaled = decoded
        .thumbnail(CANONICAL_DIMENSION, CANONICAL_DIMENSION)
        .to_rgba8();
    let mut canvas =
        RgbaImage::from_pixel(CANONICAL_DIMENSION, CANONICAL_DIMENSION, Rgba([0, 0, 0, 0]));
    let x = i64::from((CANONICAL_DIMENSION - scaled.width()) / 2);
    let y = i64::from((CANONICAL_DIMENSION - scaled.height()) / 2);
    image::imageops::overlay(&mut canvas, &scaled, x, y);
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut output, ImageFormat::WebP)
        .map_err(|_| "Could not encode this emoji.")?;
    let output = output.into_inner();
    if output.len() > CANONICAL_MAX_BYTES {
        return Err("The optimized emoji is larger than 128 KB.");
    }
    let sha256_hex = hex::encode(Sha256::digest(&output));
    Ok((output, sha256_hex))
}

async fn canonicalize_attachment(
    state: &ServerState,
    account_id: &str,
    attachment_id: &str,
) -> Result<(i64, String), Response> {
    let s3 = state.s3().ok_or_else(|| {
        err(
            "object_store_unavailable",
            "Emoji uploads are temporarily unavailable.",
            StatusCode::SERVICE_UNAVAILABLE,
        )
    })?;
    let row: Option<(String, String, Option<String>, Option<i64>, Option<String>)> = query_as(
        "SELECT object_key, owner_account_id, content_type, size_bytes, finalized_at \
         FROM cloud_attachments WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_optional(state.db_pool())
    .await
    .map_err(|_| {
        err(
            "server_error",
            "Database error.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    let Some((object_key, owner_account_id, _content_type, size_bytes, finalized_at)) = row else {
        return Err(err(
            "attachment_not_found",
            "Attachment not found.",
            StatusCode::NOT_FOUND,
        ));
    };
    if owner_account_id != account_id || finalized_at.is_none() {
        return Err(err(
            "attachment_not_found",
            "Attachment not found.",
            StatusCode::NOT_FOUND,
        ));
    }
    if size_bytes.is_none_or(|size| size <= 0 || size > ORIGINAL_MAX_BYTES) {
        return Err(err(
            "emoji_too_large",
            "Emoji uploads must be 1 MB or smaller.",
            StatusCode::BAD_REQUEST,
        ));
    }
    let download_url = presign_download_url(s3, &object_key).map_err(|_| {
        err(
            "server_error",
            "Could not read uploaded emoji.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    let response = reqwest::Client::new()
        .get(download_url.to_string())
        .send()
        .await
        .map_err(|_| {
            err(
                "object_store_error",
                "Could not read uploaded emoji.",
                StatusCode::BAD_GATEWAY,
            )
        })?;
    if !response.status().is_success() {
        return Err(err(
            "object_store_error",
            "Could not read uploaded emoji.",
            StatusCode::BAD_GATEWAY,
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > ORIGINAL_MAX_BYTES as u64)
    {
        return Err(err(
            "emoji_too_large",
            "Emoji uploads must be 1 MB or smaller.",
            StatusCode::BAD_REQUEST,
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(size_bytes.unwrap_or(0).max(0) as usize);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| {
            err(
                "object_store_error",
                "Could not read uploaded emoji.",
                StatusCode::BAD_GATEWAY,
            )
        })?;
        if bytes.len().saturating_add(chunk.len()) > ORIGINAL_MAX_BYTES as usize {
            return Err(err(
                "emoji_too_large",
                "Emoji uploads must be 1 MB or smaller.",
                StatusCode::BAD_REQUEST,
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let (canonical, sha256_hex) = tokio::task::spawn_blocking(move || process_static_emoji(bytes))
        .await
        .map_err(|_| {
            err(
                "image_processing_failed",
                "Could not process this image.",
                StatusCode::BAD_REQUEST,
            )
        })?
        .map_err(|message| err("invalid_emoji_image", message, StatusCode::BAD_REQUEST))?;
    let canonical_size = i64::try_from(canonical.len()).unwrap_or(i64::MAX);
    let upload_url = presign_upload_url(s3, &object_key).map_err(|_| {
        err(
            "server_error",
            "Could not store optimized emoji.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    let upload_response = reqwest::Client::new()
        .put(upload_url.to_string())
        .header(reqwest::header::CONTENT_TYPE, "image/webp")
        .body(canonical)
        .send()
        .await
        .map_err(|_| {
            err(
                "object_store_error",
                "Could not store optimized emoji.",
                StatusCode::BAD_GATEWAY,
            )
        })?;
    if !upload_response.status().is_success() {
        return Err(err(
            "object_store_error",
            "Could not store optimized emoji.",
            StatusCode::BAD_GATEWAY,
        ));
    }
    query(
        "UPDATE cloud_attachments SET content_type = 'image/webp', size_bytes = $1, sha256_hex = $2 WHERE attachment_id = $3",
    )
    .bind(canonical_size)
    .bind(&sha256_hex)
    .bind(attachment_id)
    .execute(state.db_pool())
    .await
    .map_err(|_| err("server_error", "Could not finalize emoji.", StatusCode::INTERNAL_SERVER_ERROR))?;
    Ok((canonical_size, sha256_hex))
}

async fn emit_emoji_event(
    state: &ServerState,
    recipients: &[String],
    event_type: &str,
    emoji: &CustomEmojiSummary,
) -> Result<(), sqlx_core::Error> {
    let payload = serde_json::json!({ "emoji": emoji });
    for account_id in recipients {
        query(
            "INSERT INTO cloud_sync_events \
             (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
             VALUES ($1, $2, $3, NULL, $4, $5)",
        )
        .bind(account_id)
        .bind(event_type)
        .bind(emoji.scope_id.as_deref())
        .bind(&payload)
        .bind(&emoji.updated_at)
        .execute(state.db_pool())
        .await?;
    }
    Ok(())
}

async fn record_emoji_audit(
    state: &ServerState,
    emoji_id: Option<&str>,
    scope_id: Option<&str>,
    actor_id: &str,
    action: &str,
    detail: serde_json::Value,
) {
    let _ = query(
        "INSERT INTO cloud_custom_emoji_audit_log \
         (event_id, emoji_id, scope_id, actor_id, action, detail_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(format!("emoji_audit_{}", uuid::Uuid::new_v4().simple()))
    .bind(emoji_id)
    .bind(scope_id)
    .bind(actor_id)
    .bind(action)
    .bind(detail)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await;
}

async fn list_custom_emojis(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(query_params): Query<ListCustomEmojisQuery>,
) -> Response {
    let scope_id = normalize_scope_id(query_params.scope_id.as_deref());
    let is_admin = if let Some(scope_id) = scope_id.as_deref() {
        match workspace_access(&state, &session.account_id, scope_id).await {
            Ok((_, is_admin)) => is_admin,
            Err(response) => return response,
        }
    } else {
        false
    };
    let include_pending = query_params.include_pending.unwrap_or(false);
    let rows: Vec<EmojiRow> = match query_as(
        "SELECT emoji_id, scope_type, scope_id, name, asset_attachment_id, animated, status, \
                uploaded_by, approved_by, version, mime_type, size_bytes, sha256_hex, \
                created_at, updated_at \
         FROM cloud_custom_emojis \
         WHERE deleted_at IS NULL AND (scope_type = 'global' OR (scope_type = 'workspace' AND scope_id = $1)) \
           AND (status = 'active' OR ($2 AND (uploaded_by = $3 OR $4))) \
         ORDER BY lower(name) ASC",
    )
    .bind(scope_id.as_deref())
    .bind(include_pending)
    .bind(&session.account_id)
    .bind(is_admin)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => return err("server_error", "Could not load custom emoji.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let emoji_ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let alias_rows: Vec<(String, String)> = if emoji_ids.is_empty() {
        vec![]
    } else {
        query_as(
            "SELECT emoji_id, alias FROM cloud_custom_emoji_aliases WHERE emoji_id = ANY($1) ORDER BY alias ASC",
        )
        .bind(&emoji_ids)
        .fetch_all(state.db_pool())
        .await
        .unwrap_or_default()
    };
    let mut aliases_by_id = HashMap::<String, Vec<String>>::new();
    for (emoji_id, alias) in alias_rows {
        aliases_by_id.entry(emoji_id).or_default().push(alias);
    }
    let emojis = rows
        .into_iter()
        .map(|row| {
            let aliases = aliases_by_id.remove(&row.0).unwrap_or_default();
            summary_from_row(row, aliases)
        })
        .collect();
    Json(CustomEmojiListResponse {
        emojis,
        can_manage: is_admin,
    })
    .into_response()
}

async fn create_custom_emoji(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<CreateCustomEmojiRequest>,
) -> Response {
    if request.scope_type.trim() != "workspace" {
        return err(
            "invalid_scope",
            "Client uploads must use workspace scope.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(scope_id) = normalize_scope_id(request.scope_id.as_deref()) else {
        return err(
            "invalid_scope",
            "scopeId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(name) = normalize_emoji_name(&request.name) else {
        return err(
            "invalid_emoji_name",
            "Names must be 2–32 lowercase letters, numbers, underscores, or hyphens.",
            StatusCode::BAD_REQUEST,
        );
    };
    if is_blocked_emoji_name(&name) {
        return err(
            "reserved_emoji_name",
            "That emoji name is reserved.",
            StatusCode::BAD_REQUEST,
        );
    }
    let attachment_id = request.attachment_id.trim();
    if attachment_id.is_empty() {
        return err(
            "invalid_attachment",
            "attachmentId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let (participants, _is_admin) =
        match workspace_access(&state, &session.account_id, &scope_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    let now = Utc::now();
    let attempt_id = format!("emoji_attempt_{}", uuid::Uuid::new_v4().simple());
    if query(
        "INSERT INTO cloud_custom_emoji_upload_attempts (attempt_id, account_id, attempted_at) VALUES ($1, $2, $3)",
    )
    .bind(attempt_id)
    .bind(&session.account_id)
    .bind(now.to_rfc3339())
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR);
    }
    let minute_cutoff = (now - ChronoDuration::minutes(1)).to_rfc3339();
    let attempt_count: (i64,) = match query_as(
        "SELECT COUNT(*) FROM cloud_custom_emoji_upload_attempts WHERE account_id = $1 AND attempted_at >= $2",
    )
    .bind(&session.account_id)
    .bind(&minute_cutoff)
    .fetch_one(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    if attempt_count.0 > USER_UPLOAD_ATTEMPTS_PER_MINUTE {
        return err(
            "emoji_upload_rate_limited",
            "Try again in a minute.",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let active_count: (i64,) = match query_as(
        "SELECT COUNT(*) FROM cloud_custom_emojis \
         WHERE scope_type = 'workspace' AND scope_id = $1 AND deleted_at IS NULL AND status IN ('pending', 'active')",
    )
    .bind(&scope_id)
    .fetch_one(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    if active_count.0 >= WORKSPACE_EMOJI_QUOTA {
        return err(
            "emoji_quota_reached",
            "This workspace already has 250 custom emoji.",
            StatusCode::CONFLICT,
        );
    }
    let alias_collision: (i64,) = match query_as(
        "SELECT COUNT(*) FROM cloud_custom_emoji_aliases WHERE scope_type = 'workspace' AND scope_id = $1 AND lower(alias) = lower($2)",
    )
    .bind(&scope_id)
    .bind(&name)
    .fetch_one(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    if alias_collision.0 > 0 {
        return err(
            "emoji_name_taken",
            "That emoji name is already in use as an alias.",
            StatusCode::CONFLICT,
        );
    }
    let cutoff = (now - ChronoDuration::days(1)).to_rfc3339();
    let recent_count: (i64,) = match query_as(
        "SELECT COUNT(*) FROM cloud_custom_emojis WHERE uploaded_by = $1 AND created_at >= $2",
    )
    .bind(&session.account_id)
    .bind(&cutoff)
    .fetch_one(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if recent_count.0 >= USER_DAILY_SUBMISSION_QUOTA {
        return err(
            "emoji_daily_limit",
            "You can submit up to 20 custom emoji per day.",
            StatusCode::TOO_MANY_REQUESTS,
        );
    }
    let (size_bytes, sha256_hex) =
        match canonicalize_attachment(&state, &session.account_id, attachment_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    let duplicate_asset: Option<(String, String)> = match query_as(
        "SELECT emoji_id, name FROM cloud_custom_emojis \
         WHERE scope_type = 'workspace' AND scope_id = $1 AND sha256_hex = $2 \
           AND deleted_at IS NULL AND status IN ('pending', 'active') LIMIT 1",
    )
    .bind(&scope_id)
    .bind(&sha256_hex)
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if let Some((_emoji_id, duplicate_name)) = duplicate_asset {
        return err(
            "duplicate_emoji_asset",
            format!("This image is already available as :{duplicate_name}:. Add an alias instead."),
            StatusCode::CONFLICT,
        );
    }
    let emoji_id = format!("emoji_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let inserted = query(
        "INSERT INTO cloud_custom_emojis \
         (emoji_id, scope_type, scope_id, name, asset_attachment_id, animated, status, uploaded_by, \
          version, width, height, mime_type, size_bytes, sha256_hex, created_at, updated_at) \
         VALUES ($1, 'workspace', $2, $3, $4, FALSE, 'pending', $5, 1, 128, 128, 'image/webp', $6, $7, $8, $8)",
    )
    .bind(&emoji_id)
    .bind(&scope_id)
    .bind(&name)
    .bind(attachment_id)
    .bind(&session.account_id)
    .bind(size_bytes)
    .bind(&sha256_hex)
    .bind(&now)
    .execute(state.db_pool())
    .await;
    if let Err(error) = inserted {
        if error
            .to_string()
            .contains("idx_cloud_custom_emoji_active_name")
        {
            return err(
                "emoji_name_taken",
                "That emoji name is already in use.",
                StatusCode::CONFLICT,
            );
        }
        return err(
            "server_error",
            "Could not create custom emoji.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let emoji = match load_emoji(&state, &emoji_id).await {
        Ok(Some(emoji)) => emoji,
        _ => {
            return err(
                "server_error",
                "Could not load custom emoji.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    record_emoji_audit(
        &state,
        Some(&emoji_id),
        Some(&scope_id),
        &session.account_id,
        "submitted",
        serde_json::json!({ "name": name, "sha256": sha256_hex }),
    )
    .await;
    let _ = emit_emoji_event(&state, &participants, "custom_emoji.created", &emoji).await;
    (StatusCode::CREATED, Json(CustomEmojiResponse { emoji })).into_response()
}

async fn update_custom_emoji(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(emoji_id): Path<String>,
    Json(request): Json<UpdateCustomEmojiRequest>,
) -> Response {
    let current = match load_emoji(&state, &emoji_id).await {
        Ok(Some(emoji)) => emoji,
        Ok(None) => {
            return err(
                "not_found",
                "Custom emoji not found.",
                StatusCode::NOT_FOUND,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let Some(scope_id) = current.scope_id.as_deref() else {
        return err(
            "forbidden",
            "Global emoji are managed internally.",
            StatusCode::FORBIDDEN,
        );
    };
    let (participants, is_admin) =
        match workspace_access(&state, &session.account_id, scope_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    if !is_admin && current.uploaded_by != session.account_id {
        return err(
            "forbidden",
            "You cannot edit this emoji.",
            StatusCode::FORBIDDEN,
        );
    }
    let next_name = match request.name.as_deref() {
        Some(value) => match normalize_emoji_name(value) {
            Some(value) => value,
            None => {
                return err(
                    "invalid_emoji_name",
                    "Emoji name is invalid.",
                    StatusCode::BAD_REQUEST,
                );
            }
        },
        None => current.name.clone(),
    };
    if is_blocked_emoji_name(&next_name) {
        return err(
            "reserved_emoji_name",
            "That emoji name is reserved.",
            StatusCode::BAD_REQUEST,
        );
    }
    let next_status = request
        .status
        .as_deref()
        .unwrap_or(&current.status)
        .trim()
        .to_ascii_lowercase();
    if next_name != current.name {
        let alias_collision: (i64,) = match query_as(
            "SELECT COUNT(*) FROM cloud_custom_emoji_aliases WHERE scope_type = 'workspace' AND scope_id = $1 AND lower(alias) = lower($2)",
        )
        .bind(scope_id)
        .bind(&next_name)
        .fetch_one(state.db_pool())
        .await
        {
            Ok(value) => value,
            Err(_) => return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR),
        };
        if alias_collision.0 > 0 {
            return err(
                "emoji_name_taken",
                "That emoji name is already in use as an alias.",
                StatusCode::CONFLICT,
            );
        }
    }
    if !matches!(
        next_status.as_str(),
        "pending" | "active" | "rejected" | "disabled"
    ) {
        return err(
            "invalid_status",
            "Emoji status is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }
    if next_status != current.status && !is_admin {
        return err(
            "approval_required",
            "Only a workspace admin can change approval status.",
            StatusCode::FORBIDDEN,
        );
    }
    if current.status != "pending" && next_name != current.name && !is_admin {
        return err(
            "forbidden",
            "Only a workspace admin can rename an approved emoji.",
            StatusCode::FORBIDDEN,
        );
    }
    let approved_by = (next_status == "active").then_some(session.account_id.as_str());
    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_custom_emojis SET name = $1, status = $2, approved_by = COALESCE($3, approved_by), \
         version = version + 1, updated_at = $4 WHERE emoji_id = $5",
    )
    .bind(&next_name)
    .bind(&next_status)
    .bind(approved_by)
    .bind(&now)
    .bind(&emoji_id)
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err("emoji_name_taken", "That emoji name is already in use.", StatusCode::CONFLICT);
    }
    let emoji = match load_emoji(&state, &emoji_id).await {
        Ok(Some(emoji)) => emoji,
        _ => {
            return err(
                "server_error",
                "Could not load custom emoji.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let event_type = if next_status == "disabled" {
        "custom_emoji.disabled"
    } else {
        "custom_emoji.updated"
    };
    record_emoji_audit(
        &state,
        Some(&emoji_id),
        Some(scope_id),
        &session.account_id,
        if next_status != current.status {
            "status_changed"
        } else {
            "renamed"
        },
        serde_json::json!({
            "previousName": current.name,
            "name": next_name,
            "previousStatus": current.status,
            "status": next_status,
        }),
    )
    .await;
    let _ = emit_emoji_event(&state, &participants, event_type, &emoji).await;
    Json(CustomEmojiResponse { emoji }).into_response()
}

async fn create_custom_emoji_alias(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(emoji_id): Path<String>,
    Json(request): Json<CreateCustomEmojiAliasRequest>,
) -> Response {
    let current = match load_emoji(&state, &emoji_id).await {
        Ok(Some(emoji)) => emoji,
        Ok(None) => {
            return err(
                "not_found",
                "Custom emoji not found.",
                StatusCode::NOT_FOUND,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let Some(scope_id) = current.scope_id.as_deref() else {
        return err(
            "forbidden",
            "Global emoji are managed internally.",
            StatusCode::FORBIDDEN,
        );
    };
    let (participants, is_admin) =
        match workspace_access(&state, &session.account_id, scope_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    if !is_admin {
        return err(
            "forbidden",
            "Only a workspace admin can add aliases.",
            StatusCode::FORBIDDEN,
        );
    }
    let Some(alias) = normalize_emoji_name(&request.alias) else {
        return err(
            "invalid_alias",
            "Emoji alias is invalid.",
            StatusCode::BAD_REQUEST,
        );
    };
    if is_blocked_emoji_name(&alias) {
        return err(
            "reserved_emoji_name",
            "That emoji alias is reserved.",
            StatusCode::BAD_REQUEST,
        );
    }
    let name_collision: (i64,) = match query_as(
        "SELECT COUNT(*) FROM cloud_custom_emojis WHERE scope_type = 'workspace' AND scope_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND status IN ('pending', 'active')",
    )
    .bind(scope_id)
    .bind(&alias)
    .fetch_one(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    if name_collision.0 > 0 {
        return err(
            "alias_taken",
            "That alias matches an existing emoji name.",
            StatusCode::CONFLICT,
        );
    }
    if query(
        "INSERT INTO cloud_custom_emoji_aliases (scope_type, scope_id, alias, emoji_id, created_at) \
         VALUES ('workspace', $1, $2, $3, $4)",
    )
    .bind(scope_id)
    .bind(&alias)
    .bind(&emoji_id)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err("alias_taken", "That alias is already in use.", StatusCode::CONFLICT);
    }
    let emoji = match load_emoji(&state, &emoji_id).await {
        Ok(Some(emoji)) => emoji,
        _ => {
            return err(
                "server_error",
                "Could not load custom emoji.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    record_emoji_audit(
        &state,
        Some(&emoji_id),
        Some(scope_id),
        &session.account_id,
        "alias_added",
        serde_json::json!({ "alias": alias }),
    )
    .await;
    let _ = emit_emoji_event(&state, &participants, "custom_emoji.updated", &emoji).await;
    Json(CustomEmojiResponse { emoji }).into_response()
}

async fn custom_emoji_content(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(emoji_id): Path<String>,
) -> Response {
    let emoji = match load_emoji(&state, &emoji_id).await {
        Ok(Some(emoji)) => emoji,
        Ok(None) => {
            return err(
                "not_found",
                "Custom emoji not found.",
                StatusCode::NOT_FOUND,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if let Some(scope_id) = emoji.scope_id.as_deref() {
        if let Err(response) = workspace_access(&state, &session.account_id, scope_id).await {
            return response;
        }
    }
    let object_key: Option<(String,)> = match query_as(
        "SELECT object_key FROM cloud_attachments WHERE attachment_id = $1 AND finalized_at IS NOT NULL",
    )
    .bind(&emoji.asset_attachment_id)
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => return err("server_error", "Database error.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some((object_key,)) = object_key else {
        return err("not_found", "Emoji asset not found.", StatusCode::NOT_FOUND);
    };
    let Some(s3) = state.s3() else {
        return err(
            "object_store_unavailable",
            "Emoji asset is unavailable.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    let download_url = match presign_download_url(s3, &object_key) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not load emoji asset.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let response = match reqwest::Client::new()
        .get(download_url.to_string())
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => {
            return err(
                "object_store_error",
                "Could not load emoji asset.",
                StatusCode::BAD_GATEWAY,
            );
        }
    };
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => {
            return err(
                "object_store_error",
                "Could not load emoji asset.",
                StatusCode::BAD_GATEWAY,
            );
        }
    };
    let mut response = Bytes::from(bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_emoji_names_follow_shortcode_rules() {
        assert_eq!(
            normalize_emoji_name("Party_Parrot"),
            Some("party_parrot".into())
        );
        assert_eq!(normalize_emoji_name("ship-it"), Some("ship-it".into()));
        for invalid in ["a", "_start", "contains space", "UP!", ""] {
            assert_eq!(normalize_emoji_name(invalid), None);
        }
        assert!(is_blocked_emoji_name("everyone"));
        assert!(is_blocked_emoji_name("kordi"));
        assert!(!is_blocked_emoji_name("party_parrot"));
    }

    #[test]
    fn image_pipeline_produces_canonical_webp() {
        let source =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(48, 24, Rgba([255, 0, 0, 255])));
        let mut png = Cursor::new(Vec::new());
        source.write_to(&mut png, ImageFormat::Png).unwrap();
        let (output, sha) = process_static_emoji(png.into_inner()).unwrap();
        assert!(output.len() <= CANONICAL_MAX_BYTES);
        assert_eq!(sha.len(), 64);
        let decoded = image::load_from_memory_with_format(&output, ImageFormat::WebP).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (128, 128));
    }
}
