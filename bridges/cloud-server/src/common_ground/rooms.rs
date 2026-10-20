//! Rooms: everyone at an event enters the same 4-digit code. The first
//! person to enter a free code opens the room and may name it. A room closes
//! 24 hours after its last join; the code is then free again.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::{card, db_error, err, limited, people, ROOM_IP_LIMIT, ROOM_JOIN_LIMIT, ROOM_OPEN_SQL};
use crate::auth::rate_limit::{rate_limit_client_key, CloudRateLimiter, RateLimitDecision};
use crate::{auth::routes::CloudSession, server::ServerState};

pub(super) const MAX_MEMBERS: i64 = 200;
const MAX_NAME_CHARS: usize = 80;

fn valid_code(code: &str) -> bool {
    code.len() == 4 && code.bytes().all(|b| b.is_ascii_digit())
}

pub(super) fn room_not_found() -> Response {
    err(
        "common_ground_room_not_found",
        "Room not found.",
        StatusCode::NOT_FOUND,
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct JoinRequest {
    /// Used only when this join opens the room.
    name: String,
}

pub(super) async fn join(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(code): Path<String>,
    body: Option<Json<JoinRequest>>,
) -> Response {
    if !valid_code(&code) {
        return room_not_found();
    }
    let account = session.account_id.as_str();
    // Codes are short, so guessing is limited per account and per address.
    let client =
        crate::client_ip::resolve_client_ip(&headers, connect_info.map(|info| info.0.ip()));
    let ip_key = format!("ip:{}", rate_limit_client_key(client));
    for (limit, key) in [(ROOM_JOIN_LIMIT, account), (ROOM_IP_LIMIT, ip_key.as_str())] {
        if let RateLimitDecision::Limited { retry_after } =
            rate_limiter.observe_account_limit(limit, key).await
        {
            return limited(retry_after);
        }
    }
    let pool = state.db_pool();
    match card::load(pool, account).await {
        Ok(Some(row)) if row.has_card() && row.sharing => {}
        Ok(Some(row)) if row.has_card() => return super::sharing_off(),
        Ok(_) => return card::no_card(),
        Err(error) => return db_error(error),
    }
    let name: String = body
        .map(|Json(body)| body.name)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    let result = async {
        let mut tx = pool.begin().await?;
        query("SELECT pg_advisory_xact_lock(hashtext('common-ground-room:' || $1))")
            .bind(&code)
            .execute(&mut *tx)
            .await?;
        // An open row whose last join is over a day old has expired.
        query(
            "UPDATE cloud_common_ground_rooms SET closed_at = now()
             WHERE code = $1 AND closed_at IS NULL AND last_join_at <= now() - interval '24 hours'",
        )
        .bind(&code)
        .execute(&mut *tx)
        .await?;
        let open: Option<(Uuid,)> = query_as(
            "SELECT room_id FROM cloud_common_ground_rooms WHERE code = $1 AND closed_at IS NULL",
        )
        .bind(&code)
        .fetch_optional(&mut *tx)
        .await?;
        let room_id = match open {
            Some((room_id,)) => room_id,
            None => {
                let room_id = Uuid::new_v4();
                query(
                    "INSERT INTO cloud_common_ground_rooms (room_id, code, name, created_by)
                     VALUES ($1, $2, $3, $4)",
                )
                .bind(room_id)
                .bind(&code)
                .bind(&name)
                .bind(account)
                .execute(&mut *tx)
                .await?;
                room_id
            }
        };
        let (members,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_common_ground_room_members
             WHERE room_id = $1 AND left_at IS NULL AND account_id <> $2",
        )
        .bind(room_id)
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
        if members >= MAX_MEMBERS {
            return Ok(None);
        }
        query(
            "INSERT INTO cloud_common_ground_room_members (room_id, account_id) VALUES ($1, $2)
             ON CONFLICT (room_id, account_id) DO UPDATE SET left_at = NULL,
                 joined_at = CASE WHEN cloud_common_ground_room_members.left_at IS NULL
                     THEN cloud_common_ground_room_members.joined_at ELSE now() END",
        )
        .bind(room_id)
        .bind(account)
        .execute(&mut *tx)
        .await?;
        query("UPDATE cloud_common_ground_rooms SET last_join_at = now() WHERE room_id = $1")
            .bind(room_id)
            .execute(&mut *tx)
            .await?;
        notify_members(&mut tx, room_id, &code).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(Some(room_id))
    }
    .await;
    match result {
        Ok(Some(room_id)) => view_response(pool, room_id, account).await,
        Ok(None) => err(
            "common_ground_room_full",
            "This room is full.",
            StatusCode::CONFLICT,
        ),
        Err(error) => db_error(error),
    }
}

/// The open room with this code that `account` is in.
pub(super) async fn my_room(
    pool: &PgPool,
    code: &str,
    account: &str,
) -> sqlx_core::Result<Option<Uuid>> {
    if !valid_code(code) {
        return Ok(None);
    }
    let sql = format!(
        "SELECT room.room_id FROM cloud_common_ground_rooms room
         JOIN cloud_common_ground_room_members member
           ON member.room_id = room.room_id AND member.account_id = $2 AND member.left_at IS NULL
         WHERE room.code = $1 AND {ROOM_OPEN_SQL}"
    );
    let row: Option<(Uuid,)> = query_as(&sql)
        .bind(code)
        .bind(account)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(room_id,)| room_id))
}

