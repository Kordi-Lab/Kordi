//! `GET /v1/cloud/common-ground/rooms/:code/preview`: what a code opens
//! before you join, so the join sheet can preselect the suggested profile.
//! Only the room's name, suggested kind and head count are shown; members
//! and groups stay private to members.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{guess_limited, room_not_found, valid_code};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::{card, db_error, ROOM_OPEN_SQL};
use crate::{auth::routes::CloudSession, server::ServerState};

type PreviewRow = (String, Option<String>, i64, bool);

/// The open room for this code as `(name, kind, memberCount, member)`.
/// People count; service accounts do not.
async fn open_preview(
    pool: &PgPool,
    code: &str,
    account: &str,
) -> sqlx_core::Result<Option<PreviewRow>> {
    let sql = format!(
        "SELECT room.name, room.kind,
                (SELECT COUNT(*) FROM cloud_common_ground_room_members member
                 WHERE member.room_id = room.room_id AND member.left_at IS NULL
                   AND NOT (member.account_id = ANY($3))),
                EXISTS(SELECT 1 FROM cloud_common_ground_room_members member
                       WHERE member.room_id = room.room_id AND member.account_id = $2
                         AND member.left_at IS NULL)
         FROM cloud_common_ground_rooms room
         WHERE room.code = $1 AND {ROOM_OPEN_SQL}
         ORDER BY room.created_at DESC LIMIT 1"
    );
    query_as(&sql)
        .bind(code)
        .bind(account)
        .bind(crate::system_account::service_account_ids())
        .fetch_optional(pool)
        .await
}

async fn has_built_card(pool: &PgPool, account: &str) -> sqlx_core::Result<bool> {
    let (built,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_common_ground_profiles profile
                       JOIN cloud_common_ground_cards card ON card.profile_id = profile.profile_id
                       WHERE profile.account_id = $1 AND card.built_at IS NOT NULL)",
    )
    .bind(account)
    .fetch_one(pool)
    .await?;
    Ok(built)
}

pub(in crate::common_ground) async fn preview(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    if !valid_code(&code) {
        return room_not_found();
    }
    let account = session.account_id.as_str();
    // Previews share the join budget, so codes cannot be swept by looking.
    if let Some(response) = guess_limited(&rate_limiter, account, connect_info, &headers).await {
        return response;
    }
    let pool = state.db_pool();
    match has_built_card(pool, account).await {
        Ok(true) => {}
        Ok(false) => return card::no_card(),
        Err(error) => return db_error(error),
    }
    match open_preview(pool, &code, account).await {
        Ok(Some((name, kind, member_count, member))) => (
            StatusCode::OK,
            Json(json!({
                "code": code,
                "name": name,
                "kind": kind,
                "memberCount": member_count,
                "member": member,
            })),
        )
            .into_response(),
        Ok(None) => room_not_found(),
        Err(error) => db_error(error),
    }
}
