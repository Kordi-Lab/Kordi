//! Your rooms list and a room's lobby. Every member shows the profile they
//! share in the room.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{member_count_sql, my_room, room_not_found};
use crate::common_ground::{actions, db_error, people, profiles, ROOM_OPEN_SQL};
use crate::{auth::routes::CloudSession, server::ServerState};

type ListRow = (
    String,
    String,
    Option<String>,
    String,
    bool,
    i64,
    DateTime<Utc>,
    DateTime<Utc>,
    i32,
);

/// `GET /v1/cloud/common-ground/rooms`: rooms you are in, open or closed,
/// newest activity first. Leaving a room removes it. Only the room a code
/// opens for you is listed.
pub(in crate::common_ground) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let sql = format!(
        "SELECT code, name, kind, profile_id, open, member_count, joined_at, last_activity_at,
                theme_count FROM (
             SELECT DISTINCT ON (room.code) room.code, room.name, room.kind, member.profile_id,
                    {ROOM_OPEN_SQL} AS open,
                    {member_count} AS member_count,
                    member.joined_at,
                    GREATEST(room.last_join_at, themes.computed_at) AS last_activity_at,
                    COALESCE(jsonb_array_length(themes.themes_json), 0) AS theme_count
             FROM cloud_common_ground_rooms room
             JOIN cloud_common_ground_room_members member
               ON member.room_id = room.room_id AND member.account_id = $1 AND member.left_at IS NULL
             LEFT JOIN cloud_common_ground_room_themes themes ON themes.room_id = room.room_id
             ORDER BY room.code, open DESC, room.created_at DESC, room.room_id
         ) mine
         ORDER BY last_activity_at DESC, code LIMIT 50",
        member_count = member_count_sql(2)
    );
    let rows: Result<Vec<ListRow>, _> = query_as(&sql)
        .bind(&session.account_id)
        .bind(crate::system_account::service_account_ids())
        .fetch_all(state.db_pool())
        .await;
    match rows {
        Ok(rows) => {
            let rooms: Vec<Value> = rows
                .into_iter()
                .map(
                    |(code, name, kind, profile_id, open, members, joined_at, activity, themes)| {
                        json!({
                            "code": code,
                            "name": name,
                            "kind": kind,
                            "profileId": profile_id,
                            "open": open,
                            "memberCount": members,
                            "joinedAt": joined_at,
                            "lastActivityAt": activity,
                            "themeCount": themes,
                        })
                    },
                )
                .collect();
            (StatusCode::OK, Json(json!({ "rooms": rooms }))).into_response()
        }
        Err(error) => db_error(error),
    }
}

/// `GET /v1/cloud/common-ground/rooms/:code`: the lobby, for members only.
/// A closed room still answers, read-only, for members who have not left.
pub(in crate::common_ground) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    match my_room(pool, &code, &session.account_id).await {
        Ok(Some((room_id, _))) => view_response(pool, room_id, &session.account_id).await,
        Ok(None) => room_not_found(),
        Err(error) => db_error(error),
    }
}

type MemberRow = (
    String,
    Option<String>,
    Option<String>,
    bool,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);
type RoomRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
    bool,
    Option<String>,
);

pub(in crate::common_ground) async fn view(
    pool: &PgPool,
    room_id: Uuid,
    viewer: &str,
) -> sqlx_core::Result<Value> {
    let sql = format!(
        "SELECT room.code, room.name, room.kind, room.created_by, room.last_join_at, {ROOM_OPEN_SQL},
                (SELECT member.profile_id FROM cloud_common_ground_room_members member
                 WHERE member.room_id = room.room_id AND member.account_id = $2)
         FROM cloud_common_ground_rooms room WHERE room.room_id = $1"
    );
    let (code, name, kind, created_by, last_join_at, open, profile_id): RoomRow = query_as(&sql)
        .bind(room_id)
        .bind(viewer)
        .fetch_one(pool)
        .await?;
    // Members arrive in join order; you are never in the list.
    let members: Vec<MemberRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url,
                COALESCE(card.built_at IS NOT NULL AND card.sharing_enabled, false),
                profile.profile_id, profile.kind, profile.name, profile.design,
                profile.icon
         FROM cloud_common_ground_room_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         JOIN cloud_common_ground_profiles profile ON profile.profile_id = member.profile_id
         LEFT JOIN cloud_common_ground_cards card ON card.profile_id = member.profile_id
         WHERE member.room_id = $1 AND member.left_at IS NULL AND member.account_id <> $2
         ORDER BY member.joined_at, member.account_id",
    )
    .bind(room_id)
    .bind(viewer)
    .fetch_all(pool)
    .await?;
    let ids: Vec<String> = members.iter().map(|m| m.0.clone()).collect();
    let relationships = actions::relationships(pool, viewer, &ids).await?;
    let members: Vec<Value> = members
        .into_iter()
        .map(
            |(
                account_id,
                display_name,
                avatar_url,
                has_card,
                profile,
                kind,
                profile_name,
                design,
                icon,
            )| {
                let mut person =
                    people::person(&account_id, display_name.as_deref(), avatar_url.as_deref());
                person["hasCard"] = json!(has_card);
                person["profile"] = profiles::tag(
                    &profile,
                    &kind,
                    &profile_name,
                    design.as_deref(),
                    icon.as_deref(),
                );
                actions::attach(&mut person, &account_id, &relationships);
                person
            },
        )
        .collect();
    let (groups, invitations) = actions::room_extras(pool, room_id, viewer).await?;
    Ok(json!({
        "roomId": room_id,
        "code": code,
        "name": name,
        "kind": kind,
        "profileId": profile_id,
        "openedByYou": created_by.as_deref() == Some(viewer),
        "open": open,
        "expiresAt": last_join_at + chrono::Duration::hours(24),
        "members": members,
        "groups": groups,
        "invitations": invitations,
    }))
}

pub(in crate::common_ground) async fn view_response(
    pool: &PgPool,
    room_id: Uuid,
    viewer: &str,
) -> Response {
    match view(pool, room_id, viewer).await {
        Ok(view) => (StatusCode::OK, Json(view)).into_response(),
        Err(error) => db_error(error),
    }
}