/// `GET /v1/cloud/common-ground/rooms/:code`: the lobby, for members only.
pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    match my_room(pool, &code, &session.account_id).await {
        Ok(Some(room_id)) => view_response(pool, room_id, &session.account_id).await,
        Ok(None) => room_not_found(),
        Err(error) => db_error(error),
    }
}

pub(super) async fn leave(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let room_id = match my_room(pool, &code, account).await {
        Ok(Some(room_id)) => room_id,
        Ok(None) => return room_not_found(),
        Err(error) => return db_error(error),
    };
    let result = query(
        "UPDATE cloud_common_ground_room_members SET left_at = now()
         WHERE room_id = $1 AND account_id = $2 AND left_at IS NULL",
    )
    .bind(room_id)
    .bind(account)
    .execute(pool)
    .await;
    if let Err(error) = result {
        return db_error(error);
    }
    announce(pool, room_id).await;
    StatusCode::NO_CONTENT.into_response()
}

/// Leaves every room `account` is in and returns them, for announcing.
pub(super) async fn leave_all(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
) -> sqlx_core::Result<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_common_ground_room_members SET left_at = now()
         WHERE account_id = $1 AND left_at IS NULL RETURNING room_id",
    )
    .bind(account)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(room_id,)| room_id).collect())
}

/// Tells everyone still in the room that its members changed. Best effort:
/// clients also refresh the lobby while it is open.
pub(super) async fn announce(pool: &PgPool, room_id: Uuid) {
    let result = async {
        let mut tx = pool.begin().await?;
        let (code,): (String,) =
            query_as("SELECT code FROM cloud_common_ground_rooms WHERE room_id = $1")
                .bind(room_id)
                .fetch_one(&mut *tx)
                .await?;
        notify_members(&mut tx, room_id, &code).await?;
        tx.commit().await
    }
    .await;
    if let Err(error) = result {
        eprintln!("[common-ground] Could not announce a room change: {error}");
    }
}

pub(super) async fn notify_members(
    tx: &mut Transaction<'_, Postgres>,
    room_id: Uuid,
    code: &str,
) -> sqlx_core::Result<()> {
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND left_at IS NULL",
    )
    .bind(room_id)
    .fetch_all(&mut **tx)
    .await?;
    for (account,) in members {
        super::hint(
            tx,
            &account,
            "common_ground.room.updated",
            json!({ "code": code }),
        )
        .await?;
    }
    Ok(())
}

type MemberRow = (String, Option<String>, Option<String>, bool);

pub(super) async fn view(pool: &PgPool, room_id: Uuid, viewer: &str) -> sqlx_core::Result<Value> {
    let (code, name, created_by, last_join_at): (String, String, Option<String>, DateTime<Utc>) =
        query_as(
            "SELECT code, name, created_by, last_join_at FROM cloud_common_ground_rooms
             WHERE room_id = $1",
        )
        .bind(room_id)
        .fetch_one(pool)
        .await?;
    // Members arrive in join order; you are never in the list.
    let members: Vec<MemberRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url,
                COALESCE(card.built_at IS NOT NULL AND card.sharing_enabled, false)
         FROM cloud_common_ground_room_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         LEFT JOIN cloud_common_ground_cards card ON card.account_id = member.account_id
         WHERE member.room_id = $1 AND member.left_at IS NULL AND member.account_id <> $2
         ORDER BY member.joined_at, member.account_id",
    )
    .bind(room_id)
    .bind(viewer)
    .fetch_all(pool)
    .await?;
    let ids: Vec<String> = members.iter().map(|m| m.0.clone()).collect();
    let relationships = super::actions::relationships(pool, viewer, &ids).await?;
    let members: Vec<Value> = members
        .into_iter()
        .map(|(account_id, display_name, avatar_url, has_card)| {
            let mut person =
                people::person(&account_id, display_name.as_deref(), avatar_url.as_deref());
            person["hasCard"] = json!(has_card);
            super::actions::attach(&mut person, &account_id, &relationships);
            person
        })
        .collect();
    let (groups, invitations) = super::actions::room_extras(pool, room_id, viewer).await?;
    Ok(json!({
        "roomId": room_id,
        "code": code,
        "name": name,
        "openedByYou": created_by.as_deref() == Some(viewer),
        "expiresAt": last_join_at + chrono::Duration::hours(24),
        "members": members,
        "groups": groups,
        "invitations": invitations,
    }))
}

async fn view_response(pool: &PgPool, room_id: Uuid, viewer: &str) -> Response {
    match view(pool, room_id, viewer).await {
        Ok(view) => (StatusCode::OK, Json(view)).into_response(),
        Err(error) => db_error(error),
    }
}

#[cfg(test)]
pub(super) fn valid_code_for_tests(code: &str) -> bool {
    valid_code(code)
}
