//! Agent facts on comments: who an agent reply is from, and the state of
//! the run a mentioning comment started.

use std::collections::HashMap;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::access::{clean_display_name, syncable_avatar_url};
use super::super::model::{
    AgentRunState, AgentRunStatus, CommentAuthor, CommentKind, DocumentComment,
};
use super::super::Caller;

/// The run status clients see. A leased run is already someone's work, and
/// a stopped run did not answer.
pub(crate) fn agent_run_status(run_status: &str) -> Option<AgentRunStatus> {
    match run_status {
        "queued" => Some(AgentRunStatus::Queued),
        "leased" | "running" => Some(AgentRunStatus::Running),
        "completed" => Some(AgentRunStatus::Completed),
        "failed" | "cancelled" => Some(AgentRunStatus::Failed),
        _ => None,
    }
}

type AgentRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
);

/// Sets `kind`, the agent author, and `agentRun` on `comments`. With
/// `only`, reads just that comment. Public callers get the agent's name
/// but no avatar, agent id, or account id.
pub(crate) async fn annotate_comments(
    pool: &PgPool,
    attachment_id: &str,
    only: Option<&str>,
    comments: &mut [DocumentComment],
    caller: &Caller,
) -> Result<(), sqlx_core::Error> {
    if comments.is_empty() {
        return Ok(());
    }
    let rows: Vec<AgentRow> = query_as(
        "SELECT comment.comment_id, comment.author_agent_id, comment.author_agent_name, \
                (SELECT run.status FROM cloud_agent_fallback_runs run \
                  WHERE run.document_comment_id = comment.comment_id AND NOT run.legacy_duplicate \
                  ORDER BY run.created_at DESC LIMIT 1), \
                comment.author_agent_id IS NOT NULL AND EXISTS ( \
                  SELECT 1 FROM cloud_agent_fallback_runs reply \
                  WHERE reply.response_message_id = comment.comment_id \
                    AND reply.request_message_id LIKE 'doccmt:%' AND reply.status = 'failed'), \
                COALESCE(definition.owner_account_id, profile.owner_account_id), \
                COALESCE(definition.avatar_url, profile.avatar_url) \
         FROM cloud_document_comments comment \
         LEFT JOIN cloud_agent_definitions definition \
           ON definition.agent_id = comment.author_agent_id \
         LEFT JOIN cloud_default_agent_profiles profile \
           ON comment.author_agent_id = 'cloud-agent:' || profile.owner_account_id \
         WHERE comment.attachment_id = $1 AND comment.deleted_at IS NULL \
           AND ($2::text IS NULL OR comment.comment_id = $2) \
           AND (comment.author_agent_id IS NOT NULL OR EXISTS ( \
                 SELECT 1 FROM cloud_agent_fallback_runs run \
                 WHERE run.document_comment_id = comment.comment_id))",
    )
    .bind(attachment_id)
    .bind(only)
    .fetch_all(pool)
    .await?;
    let mut facts: HashMap<String, AgentRow> =
        rows.into_iter().map(|row| (row.0.clone(), row)).collect();
    for comment in comments {
        let Some((_, agent_id, agent_name, run_status, failed_reply, owner, avatar)) =
            facts.remove(&comment.comment_id)
        else {
            continue;
        };
        comment.agent_run = run_status
            .as_deref()
            .and_then(agent_run_status)
            .map(|status| AgentRunState { status });
        let Some(agent_id) = agent_id else { continue };
        comment.kind = if failed_reply {
            CommentKind::System
        } else {
            CommentKind::Agent
        };
        comment.mine = false;
        let signed_in = !caller.is_public();
        let owner = owner.or_else(|| agent_id.strip_prefix("cloud-agent:").map(str::to_string));
        comment.author = CommentAuthor {
            account_id: None,
            display_name: clean_display_name(agent_name.as_deref()),
            kordi_id: None,
            // A generated agent avatar is seeded with the owner's account id.
            avatar_url: avatar
                .as_deref()
                .filter(|_| signed_in)
                .and_then(syncable_avatar_url),
            agent_id: signed_in.then_some(agent_id),
            owner_account_id: owner.filter(|_| signed_in),
        };
    }
    Ok(())
}
