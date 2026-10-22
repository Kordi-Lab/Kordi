//! Who can see whose card. A profile's card is visible to people who share
//! a room (open or closed, until either leaves) or a pairing with its owner
//! in which the owner shares that profile, only while the owner shares it,
//! and never with hidden topics or references. People never see another
//! profile of the same person.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::profiles::{self, ProfileQuery};
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

/// SQL that is true when the profile in `viewer_profile` may see the card of
/// the profile in `other_profile`: they are paired with those profiles, or
/// both share them in the same room and have not left.
pub(super) fn profile_visible_sql(viewer_profile: &str, other_profile: &str) -> String {
    format!(
        "(EXISTS (
             SELECT 1 FROM cloud_common_ground_pairings
             WHERE (profile_a = {viewer_profile} AND profile_b = {other_profile})
                OR (profile_a = {other_profile} AND profile_b = {viewer_profile})
         ) OR EXISTS (
             SELECT 1 FROM cloud_common_ground_room_members mine
             JOIN cloud_common_ground_room_members theirs
               ON theirs.room_id = mine.room_id AND theirs.profile_id = {other_profile}
                  AND theirs.left_at IS NULL
             WHERE mine.profile_id = {viewer_profile} AND mine.left_at IS NULL
         ))"
    )
}

/// A pair of profiles through which `viewer` sees another person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Link {
    /// The profile the viewer shares there.
    pub viewer_profile: String,
    /// The profile the other person shares with the viewer.
    pub other_profile: String,
    /// Through a pairing or an open room, so new matching may run.
    pub live: bool,
}

/// The most recent pairing or room that makes `other` visible to `viewer`,
/// limited to the viewer sharing `viewer_profile` when given.
pub(super) async fn link(
    pool: &PgPool,
    viewer: &str,
    other: &str,
    viewer_profile: Option<&str>,
) -> sqlx_core::Result<Option<Link>> {
    if viewer == other {
        return Ok(None);
    }
    let sql = format!(
        "SELECT vp, op, bool_or(live) FROM (
             SELECT CASE WHEN p.account_a = $1 THEN p.profile_a ELSE p.profile_b END AS vp,
                    CASE WHEN p.account_a = $1 THEN p.profile_b ELSE p.profile_a END AS op,
                    true AS live, p.created_at AS at
             FROM cloud_common_ground_pairings p
             WHERE p.account_a = LEAST($1, $2) AND p.account_b = GREATEST($1, $2)
             UNION ALL
             SELECT mine.profile_id, theirs.profile_id, {ROOM_OPEN_SQL},
                    GREATEST(mine.joined_at, theirs.joined_at)
             FROM cloud_common_ground_room_members mine
             JOIN cloud_common_ground_room_members theirs
               ON theirs.room_id = mine.room_id AND theirs.account_id = $2 AND theirs.left_at IS NULL
             JOIN cloud_common_ground_rooms room ON room.room_id = mine.room_id
             WHERE mine.account_id = $1 AND mine.left_at IS NULL
         ) links
         WHERE $3::text IS NULL OR vp = $3
         GROUP BY vp, op ORDER BY max(at) DESC, vp, op LIMIT 1"
    );
    let row: Option<(String, String, Option<bool>)> = query_as(&sql)
        .bind(viewer)
        .bind(other)
        .bind(viewer_profile)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(viewer_profile, other_profile, live)| Link {
        viewer_profile,
        other_profile,
        live: live.unwrap_or(false),
    }))
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

/// `GET /v1/cloud/common-ground/people/:account_id?profile=<id>`: the card
/// of the profile another person shares with you. `profile` picks which of
/// your profiles you see them through; by default the most recent room or
/// pairing decides.
pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
    Query(params): Query<ProfileQuery>,
) -> Response {
    let viewer_profile = params.profile.as_deref().filter(|id| !id.is_empty());
    match shared_view(state.db_pool(), &session.account_id, &other, viewer_profile).await {
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
    viewer_profile: Option<&str>,
) -> sqlx_core::Result<Option<Value>> {
    let Some(link) = link(pool, viewer, other, viewer_profile).await? else {
        return Ok(None);
    };
    let Some(card) = card::load(pool, &link.other_profile).await? else {
        return Ok(None);
    };
    if !card.has_card() || !card.sharing {
        return Ok(None);
    }
    type Found = (
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
    );
    let account: Option<Found> = query_as(
        "SELECT account.display_name, account.avatar_url, profile.kind, profile.name,
                profile.design, profile.icon
         FROM cloud_accounts account
         JOIN cloud_common_ground_profiles profile ON profile.account_id = account.account_id
         WHERE account.account_id = $1 AND profile.profile_id = $2",
    )
    .bind(other)
    .bind(&link.other_profile)
    .fetch_optional(pool)
    .await?;
    let Some((name, avatar_url, kind, profile_name, design, icon)) = account else {
        return Ok(None);
    };
    let topics = card.shared_topics();
    let relationship = super::actions::relationship(pool, viewer, other).await?;
    let mut person = person(other, name.as_deref(), avatar_url.as_deref());
    person["profile"] = profiles::tag(
        &link.other_profile,
        &kind,
        &profile_name,
        design.as_deref(),
        icon.as_deref(),
    );
    Ok(Some(json!({
        "person": person,
        "profileId": link.viewer_profile,
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

/// The card lists of the profile `other` shares with `viewer`, at most
/// `limit` topics each, under the same rule as [`shared_view`]: the most
/// recent pairing or room decides which profile that is. The owner sees
/// their default profile while sharing is on. `None` when no card is
/// visible or built.
pub(crate) async fn profile_common_ground(
    pool: &PgPool,
    viewer: &str,
    other: &str,
    limit: usize,
) -> sqlx_core::Result<Option<ProfileCommonGround>> {
    let profile_id = if viewer == other {
        profiles::default_profile(pool, other)
            .await?
            .map(|profile| profile.profile_id)
    } else {
        link(pool, viewer, other, None)
            .await?
            .map(|link| link.other_profile)
    };
    let Some(profile_id) = profile_id else {
        return Ok(None);
    };
    let Some(card) = card::load(pool, &profile_id).await? else {
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
