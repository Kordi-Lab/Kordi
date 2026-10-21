//! Who can see whose card. A card is visible to people who share a room
//! (open or closed, until either leaves) or a pairing with its owner, only
//! while the owner shares it, and never with hidden topics or references.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::{card, db_error, err, ROOM_OPEN_SQL};
use crate::document_shares::access::{clean_display_name, syncable_avatar_url};
use crate::{auth::routes::CloudSession, server::ServerState};

pub(super) fn person(account_id: &str, name: Option<&str>, avatar_url: Option<&str>) -> Value {
    json!({
        "accountId": account_id,
        "name": clean_display_name(name),
        "avatarUrl": avatar_url.and_then(syncable_avatar_url),
    })
}

/// SQL that is true when the account in `viewer` may see the shared card of
/// the account in `other` (both SQL expressions): they are paired, or both
/// are still in the same room, open or closed. Leaving a room withdraws it.
pub(super) fn visible_sql(viewer: &str, other: &str) -> String {
    visibility_sql(viewer, other, "true")
}

/// Like [`visible_sql`], but only through a pairing or an open room: the
/// pairs for which new matching may still run.
pub(super) fn live_sql(viewer: &str, other: &str) -> String {
    visibility_sql(viewer, other, ROOM_OPEN_SQL)
}

fn visibility_sql(viewer: &str, other: &str, room_filter: &str) -> String {
    format!(
        "(EXISTS (
             SELECT 1 FROM cloud_common_ground_pairings
             WHERE account_a = LEAST({viewer}, {other}) AND account_b = GREATEST({viewer}, {other})
         ) OR EXISTS (
             SELECT 1 FROM cloud_common_ground_room_members mine
             JOIN cloud_common_ground_room_members theirs
               ON theirs.room_id = mine.room_id AND theirs.account_id = {other}
                  AND theirs.left_at IS NULL
             JOIN cloud_common_ground_rooms room ON room.room_id = mine.room_id
             WHERE mine.account_id = {viewer} AND mine.left_at IS NULL AND {room_filter}
         ))"
    )
}

/// Whether `viewer` may see `other`'s shared card.
pub(super) async fn can_see<'e, E>(
    executor: E,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    if viewer == other {
        return Ok(true);
    }
    check(executor, &visible_sql("$1", "$2"), viewer, other).await
}

/// Whether new matching may run for `viewer` and `other`: a pairing or an
/// open room, not only a closed one.
pub(super) async fn is_live(pool: &PgPool, viewer: &str, other: &str) -> sqlx_core::Result<bool> {
    check(pool, &live_sql("$1", "$2"), viewer, other).await
}

async fn check<'e, E>(
    executor: E,
    condition: &str,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!("SELECT {condition}");
    let (visible,): (bool,) = query_as(&sql)
        .bind(viewer)
        .bind(other)
        .fetch_one(executor)
        .await?;
    Ok(visible)
}

/// `GET /v1/cloud/common-ground/people/:account_id`: another person's card
/// as you may see it.
pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
) -> Response {
    match shared_view(state.db_pool(), &session.account_id, &other).await {
        Ok(Some(view)) => (StatusCode::OK, Json(view)).into_response(),
        Ok(None) => not_found(),
        Err(error) => db_error(error),
    }
}

pub(super) fn not_found() -> Response {
    err(
        "common_ground_person_not_found",
        "This card isn't available.",
        StatusCode::NOT_FOUND,
    )
}

pub(super) async fn shared_view(
    pool: &PgPool,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<Option<Value>> {
    if viewer == other || !can_see(pool, viewer, other).await? {
        return Ok(None);
    }
    let Some(card) = card::load(pool, other).await? else {
        return Ok(None);
    };
    if !card.has_card() || !card.sharing {
        return Ok(None);
    }
    let account: Option<(Option<String>, Option<String>)> =
        query_as("SELECT display_name, avatar_url FROM cloud_accounts WHERE account_id = $1")
            .bind(other)
            .fetch_optional(pool)
            .await?;
    let Some((name, avatar_url)) = account else {
        return Ok(None);
    };
    let topics = card.shared_topics();
    let relationship = super::actions::relationship(pool, viewer, other).await?;
    Ok(Some(json!({
        "person": person(other, name.as_deref(), avatar_url.as_deref()),
        "relationship": relationship,
        "card": {
            "workingOn": topics.working_on,
            "interests": topics.interests,
            "canHelp": topics.can_help,
            "lookingFor": topics.looking_for,
        },
    })))
}

/// The card lists shown on a contact profile (#1945).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileCommonGround {
    pub working_on: Vec<String>,
    pub can_help: Vec<String>,
    pub looking_for: Vec<String>,
}

/// `other`'s shared card lists as `viewer` may see them, at most `limit`
/// topics each, under the same rule as [`shared_view`]; the owner sees their
/// own while sharing is on. `None` when the card is not visible or not built.
pub(crate) async fn profile_common_ground(
    pool: &PgPool,
    viewer: &str,
    other: &str,
    limit: usize,
) -> sqlx_core::Result<Option<ProfileCommonGround>> {
    if !can_see(pool, viewer, other).await? {
        return Ok(None);
    }
    let Some(card) = card::load(pool, other).await? else {
        return Ok(None);
    };
    if !card.has_card() || !card.sharing {
        return Ok(None);
    }
    let topics = card.shared_topics();
    let take = |list: Vec<String>| list.into_iter().take(limit).collect();
    Ok(Some(ProfileCommonGround {
        working_on: take(topics.working_on),
        can_help: take(topics.can_help),
        looking_for: take(topics.looking_for),
    }))
}
