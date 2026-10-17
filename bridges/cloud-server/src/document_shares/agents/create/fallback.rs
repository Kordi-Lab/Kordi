//! Posts documents that no reply took, as the agent's own message.
//!
//! A run that failed, was stopped, or answered without text has no reply to
//! carry its documents; neither has a background task whose follow-up never
//! came. After a grace period such documents are posted in their group by
//! the agent, so a document is never lost. This is a fallback only: every
//! reply path attaches documents itself.

use std::collections::BTreeMap;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::group_message::{post, DocumentMessage};
use super::reply::{mark_attached, RunDocument};

/// Minutes after a run ended before its untaken documents are posted.
pub(crate) const REPLY_GRACE_MINUTES: i32 = 2;
/// Minutes a background task's document waits for the follow-up reply.
pub(crate) const FOLLOW_UP_GRACE_MINUTES: i32 = 30;
const SWEEP_LIMIT: i64 = 100;

type PendingRow = (String, String, String, String, String, String, String, i64);

/// Posts every due document; returns how many fallback messages were sent.
pub(crate) async fn post_unattached(pool: &PgPool) -> Result<usize, sqlx_core::Error> {
    let rows: Vec<PendingRow> = query_as(
        "SELECT document.run_id, document.session_id, document.owner_account_id, \
                document.agent_id, document.attachment_id, document.file_name, \
                document.content_type, document.size_bytes \
         FROM cloud_agent_run_documents document \
         JOIN cloud_agent_fallback_runs run ON run.run_id = document.run_id \
         WHERE document.attached_at IS NULL \
           AND run.status IN ('completed', 'failed', 'cancelled') \
           AND ((NOT document.after_reply \
                 AND COALESCE(run.completed_at, run.updated_at)::timestamptz \
                     < now() - make_interval(mins => $1)) \
             OR (document.after_reply \
                 AND document.created_at < now() - make_interval(mins => $2))) \
         ORDER BY document.created_at, document.attachment_id LIMIT $3",
    )
    .bind(REPLY_GRACE_MINUTES)
    .bind(FOLLOW_UP_GRACE_MINUTES)
    .bind(SWEEP_LIMIT)
    .fetch_all(pool)
    .await?;
    let mut by_run: BTreeMap<(String, String, String, String), Vec<RunDocument>> = BTreeMap::new();
    for (run_id, session_id, owner, agent_id, attachment_id, file_name, content_type, size) in rows
    {
        by_run
            .entry((run_id, session_id, owner, agent_id))
            .or_default()
            .push(RunDocument {
                attachment_id,
                file_name,
                content_type,
                size_bytes: size,
            });
    }
    let mut posted = 0;
    for ((run_id, session_id, owner, agent_id), documents) in by_run {
        let conversation: Option<(Uuid,)> = query_as(
            "SELECT conversation_id FROM cloud_chat_conversations \
             WHERE legacy_session_id = $1 AND kind = 'group'",
        )
        .bind(&session_id)
        .fetch_optional(pool)
        .await?;
        if let Some((conversation_id,)) = conversation {
            let message = DocumentMessage {
                conversation_id,
                run_id: &run_id,
                session_id: &session_id,
                owner_account_id: &owner,
                agent_id: &agent_id,
                documents: &documents,
            };
            if post(pool, message).await?.is_some() {
                posted += 1;
            }
        }
        // Posted, or with nowhere to go: either way it is settled.
        let mut conn = pool.acquire().await?;
        mark_attached(&mut conn, &documents).await?;
    }
    Ok(posted)
}
