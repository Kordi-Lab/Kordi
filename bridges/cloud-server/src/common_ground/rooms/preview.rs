//! `GET /v1/cloud/common-ground/rooms/:code/preview`: what a code opens
//! before you join, so the join sheet can preselect the profile. Only the
//! room's name, suggested kind and head count are shown; members and groups
//! stay private to members.

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

use super::{address_key, member_count_sql, room_not_found, sharing_profile, valid_code};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::common_ground::{db_error, limited, ROOM_IP_LIMIT, ROOM_JOIN_LIMIT, ROOM_OPEN_SQL};
use crate::{auth::routes::CloudSession, server::ServerState};

/// `(name, kind, memberCount, the profile the caller shares there)`.
type PreviewRow = (String, Option<String>, i64, Option<String>);

/// The open room for this code. People count; service accounts do not.
async fn open_preview(
    pool: &PgPool,
    code: &str,
    account: &str,
) -> sqlx_core::Result<Option<PreviewRow>> {
    let sql = format!(
        "SELECT room.name, room.kind, {member_count}, member.profile_id
         FROM cloud_common_ground_rooms room
         LEFT JOIN cloud_common_ground_room_members member
           ON member.room_id = room.room_id AND member.account_id = $2 AND member.left_at IS NULL
         WHERE room.code = $1 AND {ROOM_OPEN_SQL}
         ORDER BY room.created_at DESC LIMIT 1",
        member_count = member_count_sql(3)
    );
    query_as(&sql)
        .bind(code)
        .bind(account)
        .bind(crate::system_account::service_account_ids())
        .fetch_optional(pool)
        .await
}

/// Every preview counts against the address. Only misses spend the
/// account's guess budget, which joining shares, so looking up the right
/// code never stands in the way of joining it. Once the budget is spent,
/// every preview is refused, so hits and misses still look the same.
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
    let ip_key = address_key(connect_info, &headers);
    for decision in [
        rate_limiter
            .observe_account_limit(ROOM_IP_LIMIT, &ip_key)
            .await,
        rate_limiter
            .peek_account_limit(ROOM_JOIN_LIMIT, account)
            .await,
    ] {
        if let RateLimitDecision::Limited { retry_after } = decision {
            return limited(retry_after);
        }
    }
    let pool = state.db_pool();
    let (name, kind, member_count, current) = match open_preview(pool, &code, account).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            return match rate_limiter
                .observe_account_limit(ROOM_JOIN_LIMIT, account)
                .await
            {
                RateLimitDecision::Limited { retry_after } => limited(retry_after),
                RateLimitDecision::Allowed => room_not_found(),
            };
        }
        Err(error) => return db_error(error),
    };
    // The same choice and checks a join makes, so a preview fails as a
    // join would and suggests the profile a join would share.
    let suggested = match sharing_profile(pool, account, current.as_deref(), kind.as_deref()).await
    {
        Ok(profile) => profile,
        Err(response) => return *response,
    };
    (
        StatusCode::OK,
        Json(json!({
            "code": code,
            "name": name,
            "kind": kind,
            "memberCount": member_count,
            "member": current.is_some(),
            "profileId": current,
            "suggestedProfileId": suggested.profile_id,
        })),
    )
        .into_response()
}
