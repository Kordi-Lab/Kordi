//! Personal sessions: one `kind = 'ai'` conversation per owned agent (the
//! default agent and every active definition), with the owner as its only
//! member. An agent is a personal agent while its Proactive setting is on;
//! then its session is listed, marked, and cannot be hidden or deleted.
//! While it is off the session is an ordinary agent chat and keeps its
//! binding. A message there without a target goes to its agent either way.

use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::activation::activate_in_transaction;
use crate::chat_sync::store::StoreError;
use crate::proactive::agents::default_agent_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalSession {
    pub agent_id: String,
    pub conversation_id: Uuid,
    /// The conversation's legacy session id.
    pub session_id: String,
}

/// The owner's personal agents, the agents whose Proactive setting is on, in
/// list order: the default agent first, then active definitions by creation
/// time.
pub(crate) async fn personal_agents(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Vec<String>, sqlx_core::Error> {
    let default_agent = default_agent_id(owner_account_id);
    let rows: Vec<(String,)> = query_as(concat!(
        "SELECT agent.agent_id FROM (
             SELECT $2::text AS agent_id, $1::text AS owner_account_id, '' AS created_at, 0 AS rank
             UNION ALL
             SELECT agent_id, owner_account_id, created_at, 1 FROM cloud_agent_definitions
             WHERE owner_account_id = $1 AND status = 'active' AND is_system_managed = FALSE
         ) agent
         WHERE ",
        super::setting::effective_on_sql!("agent.agent_id", "agent.owner_account_id"),
        " ORDER BY agent.rank, agent.created_at ASC, agent.agent_id ASC"
    ))
    .bind(owner_account_id)
    .bind(&default_agent)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(agent_id,)| agent_id).collect())
}

/// The agent's bound personal session.
pub(crate) async fn bound(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Option<PersonalSession>, sqlx_core::Error> {
    let row: Option<(Uuid, String)> = query_as(
        "SELECT binding.conversation_id, conversation.legacy_session_id
         FROM cloud_personal_agent_sessions binding
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = binding.conversation_id
         WHERE binding.agent_id = $1 AND binding.owner_account_id = $2
           AND conversation.legacy_session_id IS NOT NULL",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(conversation_id, session_id)| PersonalSession {
        agent_id: agent_id.to_string(),
        conversation_id,
        session_id,
    }))
}

/// Returns the agent's personal session, made ready by
/// [`activate_in_transaction`] unless the bound one is in use as it is.
pub(crate) async fn ensure(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<PersonalSession, StoreError> {
    if let Some(found) = bound(pool, owner_account_id, agent_id).await? {
        let (visible,): (bool,) = query_as(
            "SELECT NOT EXISTS(SELECT 1 FROM cloud_account_session_visibility
                 WHERE account_id = $1 AND session_id = ANY($2)
                   AND (hidden_at IS NOT NULL OR deleted_at IS NOT NULL))",
        )
        .bind(owner_account_id)
        .bind(vec![
            found.session_id.clone(),
            found.conversation_id.to_string(),
        ])
        .fetch_one(pool)
        .await?;
        if visible {
            return Ok(found);
        }
    }
    let mut transaction = pool.begin().await?;
    let (session, _) =
        activate_in_transaction(&mut transaction, owner_account_id, agent_id).await?;
    transaction.commit().await?;
    Ok(session)
}

/// Whether `conversation_id` is a personal session now: bound to an agent
/// whose Proactive setting is on. Such a session cannot be hidden or
/// deleted; while the setting is off it is an ordinary agent chat.
pub(crate) async fn locked(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let (locked,): (bool,) = query_as(concat!(
        "SELECT EXISTS(SELECT 1 FROM cloud_personal_agent_sessions binding
         WHERE binding.conversation_id = $1 AND ",
        super::setting::effective_on_sql!("binding.agent_id", "binding.owner_account_id"),
        ")"
    ))
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(locked)
}

/// The definition a request in `session_id` goes to when it names no target:
/// the session's agent, for the owner's own request in the personal session
/// of an active definition. `None` for every other session, and for the
/// default agent's session, whose requests already go to the default agent.
pub(crate) async fn default_target(
    pool: &PgPool,
    session_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    if owner_account_id != requester_account_id {
        return Ok(None);
    }
    let row: Option<(String,)> = query_as(
        "SELECT binding.agent_id
         FROM cloud_personal_agent_sessions binding
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = binding.conversation_id
         JOIN cloud_agent_definitions agent
           ON agent.agent_id = binding.agent_id AND agent.owner_account_id = binding.owner_account_id
         WHERE conversation.legacy_session_id = $1 AND binding.owner_account_id = $2
           AND agent.status = 'active' AND agent.is_system_managed = FALSE",
    )
    .bind(session_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(agent_id,)| agent_id))
}
