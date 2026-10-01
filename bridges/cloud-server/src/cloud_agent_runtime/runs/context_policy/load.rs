//! Loading a context policy from the database.

use std::collections::HashSet;

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{without_exempt, ContextPolicy, HistoryScope, RunPolicyInput, WindowRow};
use super::{REQUEST_ID_ROWS, WINDOW_ROWS};
use crate::cloud_agent_runtime::runs::RunResult;

impl ContextPolicy {
    /// The policy for a run: the requester's view of the run's conversation.
    pub(crate) async fn for_run(
        pool: &PgPool,
        session_id: &str,
        owner: &str,
        requester: &str,
        agent_id: &str,
        request_id: Option<&str>,
    ) -> RunResult<Self> {
        let Some((conversation_id, scope, exempt_kind)) = conversation(pool, session_id).await?
        else {
            return Ok(Self::unfiltered(owner, requester));
        };
        let excluded = if exempt_kind {
            HashSet::new()
        } else {
            opt_outs(pool, conversation_id, &[owner, requester]).await?
        };
        let scheduled = request_id
            .is_none_or(crate::cloud_agent_runtime::runs::delivery::is_scheduled_run_request_id);
        let needs_window = scope == HistoryScope::Mentions || !excluded.is_empty();
        let window = if needs_window {
            window(pool, conversation_id).await?
        } else {
            Vec::new()
        };
        let mut request = None;
        let mut request_ids = HashSet::new();
        if scope == HistoryScope::Mentions {
            if let Some(request_id) = request_id.filter(|_| !scheduled) {
                if let Some((logical, wire)) = crate::cloud_agent_runtime::runs::request_identity(
                    pool,
                    session_id,
                    request_id,
                    Some(requester),
                )
                .await?
                {
                    let body: Option<(serde_json::Value,)> = query_as(
                        "SELECT content FROM cloud_chat_messages WHERE message_id::text = $1",
                    )
                    .bind(&wire)
                    .fetch_optional(pool)
                    .await?;
                    let body = body
                        .map(|(content,)| crate::chat_sync::voice::body_for_agent(&content))
                        .unwrap_or_default();
                    request = Some((wire, logical, body));
                }
            }
            request_ids = earlier_requests(pool, session_id, owner, agent_id, requester).await?;
        }
        Ok(Self::build(
            RunPolicyInput {
                scope,
                excluded,
                owner,
                requester,
                agent_id,
                scheduled,
                request_ids,
                request,
            },
            &window,
        ))
    }

    /// A private read by a member's own assistant: no scope limit, and every
    /// other member's opt-out applies.
    pub(crate) async fn for_private_read(
        pool: &PgPool,
        conversation_id: Uuid,
        viewer: &str,
    ) -> RunResult<Self> {
        let kind: Option<(String,)> =
            query_as("SELECT kind FROM cloud_chat_conversations WHERE conversation_id = $1")
                .bind(conversation_id)
                .fetch_optional(pool)
                .await?;
        let mut policy = Self::unfiltered(viewer, viewer);
        if kind.is_some_and(|(kind,)| kind != "ai") {
            policy.excluded = opt_outs(pool, conversation_id, &[viewer]).await?;
        }
        Ok(policy)
    }

    fn unfiltered(owner: &str, requester: &str) -> Self {
        Self::build(
            RunPolicyInput {
                scope: HistoryScope::Recent,
                excluded: HashSet::new(),
                owner,
                requester,
                agent_id: "",
                scheduled: false,
                request_ids: HashSet::new(),
                request: None,
            },
            &[],
        )
    }
}

/// The run conversation: id, scope, and whether it is exempt from opt-outs
/// (an agent conversation).
async fn conversation(
    pool: &PgPool,
    session_id: &str,
) -> RunResult<Option<(Uuid, HistoryScope, bool)>> {
    let row: Option<(Uuid, String, Option<String>)> = query_as(
        "SELECT c.conversation_id, c.kind, p.history_scope
         FROM cloud_chat_conversations c
         LEFT JOIN cloud_chat_ai_policies p ON p.conversation_id = c.conversation_id
         WHERE c.legacy_session_id = $1 OR c.conversation_id = $2
         ORDER BY (c.legacy_session_id = $1) DESC NULLS LAST LIMIT 1",
    )
    .bind(session_id.trim())
    .bind(Uuid::parse_str(session_id.trim()).ok())
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, kind, scope)| {
        let scope = match (kind.as_str(), scope.as_deref()) {
            ("group", Some("recent")) => HistoryScope::Recent,
            ("group", _) => HistoryScope::Mentions,
            _ => HistoryScope::Recent,
        };
        (id, scope, kind == "ai")
    }))
}

async fn opt_outs(
    pool: &PgPool,
    conversation_id: Uuid,
    exempt: &[&str],
) -> RunResult<HashSet<String>> {
    let rows: Vec<(String,)> =
        query_as("SELECT account_id FROM cloud_chat_ai_opt_outs WHERE conversation_id = $1")
            .bind(conversation_id)
            .fetch_all(pool)
            .await?;
    Ok(without_exempt(
        rows.into_iter().map(|(account,)| account),
        exempt,
    ))
}

async fn window(pool: &PgPool, conversation_id: Uuid) -> RunResult<Vec<WindowRow>> {
    let mut rows: Vec<(String, String, String, String, Value)> = query_as(
        "SELECT message_id::text, client_message_id::text, sender_account_id, message_kind, content
         FROM cloud_chat_messages
         WHERE conversation_id = $1 AND deleted_at IS NULL
         ORDER BY conversation_sequence DESC LIMIT $2",
    )
    .bind(conversation_id)
    .bind(WINDOW_ROWS)
    .fetch_all(pool)
    .await?;
    rows.reverse();
    Ok(rows
        .into_iter()
        .map(|(wire, client, sender, kind, content)| {
            let body = crate::chat_sync::voice::body_for_agent(&content);
            (wire, client, sender, kind, body)
        })
        .collect())
}

/// The requester's earlier requests to this agent. Claim-time resolution
/// already bound these ids to the requester.
async fn earlier_requests(
    pool: &PgPool,
    session_id: &str,
    owner: &str,
    agent_id: &str,
    requester: &str,
) -> RunResult<HashSet<String>> {
    let rows: Vec<(String,)> = query_as(
        "SELECT request_message_id FROM cloud_agent_fallback_runs
         WHERE session_id = $1 AND owner_account_id = $2 AND execution_agent_id = $3
           AND requester_account_id = $4 AND subsession_id IS NULL AND NOT legacy_duplicate
         ORDER BY created_at DESC LIMIT $5",
    )
    .bind(session_id)
    .bind(owner)
    .bind(agent_id)
    .bind(requester)
    .bind(REQUEST_ID_ROWS)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Whether a run for (owner, requester) in this session reads a mention-only
/// group, and whether some member's messages are left out of it.
pub(crate) async fn needs_filtered_context(
    pool: &PgPool,
    session_id: &str,
    owner: &str,
    requester: &str,
) -> RunResult<(bool, bool)> {
    let Some((conversation_id, scope, exempt_kind)) = conversation(pool, session_id).await? else {
        return Ok((false, false));
    };
    let excluded = !exempt_kind
        && !opt_outs(pool, conversation_id, &[owner, requester])
            .await?
            .is_empty();
    Ok((scope == HistoryScope::Mentions, excluded))
}
