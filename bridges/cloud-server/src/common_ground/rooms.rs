//! Rooms: everyone at an event enters the same 4-digit code. The first
//! person to enter a free code opens the room and may name it. A room closes
//! 24 hours after its last join; the code is then free again. Members who
//! have not left keep read-only access to a closed room and its results.
//! Each member shares one of their profiles in a room; the opener may set
//! the profile kind the room suggests.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

mod create;
mod preview;
mod switch;
mod view;

pub(super) use create::create;
pub(super) use preview::preview;

pub(super) use switch::switch_profile;
use view::view_response;
pub(super) use view::{list, read};

use super::profiles::{self, Profile};
use super::{card, db_error, err, limited, ROOM_IP_LIMIT, ROOM_JOIN_LIMIT, ROOM_OPEN_SQL};
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
#[serde(default, rename_all = "camelCase")]
pub(super) struct JoinRequest {
    /// Used only when this join opens the room.
    name: String,
    /// The profile kind the room suggests; used only when this join opens
    /// the room.
    kind: Option<String>,
    /// The profile to share here. Without it: the profile you already share
    /// in the room, else your built profile of the room's kind, else your
    /// default profile.
    profile_id: Option<String>,
}

/// The open room for this code: its suggested kind and the profile
/// `account` shares there, if a member.
async fn open_room(
    pool: &PgPool,
    code: &str,
    account: &str,
) -> sqlx_core::Result<Option<(Option<String>, Option<String>)>> {
    let sql = format!(
        "SELECT room.kind, member.profile_id FROM cloud_common_ground_rooms room
         LEFT JOIN cloud_common_ground_room_members member
           ON member.room_id = room.room_id AND member.account_id = $2 AND member.left_at IS NULL
         WHERE room.code = $1 AND {ROOM_OPEN_SQL}"
    );
    query_as(&sql)
        .bind(code)
        .bind(account)
        .fetch_optional(pool)
        .await
}

/// The profile a join shares, or the response to send instead. `code` is
/// `None` when the room is new.
async fn joining_profile(
    pool: &PgPool,
    code: Option<&str>,
    account: &str,
    body: &JoinRequest,
) -> Result<Profile, Box<Response>> {
    let room = match code {
        Some(code) => open_room(pool, code, account)
            .await
            .map_err(|error| Box::new(db_error(error)))?,
        None => None,
    };
    let (room_kind, current) = match room {
        Some((kind, current)) => (kind, current),
        None => (body.kind.clone(), None),
    };
    let explicit = body
        .profile_id
        .as_deref()
        .filter(|id| !id.trim().is_empty());
    let chosen = profiles::choose(
        pool,
        account,
        explicit.or(current.as_deref()),
        room_kind.as_deref(),
    )
    .await?;
    let Some(profile) = chosen else {
        return Err(Box::new(card::no_card()));
    };
    if let Some(response) = profiles::require_shared_card(pool, &profile).await {
        return Err(Box::new(response));
    }
    Ok(profile)
}

/// Codes are short, so guessing is limited per account and per address.
/// Opening a room counts the same as joining one.
async fn check_limits(
    rate_limiter: &CloudRateLimiter,
    account: &str,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: &HeaderMap,
) -> Option<Response> {
    let client = crate::client_ip::resolve_client_ip(headers, connect_info.map(|info| info.0.ip()));
    let ip_key = format!("ip:{}", rate_limit_client_key(client));
    for (limit, key) in [(ROOM_JOIN_LIMIT, account), (ROOM_IP_LIMIT, ip_key.as_str())] {
        if let RateLimitDecision::Limited { retry_after } =
            rate_limiter.observe_account_limit(limit, key).await
        {
            return Some(limited(retry_after));
        }
    }
    None
}

/// The request body, or the response for an unknown room kind.
fn room_request(body: Option<Json<JoinRequest>>) -> Result<JoinRequest, Box<Response>> {
    let body = body.map(|Json(body)| body).unwrap_or_default();
    if body
        .kind
        .as_deref()
        .is_some_and(|kind| !profiles::valid_kind(kind))
    {
        return Err(Box::new(err(
            "common_ground_invalid_room",
            "Pick work, health, daily or custom.",
            StatusCode::BAD_REQUEST,
        )));
    }
    Ok(body)
}

/// A room name with runs of whitespace collapsed, cut to the length limit.
fn room_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect()
}

/// How entering a code went.
enum Entered {
    Room(Uuid),
    Full,
    /// The code has an open room and only a new room was wanted.
    Taken,
}

