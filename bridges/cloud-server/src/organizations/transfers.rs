//! Moving content between organizations. The caller must be an owner or
//! admin of both, and the content owner must belong to the target (the 0168
//! trigger checks this too). A group moves with all its channels, and moved
//! conversations are announced to their members so clients update the
//! organization label.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::handlers::{lock_for_change, Tx};
use super::policy::{manages_content, PolicyError};
use super::selection::is_member_owner_violation;
use super::{bad_request, err, server_error, ApiError};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferRequest {
    kind: String,
    id: String,
    target_organization_id: String,
}

/// The table and id column of each kind of content that can move.
fn content_table(kind: &str) -> Option<(&'static str, &'static str)> {
    match kind {
        "conversation" => Some(("cloud_chat_conversations", "conversation_id::text")),
        "agent" => Some(("cloud_agent_definitions", "agent_id")),
        "scheduledTask" => Some(("scheduled_tool_tasks", "task_id")),
        _ => None,
    }
}

fn content_not_found() -> ApiError {
    err(
        "content_not_found",
        "Content not found in this organization.",
        StatusCode::NOT_FOUND,
    )
}

fn owner_not_member() -> ApiError {
    err(
        "owner_not_member",
        "The content owner is not a member of that organization.",
        StatusCode::CONFLICT,
    )
}

/// Locks both organizations in id order, so two opposite transfers cannot
/// deadlock, and requires the caller to manage each.
async fn lock_managed(
    tx: &mut Tx<'_>,
    account_id: &str,
    source: &str,
    target: &str,
) -> Result<(), ApiError> {
    let (first, second) = if source <= target {
        (source, target)
    } else {
        (target, source)
    };
    for organization_id in [first, second] {
        let (_, role, _) = lock_for_change(tx, organization_id, account_id).await?;
        if !manages_content(role) {
            return Err(PolicyError::NotManager.into());
        }
    }
    Ok(())
}

fn move_error(error: sqlx_core::Error) -> ApiError {
    if is_member_owner_violation(&error) {
        owner_not_member()
    } else {
        server_error()
    }
}

/// Moves a conversation with the rest of its group: every conversation of a
/// group space moves together, so a group and its channels never split. An
/// AI chat moves alone; a direct chat stays with its two people. Attachments
/// in the moved conversations follow when their owner belongs to `target`.
async fn move_conversations(
    tx: &mut Tx<'_>,
    id: &str,
    source: &str,
    target: &str,
) -> Result<(), ApiError> {
    let found: Option<(String, String)> = query_as(
        "SELECT kind, cloud_conversation_space(group_space_id, legacy_session_id, conversation_id) \
         FROM cloud_chat_conversations WHERE conversation_id::text = $1 AND organization_id = $2",
    )
    .bind(id)
    .bind(source)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    let (kind, space) = found.ok_or_else(content_not_found)?;
    if kind == "direct" {
        return Err(err(
            "direct_conversation",
            "A direct chat stays with its people.",
            StatusCode::CONFLICT,
        ));
    }
    let moved: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_chat_conversations SET organization_id = $1 \
         WHERE organization_id = $2 AND (conversation_id::text = $3 OR (kind = 'group' \
           AND $4 = 'group' \
           AND cloud_conversation_space(group_space_id, legacy_session_id, conversation_id) = $5)) \
         RETURNING conversation_id",
    )
    .bind(target)
    .bind(source)
    .bind(id)
    .bind(&kind)
    .bind(&space)
    .fetch_all(&mut **tx)
    .await
    .map_err(move_error)?;
    let ids: Vec<Uuid> = moved.into_iter().map(|(id,)| id).collect();
    query(
        "UPDATE cloud_attachments a SET organization_id = $1 \
         FROM cloud_chat_message_attachments link \
         JOIN cloud_chat_messages message ON message.message_id = link.message_id \
         WHERE link.attachment_id = a.attachment_id AND message.conversation_id = ANY($3) \
           AND a.organization_id = $2 AND cloud_is_organization_member($1, a.owner_account_id)",
    )
    .bind(target)
    .bind(source)
    .bind(&ids)
    .execute(&mut **tx)
    .await
    .map_err(move_error)?;
    for conversation_id in ids {
        crate::chat_sync::store::announce_conversation_change(tx, conversation_id)
            .await
            .map_err(|_| server_error())?;
    }
    Ok(())
}

pub(super) async fn transfer(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Json(request): Json<TransferRequest>,
) -> Response {
    let result: Result<(), ApiError> = async {
        let (table, id_column) = content_table(&request.kind).ok_or_else(|| {
            bad_request(
                "invalid_kind",
                "kind must be conversation, agent, or scheduledTask.",
            )
        })?;
        let target = request.target_organization_id.trim();
        if target == organization_id {
            return Err(bad_request(
                "same_organization",
                "The content is already in that organization.",
            ));
        }
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        lock_managed(&mut tx, &session.account_id, &organization_id, target).await?;
        if request.kind == "conversation" {
            move_conversations(&mut tx, request.id.trim(), &organization_id, target).await?;
        } else {
            let sql = format!(
                "UPDATE {table} SET organization_id = $1 \
                 WHERE {id_column} = $2 AND organization_id = $3"
            );
            let moved = query(&sql)
                .bind(target)
                .bind(request.id.trim())
                .bind(&organization_id)
                .execute(&mut *tx)
                .await
                .map_err(move_error)?;
            if moved.rows_affected() == 0 {
                return Err(content_not_found());
            }
        }
        tx.commit().await.map_err(|_| server_error())?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Json(json!({
            "kind": request.kind,
            "id": request.id.trim(),
            "organizationId": request.target_organization_id.trim(),
        }))
        .into_response(),
        Err(error) => error.into_response(),
    }
}
