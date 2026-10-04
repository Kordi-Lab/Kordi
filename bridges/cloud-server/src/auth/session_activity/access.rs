//! Who may record and read task and artifact activity in a session.
//!
//! Activity belongs to the session's conversation. Recording it needs active
//! membership there and the consent a chat message needs: in a direct or AI
//! chat, every other person must still be the writer's contact. Only the
//! account that recorded a row can change it. Reading needs active membership
//! too, and leaves out rows recorded by anyone in a block with the reader.
//! A session without a conversation (a fork before its first message, for
//! example) shows the reader only the rows they recorded, plus the rows
//! copied into a fork they made. A fork row counts only for the account that
//! created the conversation: when another account registered the chat's id as
//! a fork (the fork route no longer allows it), members see only the rows
//! that members recorded, never the rows that fork copied in. Artifacts whose
//! file is queued for deletion are never listed.

use axum::http::StatusCode;
use axum::response::Response;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{err, ArtifactRow, TaskRow};

/// Whether `session_id` names a conversation, and whether `account_id` is an
/// active member of it.
async fn membership(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<(bool, Option<Uuid>), sqlx_core::Error> {
    query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversations conversation \
                        WHERE conversation.legacy_session_id = $1 \
                           OR conversation.conversation_id = $3), \
                (SELECT conversation.conversation_id \
                 FROM cloud_chat_conversations conversation \
                 JOIN cloud_chat_conversation_members member \
                   ON member.conversation_id = conversation.conversation_id \
                 WHERE (conversation.legacy_session_id = $1 OR conversation.conversation_id = $3) \
                   AND member.account_id = $2 AND member.membership_state = 'active' \
                 ORDER BY conversation.conversation_id LIMIT 1)",
    )
    .bind(session_id)
    .bind(account_id)
    .bind(Uuid::parse_str(session_id).ok())
    .fetch_one(pool)
    .await
}

fn server_error() -> Response {
    err(
        "server_error",
        "Could not check access to session activity.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn not_participant() -> Response {
    err(
        "not_a_participant",
        "You can only use activity in conversations you take part in.",
        StatusCode::FORBIDDEN,
    )
}

/// Refuses a writer who is not an active member of the session's
/// conversation, or who may no longer write in it (a direct or AI chat with
/// someone who is not, or is no longer, their contact). Every route that adds
/// rows to a session's activity applies it, the digest's task creation too.
pub(crate) async fn require_writer(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<(), Response> {
    let Some(conversation_id) = membership(pool, account_id, session_id)
        .await
        .map_err(|_| server_error())?
        .1
    else {
        return Err(not_participant());
    };
    match crate::relationships::may_write_outside_groups(pool, conversation_id, account_id).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(err(
            "CHAT_RELATIONSHIP_REQUIRED",
            crate::chat_sync::store::DIRECT_REQUIRES_CONTACT,
            StatusCode::FORBIDDEN,
        )),
        Err(_) => Err(server_error()),
    }
}

/// Answers a write that met a row another account recorded under the same id.
pub(super) fn recorded_by_someone_else() -> Response {
    err(
        "session_activity_conflict",
        "Someone else already recorded this activity.",
        StatusCode::CONFLICT,
    )
}

/// The rows of a session the reader may see, oldest first.
pub(super) async fn visible_rows(
    pool: &PgPool,
    reader: &str,
    session_id: &str,
) -> Result<(Vec<TaskRow>, Vec<ArtifactRow>), Response> {
    let (conversation_exists, member_of) = membership(pool, reader, session_id)
        .await
        .map_err(|_| server_error())?;
    if conversation_exists && member_of.is_none() {
        return Err(not_participant());
    }
    let every_row = member_of.is_some()
        || query_as::<_, (bool,)>(
            "SELECT EXISTS (SELECT 1 FROM cloud_session_forks \
                            WHERE fork_session_id = $1 AND created_by_account_id = $2)",
        )
        .bind(session_id)
        .bind(reader)
        .fetch_one(pool)
        .await
        .map_err(|_| server_error())?
        .0;
    let members_only = match member_of {
        Some(conversation_id) => {
            query_as::<_, (bool,)>(
                "SELECT EXISTS (SELECT 1 FROM cloud_session_forks fork \
                                JOIN cloud_chat_conversations conversation \
                                  ON conversation.conversation_id = $2 \
                                WHERE fork.fork_session_id = $1 \
                                  AND fork.created_by_account_id <> conversation.created_by_account_id)",
            )
            .bind(session_id)
            .bind(conversation_id)
            .fetch_one(pool)
            .await
            .map_err(|_| server_error())?
            .0
        }
        None => false,
    };
    let visible = "session_id = $1 AND archived_at IS NULL \
                   AND ($3 OR created_by_account_id = $2) \
                   AND (NOT $4 OR created_by_account_id IN ( \
                        SELECT member.account_id FROM cloud_chat_conversation_members member \
                        WHERE member.conversation_id = $5)) \
                   AND NOT cloud_accounts_blocked_either_way($2, created_by_account_id)";
    let tasks: Vec<TaskRow> = query_as(&format!(
        "SELECT task_activity_id, session_id, task_id, title, summary, status, \
                created_by_account_id, target_account_id, participants_json, artifact_ids_json, \
                response_message_id, created_at, updated_at, archived_at \
         FROM cloud_session_tasks WHERE {visible} ORDER BY updated_at ASC, task_id ASC"
    ))
    .bind(session_id)
    .bind(reader)
    .bind(every_row)
    .bind(members_only)
    .bind(member_of)
    .fetch_all(pool)
    .await
    .map_err(|_| server_error())?;
    let artifacts: Vec<ArtifactRow> = query_as(&format!(
        "SELECT artifact_activity_id, session_id, artifact_id, name, path, kind, category, \
                summary, created_by_account_id, source_message_id, attachment_id, content_type, \
                size_bytes, created_at, updated_at, archived_at \
         FROM cloud_session_artifacts artifact WHERE {visible} \
           AND NOT EXISTS (SELECT 1 FROM cloud_attachments attachment \
                           WHERE attachment.attachment_id = artifact.attachment_id \
                             AND attachment.purge_requested_at IS NOT NULL) \
         ORDER BY updated_at ASC, artifact_id ASC"
    ))
    .bind(session_id)
    .bind(reader)
    .bind(every_row)
    .bind(members_only)
    .bind(member_of)
    .fetch_all(pool)
    .await
    .map_err(|_| server_error())?;
    Ok((tasks, artifacts))
}
