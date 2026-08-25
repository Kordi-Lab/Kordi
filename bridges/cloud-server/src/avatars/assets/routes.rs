use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::*;
use crate::attachments::presign_download_url;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

pub async fn upload_avatar_asset(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(query): Query<UploadAvatarQuery>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let entity_type = query.entity_type.trim();
    let entity_id = query
        .entity_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&session.account_id);
    if !upload_is_authorized(state.db_pool(), &session.account_id, entity_type, entity_id).await {
        return asset_error(
            StatusCode::FORBIDDEN,
            "avatar_forbidden",
            "The avatar target is unavailable.",
        );
    }
    if let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    {
        if !matches!(
            content_type.split(';').next().unwrap_or_default().trim(),
            "image/png" | "image/jpeg" | "image/jpg" | "image/webp"
        ) {
            return asset_error(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_avatar",
                "Avatar must be a PNG, JPEG, or WebP image.",
            );
        }
    }
    let Some(s3) = state.s3() else {
        return asset_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "avatar_storage_unavailable",
            "Avatar storage is unavailable.",
        );
    };
    match store_avatar_asset(
        state.db_pool(),
        s3,
        &session.account_id,
        entity_type,
        entity_id,
        bytes.to_vec(),
    )
    .await
    {
        Ok(uploaded_asset) => Json(UploadAvatarResponse { uploaded_asset }).into_response(),
        Err(AvatarAssetError::Invalid(message)) => {
            asset_error(StatusCode::BAD_REQUEST, "invalid_avatar", message)
        }
        Err(AvatarAssetError::Unavailable | AvatarAssetError::ObjectStore) => asset_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "avatar_storage_unavailable",
            "Avatar storage is unavailable.",
        ),
        Err(AvatarAssetError::Database(error)) => {
            eprintln!("[avatars] store uploaded asset: {error}");
            asset_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "Avatar could not be stored.",
            )
        }
    }
}

pub async fn render_uploaded_avatar(
    State(state): State<Arc<ServerState>>,
    Path((asset_id, file_name)): Path<(String, String)>,
) -> Response {
    if !valid_asset_id(&asset_id) {
        return not_found();
    }
    let Some(size_text) = file_name.strip_suffix(".jpg") else {
        return not_found();
    };
    let Ok(size) = size_text.parse::<u32>() else {
        return not_found();
    };
    if !AVATAR_VARIANT_SIZES.contains(&size) {
        return not_found();
    }
    let row: Option<(String,)> = match query_as(
        "SELECT object_prefix FROM cloud_avatar_assets \
         WHERE asset_id = $1 AND activated_at IS NOT NULL",
    )
    .bind(&asset_id)
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[avatars] load uploaded asset: {error}");
            return asset_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "Avatar could not be loaded.",
            );
        }
    };
    let Some((object_prefix,)) = row else {
        return not_found();
    };
    let Some(s3) = state.s3() else {
        return unavailable();
    };
    let object_key = format!("{object_prefix}/{size}.jpg");
    let url = match presign_download_url(s3, &object_key) {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    let object = match object_store_client().get(url.to_string()).send().await {
        Ok(value) if value.status().is_success() => value,
        _ => return not_found(),
    };
    let bytes = match object.bytes().await {
        Ok(value) if value.len() <= MAX_SERVED_AVATAR_BYTES => value,
        _ => return unavailable(),
    };
    let mut response = bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("\"{asset_id}-{size}\"")) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
}

async fn upload_is_authorized(
    pool: &PgPool,
    owner_account_id: &str,
    entity_type: &str,
    entity_id: &str,
) -> bool {
    if entity_type == "human" {
        return entity_id == owner_account_id;
    }
    if entity_type != "agent" {
        return false;
    }
    query_as::<_, (i32,)>(
        "SELECT 1 FROM cloud_agent_definitions \
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active' \
           AND is_system_managed = FALSE",
    )
    .bind(entity_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .is_some()
}

fn not_found() -> Response {
    asset_error(
        StatusCode::NOT_FOUND,
        "avatar_not_found",
        "Avatar was not found.",
    )
}

fn unavailable() -> Response {
    asset_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "avatar_storage_unavailable",
        "Avatar storage is unavailable.",
    )
}

fn asset_error(status: StatusCode, code: &'static str, message: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({ "errorCode": code, "message": message })),
    )
        .into_response()
}
