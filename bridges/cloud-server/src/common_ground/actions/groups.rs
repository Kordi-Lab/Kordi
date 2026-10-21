//! Start group: a group chat from a room, with the creator's contacts added
//! and everyone else invited.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use uuid::Uuid;

use super::people_by_id;
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::routes::{create_invitation_in_transaction, CloudSession, ROOM_GROUP_MIN_MEMBERS};
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};
use crate::common_ground::{db_error, err, limited, rooms, GROUP_LIMIT};
use crate::server::ServerState;

const MAX_NAME_CHARS: usize = 80;
const MAX_MEMBERS: usize = 50;
const DEFAULT_NAME: &str = "Common ground group";

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct GroupRequest {
    name: Option<String>,
    member_ids: Vec<String>,
    /// The room topic the group is for, shown with the group.
    topic: Option<String>,
}

fn bad_request(message: &str) -> Response {
    err(
        "common_ground_invalid_group",
        message,
        StatusCode::BAD_REQUEST,
    )
}

fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// What the transaction made.
struct Created {
    group_space_id: String,
    conversation_id: Uuid,
    added: Vec<String>,
    invited: Vec<String>,
}

/// `POST /v1/cloud/common-ground/rooms/:code/group`: starts a group with
/// people in this room, optionally for one of its topics. Members of a
/// closed room may still start one with the people who have not left.
pub(in crate::common_ground) async fn start_group(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(code): Path<String>,
    body: Option<Json<GroupRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let room_id = match rooms::my_room(pool, &code, viewer).await {
        Ok(Some((room_id, _))) => room_id,
        Ok(None) => return rooms::room_not_found(),
        Err(error) => return db_error(error),
    };
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let ids: BTreeSet<String> = body
        .member_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() || ids.len() > MAX_MEMBERS {
        return bad_request("Pick between 1 and 50 people.");
    }
    let ids: Vec<String> = ids.into_iter().collect();
    let in_room: Result<(i64,), _> = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_room_members
         WHERE room_id = $1 AND account_id = ANY($2) AND account_id <> $3 AND left_at IS NULL",
    )
    .bind(room_id)
    .bind(&ids)
    .bind(viewer)
    .fetch_one(pool)
    .await;
    match in_room {
        Ok((count,)) if count == ids.len() as i64 => {}
        Ok(_) => return bad_request("Pick people in this room."),
        Err(error) => return db_error(error),
    }
    let room_name: Result<(String,), _> =
        query_as("SELECT name FROM cloud_common_ground_rooms WHERE room_id = $1")
            .bind(room_id)
            .fetch_one(pool)
            .await;
    let room_name = match room_name {
        Ok((name,)) => collapse(&name),
        Err(error) => return db_error(error),
    };
    let name = collapse(body.name.as_deref().unwrap_or_default());
    if name.chars().count() > MAX_NAME_CHARS {
        return bad_request("Use a shorter name.");
    }
    let topic = collapse(body.topic.as_deref().unwrap_or_default());
    if topic.chars().count() > MAX_NAME_CHARS {
        return bad_request("Use a shorter topic.");
    }
    let topic = (!topic.is_empty()).then_some(topic);
    let name = [name, room_name]
        .into_iter()
        .find(|n| !n.is_empty())
        .unwrap_or_else(|| DEFAULT_NAME.to_string());
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(GROUP_LIMIT, viewer)
        .await
    {
        return limited(retry_after);
    }

    let group = NewGroup {
        room_id,
        code: &code,
        viewer,
        name: &name,
        topic: topic.as_deref(),
        ids: &ids,
    };
    let created = match create(pool, group).await {
        Ok(created) => created,
        Err(response) => return *response,
    };
    // A group started here gets PiP like any other new group.
    if let Some(pip) = state.pip() {
        if let Err(error) = crate::pip::membership::join_conversation(
            pool,
            &pip.config().account_id,
            created.conversation_id,
        )
        .await
        {
            eprintln!("[pip] Could not join a new conversation: {error}");
        }
    }
    let people = match people_by_id(pool, &ids).await {
        Ok(people) => people,
        Err(error) => return db_error(error),
    };
    let list = |ids: &[String]| -> Vec<Value> {
        ids.iter()
            .filter_map(|id| people.get(id).cloned())
            .collect()
    };
    (
        StatusCode::CREATED,
        Json(json!({
            "group": {
                "groupSpaceId": created.group_space_id,
                "conversationId": created.conversation_id,
                "name": name,
                "topic": topic,
                "memberCount": 1 + created.added.len(),
            },
            "added": list(&created.added),
            "invited": list(&created.invited),
        })),
    )
        .into_response()
}

fn failed(error: impl std::fmt::Display) -> Box<Response> {
    eprintln!("[common-ground] Could not start a group: {error}");
    Box::new(err(
        "common_ground_failed",
        "Could not start the group. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    ))
}

/// What to create.
struct NewGroup<'a> {
    room_id: Uuid,
    code: &'a str,
    viewer: &'a str,
    name: &'a str,
    topic: Option<&'a str>,
    ids: &'a [String],
}

/// Creates the group, its invitation and the room's records in one
/// transaction.
async fn create(
    pool: &sqlx_postgres::PgPool,
    group: NewGroup<'_>,
) -> Result<Created, Box<Response>> {
    let NewGroup {
        room_id,
        code,
        viewer,
        name,
        topic,
        ids,
    } = group;
    let mut tx = pool.begin().await.map_err(failed)?;
    let contacts: Vec<(String,)> = query_as(
        "SELECT peer_account_id FROM cloud_contacts
         WHERE account_id = $1 AND peer_account_id = ANY($2)",
    )
    .bind(viewer)
    .bind(ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(failed)?;
    let contacts: BTreeSet<String> = contacts.into_iter().map(|(id,)| id).collect();
    let (added, invited): (Vec<String>, Vec<String>) =
        ids.iter().cloned().partition(|id| contacts.contains(id));
    let group_space_id = format!("session:group:{}", Uuid::new_v4());
    let conversation = crate::chat_sync::store::create_room_group_in_transaction(
        &mut tx,
        viewer,
        CreateConversationRequest {
            client_operation_id: Uuid::new_v4(),
            kind: ConversationKind::Group,
            shared_title: None,
            client_session_id: group_space_id.clone(),
            member_account_ids: added.clone(),
        },
        name,
    )
    .await
    .map_err(failed)?
    .value;
    query(
        "INSERT INTO cloud_common_ground_room_groups
             (group_space_id, room_id, conversation_id, name, created_by, topic)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&group_space_id)
    .bind(room_id)
    .bind(conversation.id)
    .bind(name)
    .bind(viewer)
    .bind(topic)
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    if !invited.is_empty() {
        let invitation = create_invitation_in_transaction(
            &mut tx,
            viewer,
            &group_space_id,
            &group_space_id,
            name,
            ROOM_GROUP_MIN_MEMBERS,
        )
        .await
        .map_err(failed)?
        .ok_or_else(|| failed("the new group could not invite"))?;
        for invitee in &invited {
            query(
                "INSERT INTO cloud_common_ground_room_invitations
                     (invitation_ref, room_id, group_space_id, group_invitation_id,
                      inviter_account_id, invitee_account_id)
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(format!("cgi_{}", Uuid::new_v4().simple()))
            .bind(room_id)
            .bind(&group_space_id)
            .bind(&invitation.invitation_id)
            .bind(viewer)
            .bind(invitee)
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
        }
    }
    rooms::notify_members(&mut tx, room_id, code)
        .await
        .map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(Created {
        group_space_id,
        conversation_id: conversation.id,
        added,
        invited,
    })
}
