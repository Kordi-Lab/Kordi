//! Join: an invited room member joins a group started from the room.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use uuid::Uuid;

use crate::auth::routes::{
    audit_join, redeem_group_invitation_by_id, CloudSession, Redemption, ROOM_GROUP_MIN_MEMBERS,
};
use crate::common_ground::{db_error, err, intro, rooms};
use crate::server::ServerState;
use crate::system_account::SYSTEM_ACCOUNT_ID;

fn invitation_not_found() -> Response {
    err(
        "common_ground_invitation_not_found",
        "Invitation not found.",
        StatusCode::NOT_FOUND,
    )
}

type InvitationRow = (String, String, Uuid, String, bool);

/// `POST /v1/cloud/common-ground/rooms/:code/invitations/:ref/join`.
pub(in crate::common_ground) async fn join(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((code, invitation_ref)): Path<(String, String)>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room_id = match rooms::my_room(pool, &code, viewer).await {
        Ok(Some((room_id, _))) => room_id,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    let row: Result<Option<InvitationRow>, _> = query_as(
        "SELECT invite.group_space_id, invite.group_invitation_id, room_group.conversation_id,
                room_group.name, invite.accepted_at IS NOT NULL
         FROM cloud_common_ground_room_invitations invite
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.group_space_id = invite.group_space_id
         WHERE invite.invitation_ref = $1 AND invite.room_id = $2 AND invite.invitee_account_id = $3",
    )
    .bind(&invitation_ref)
    .bind(room_id)
    .bind(viewer)
    .fetch_optional(pool)
    .await;
    let (group_space_id, group_invitation_id, conversation_id, name, accepted) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return invitation_not_found(),
        Err(error) => return db_error(error),
    };
    let body = |status: &str| {
        Json(json!({
            "status": status,
            "groupSpaceId": group_space_id,
            "conversationId": conversation_id,
            "name": name,
        }))
    };
    if accepted {
        return (StatusCode::OK, body("already_joined")).into_response();
    }
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => return db_error(error),
    };
    let redeemed = redeem_group_invitation_by_id(
        &mut tx,
        &group_invitation_id,
        viewer,
        ROOM_GROUP_MIN_MEMBERS,
    )
    .await;
    let response = match redeemed {
        Redemption::Done(response) => response,
        Redemption::Failed(response) => return response,
    };
    let finished = async {
        query(
            "UPDATE cloud_common_ground_room_invitations SET accepted_at = now()
             WHERE invitation_ref = $1 AND accepted_at IS NULL",
        )
        .bind(&invitation_ref)
        .execute(&mut *tx)
        .await?;
        rooms::notify_members(&mut tx, room_id, &code).await?;
        tx.commit().await
    }
    .await;
    if let Err(error) = finished {
        return db_error(error);
    }
    if response.status == "joined" {
        audit_join(&state, &session, &group_invitation_id, &group_space_id).await;
        // A group started before System posted notices has only the System
        // agent.
        let posted = match crate::system_account::join(pool, conversation_id).await {
            Ok(_) => intro::post_joined(pool, SYSTEM_ACCOUNT_ID, room_id, conversation_id, viewer)
                .await
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = posted {
            eprintln!("[common-ground] Could not post a joined line: {error}");
        }
    }
    (StatusCode::OK, body(response.status)).into_response()
}
