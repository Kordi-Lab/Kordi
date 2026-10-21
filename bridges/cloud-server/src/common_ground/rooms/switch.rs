//! The profile a member shares in a room: set on join, switched later. A
//! switch clears the member's matches with the room and re-queues them, as
//! a card revision change would.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    Extension, Json,
};
use serde::Deserialize;
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::{my_room, notify_members, room_not_found, view::view_response};
use crate::common_ground::{db_error, err, profiles};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Makes `account` an active member sharing `profile_id`. A member who
/// already shared another profile here loses the matches computed for it
/// with the people in this room.
pub(super) async fn share(
    tx: &mut Transaction<'_, Postgres>,
    room_id: Uuid,
    account: &str,
    profile_id: &str,
) -> sqlx_core::Result<()> {
    let before: Option<(String, bool)> = query_as(
        "SELECT profile_id, left_at IS NULL FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND account_id = $2 FOR UPDATE",
    )
    .bind(room_id)
    .bind(account)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((previous, true)) = &before {
        if previous != profile_id {
            clear_matches(tx, room_id, previous).await?;
        }
    }
    query(
        "INSERT INTO cloud_common_ground_room_members (room_id, account_id, profile_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (room_id, account_id) DO UPDATE SET left_at = NULL,
             profile_id = EXCLUDED.profile_id,
             joined_at = CASE WHEN cloud_common_ground_room_members.left_at IS NULL
                 THEN cloud_common_ground_room_members.joined_at ELSE now() END",
    )
    .bind(room_id)
    .bind(account)
    .bind(profile_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Drops the matches between `profile_id` and the profiles shared in this
/// room, both ways.
async fn clear_matches(
    tx: &mut Transaction<'_, Postgres>,
    room_id: Uuid,
    profile_id: &str,
) -> sqlx_core::Result<()> {
    query(
        "DELETE FROM cloud_common_ground_matches
         WHERE (viewer_profile_id = $2 AND other_profile_id IN (
                    SELECT profile_id FROM cloud_common_ground_room_members
                    WHERE room_id = $1 AND left_at IS NULL))
            OR (other_profile_id = $2 AND viewer_profile_id IN (
                    SELECT profile_id FROM cloud_common_ground_room_members
                    WHERE room_id = $1 AND left_at IS NULL))",
    )
    .bind(room_id)
    .bind(profile_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct SwitchRequest {
    profile_id: String,
}

/// `POST /v1/cloud/common-ground/rooms/:code/profile`: shares another of
/// your profiles in an open room.
pub(in crate::common_ground) async fn switch_profile(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
    Json(body): Json<SwitchRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let room_id = match my_room(pool, &code, account).await {
        Ok(Some((room_id, true))) => room_id,
        Ok(Some(_)) => {
            return err(
                "common_ground_room_closed",
                "This room is closed.",
                StatusCode::CONFLICT,
            )
        }
        Ok(None) => return room_not_found(),
        Err(error) => return db_error(error),
    };
    if body.profile_id.trim().is_empty() {
        return profiles::not_found();
    }
    let profile = match profiles::resolve(pool, account, Some(&body.profile_id)).await {
        Ok(Some(profile)) => profile,
        Ok(None) => return profiles::not_found(),
        Err(response) => return response,
    };
    if let Some(response) = profiles::require_shared_card(pool, &profile).await {
        return response;
    }
    let result = async {
        let mut tx = pool.begin().await?;
        share(&mut tx, room_id, account, &profile.profile_id).await?;
        notify_members(&mut tx, room_id, &code).await?;
        tx.commit().await
    }
    .await;
    match result {
        Ok(()) => view_response(pool, room_id, account).await,
        Err(error) => db_error(error),
    }
}