/// Opens the room for a free code, or joins its open room unless
/// `new_only`, sharing `profile`. `name` and the body's kind apply only to
/// a new room.
async fn enter(
    pool: &PgPool,
    code: &str,
    account: &str,
    body: &JoinRequest,
    profile: &Profile,
    name: &str,
    new_only: bool,
) -> sqlx_core::Result<Entered> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-room:' || $1))")
        .bind(code)
        .execute(&mut *tx)
        .await?;
    // An open row whose last join is over a day old has expired.
    query(
        "UPDATE cloud_common_ground_rooms SET closed_at = now()
         WHERE code = $1 AND closed_at IS NULL AND last_join_at <= now() - interval '24 hours'",
    )
    .bind(code)
    .execute(&mut *tx)
    .await?;
    let open: Option<(Uuid,)> = query_as(
        "SELECT room_id FROM cloud_common_ground_rooms WHERE code = $1 AND closed_at IS NULL",
    )
    .bind(code)
    .fetch_optional(&mut *tx)
    .await?;
    let room_id = match open {
        Some(_) if new_only => return Ok(Entered::Taken),
        Some((room_id,)) => room_id,
        None => {
            let room_id = Uuid::new_v4();
            query(
                "INSERT INTO cloud_common_ground_rooms (room_id, code, name, created_by, kind)
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(room_id)
            .bind(code)
            .bind(name)
            .bind(account)
            .bind(&body.kind)
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
        return Ok(Entered::Full);
    }
    // Joining again with another profile switches the shared profile.
    switch::share(&mut tx, room_id, account, &profile.profile_id).await?;
    query("UPDATE cloud_common_ground_rooms SET last_join_at = now() WHERE room_id = $1")
        .bind(room_id)
        .execute(&mut *tx)
        .await?;
    notify_members(&mut tx, room_id, code).await?;
    tx.commit().await?;
    Ok(Entered::Room(room_id))
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
    if let Some(response) = check_limits(&rate_limiter, account, connect_info, &headers).await {
        return response;
    }
    let pool = state.db_pool();
    let body = match room_request(body) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let profile = match joining_profile(pool, Some(&code), account, &body).await {
        Ok(profile) => profile,
        Err(response) => return *response,
    };
    let name = room_name(&body.name);
    match enter(pool, &code, account, &body, &profile, &name, false).await {
        Ok(Entered::Room(room_id)) => view_response(pool, room_id, account).await,
        Ok(Entered::Full | Entered::Taken) => room_full(),
        Err(error) => db_error(error),
    }
}

fn room_full() -> Response {
    err(
        "common_ground_room_full",
        "This room is full.",
        StatusCode::CONFLICT,
    )
}

/// A room with this code that `account` is in and has not left, with
/// whether it is still open. Codes are reused once a room closes, so an open
/// room comes first, then the newest closed one.
pub(super) async fn my_room(
    pool: &PgPool,
    code: &str,
    account: &str,
) -> sqlx_core::Result<Option<(Uuid, bool)>> {
    if !valid_code(code) {
        return Ok(None);
    }
    let sql = format!(
        "SELECT room.room_id, {ROOM_OPEN_SQL} AS open FROM cloud_common_ground_rooms room
         JOIN cloud_common_ground_room_members member
           ON member.room_id = room.room_id AND member.account_id = $2 AND member.left_at IS NULL
         WHERE room.code = $1
         ORDER BY open DESC, room.created_at DESC, room.room_id LIMIT 1"
    );
    query_as(&sql)
        .bind(code)
        .bind(account)
        .fetch_optional(pool)
        .await
}

/// `POST /v1/cloud/common-ground/rooms/:code/leave`: leaves an open room,
/// or removes a closed one from your rooms.
pub(super) async fn leave(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let room_id = match my_room(pool, &code, account).await {
        Ok(Some((room_id, _))) => room_id,
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

/// Leaves every room where `profile_id` is the shared profile and returns
/// them, for announcing.
pub(super) async fn leave_profile(
    tx: &mut Transaction<'_, Postgres>,
    profile_id: &str,
) -> sqlx_core::Result<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_common_ground_room_members SET left_at = now()
         WHERE profile_id = $1 AND left_at IS NULL RETURNING room_id",
    )
    .bind(profile_id)
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

#[cfg(test)]
pub(super) fn valid_code_for_tests(code: &str) -> bool {
    valid_code(code)
}
