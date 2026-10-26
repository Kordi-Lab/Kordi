//! Marks the personal session of an owned agent
//! (docs/development/personal-agent.md), so clients list it under Personal
//! agent. Its row in `cloud_personal_agent_sessions` names the agent; the
//! conversation snapshot carries it as `personal_agent` while the agent's
//! Proactive setting is on.

use std::collections::HashMap;

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::StoreError;
use crate::chat_sync::models::PersonalAgentRef;

const SELF_AGENT_PREFIX: &str = "session:self-agent:";
const PERSONAL_MARKER: &str = ":personal:";

/// The session id of `agent_id`'s personal session with `account_id`.
pub(crate) fn personal_session_id(account_id: &str, agent_id: &str) -> String {
    format!("{SELF_AGENT_PREFIX}{account_id}{PERSONAL_MARKER}{agent_id}")
}

/// Whether `session_id` has the shape of a personal session id, which only
/// the server may create.
pub(super) fn is_personal_session_id(session_id: &str) -> bool {
    session_id
        .strip_prefix(SELF_AGENT_PREFIX)
        .is_some_and(|rest| rest.contains(PERSONAL_MARKER))
}

/// Binds `conversation_id` as `agent_id`'s personal session. An agent that
/// already has one keeps it.
pub(super) async fn bind(
    transaction: &mut Transaction<'_, Postgres>,
    agent_id: &str,
    owner_account_id: &str,
    conversation_id: Uuid,
) -> Result<(), StoreError> {
    query(
        "INSERT INTO cloud_personal_agent_sessions (agent_id, owner_account_id, conversation_id) \
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .bind(conversation_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Drops `agent_id`'s personal session binding. The conversation stays as an
/// ordinary agent chat: its version moves and every member's devices get a
/// `conversation.updated` without `personal_agent`.
pub(crate) async fn unbind_personal_session(
    transaction: &mut Transaction<'_, Postgres>,
    agent_id: &str,
) -> Result<(), StoreError> {
    let unbound: Vec<(Uuid,)> = query_as(
        "DELETE FROM cloud_personal_agent_sessions WHERE agent_id = $1 RETURNING conversation_id",
    )
    .bind(agent_id)
    .fetch_all(&mut **transaction)
    .await?;
    for (conversation_id,) in unbound {
        announce(transaction, conversation_id).await?;
    }
    Ok(())
}

/// Tells the members of `agent_id`'s bound personal session that its
/// `personal_agent` marker changed: the agent's Proactive setting was turned
/// on or off in this transaction.
pub(crate) async fn announce_personal_session(
    transaction: &mut Transaction<'_, Postgres>,
    agent_id: &str,
) -> Result<(), StoreError> {
    let bound: Option<(Uuid,)> =
        query_as("SELECT conversation_id FROM cloud_personal_agent_sessions WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_optional(&mut **transaction)
            .await?;
    match bound {
        Some((conversation_id,)) => announce(transaction, conversation_id).await,
        None => Ok(()),
    }
}

/// Moves the conversation's version and sends every member's devices a
/// `conversation.updated` with the current snapshot.
async fn announce(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<(), StoreError> {
    let (version,): (i32,) = query_as(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now() \
         WHERE conversation_id = $1 RETURNING version",
    )
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?;
    let payloads =
        super::support::load_active_conversation_projections(transaction, conversation_id)
            .await?
            .into_iter()
            .map(|(account, conversation)| (account, json!({ "conversation": conversation })))
            .collect();
    super::sync_events::insert_sync_event_fanout(
        transaction,
        "conversation.updated",
        Some(conversation_id),
        Some(conversation_id),
        Some(version),
        payloads,
    )
    .await
}

/// The agent of each personal session among `conversation_ids`: bound, with
/// the agent's Proactive setting on.
pub(super) async fn personal_agent_ids(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, StoreError> {
    if conversation_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, String)> = query_as(concat!(
        "SELECT binding.conversation_id, binding.agent_id \
         FROM cloud_personal_agent_sessions binding \
         WHERE binding.conversation_id = ANY($1) AND ",
        crate::personal_agent::setting::effective_on_sql!(
            "binding.agent_id",
            "binding.owner_account_id"
        )
    ))
    .bind(conversation_ids)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().collect())
}

/// `personal_agent` for one conversation.
pub(super) async fn conversation_personal_agent(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Option<PersonalAgentRef>, StoreError> {
    let agents = personal_agent_ids(transaction, &[conversation_id]).await?;
    Ok(personal_agent_for(&agents, conversation_id))
}

/// `personal_agent` for a conversation given the agents found for a batch.
pub(super) fn personal_agent_for(
    agents: &HashMap<Uuid, String>,
    conversation_id: Uuid,
) -> Option<PersonalAgentRef> {
    agents
        .get(&conversation_id)
        .map(|agent_id| PersonalAgentRef {
            agent_id: agent_id.clone(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_session_ids_are_recognized() {
        let id = personal_session_id("acct_1", "cloud-agent:acct_1");
        assert_eq!(id, "session:self-agent:acct_1:personal:cloud-agent:acct_1");
        assert!(is_personal_session_id(&id));
        assert!(is_personal_session_id(&personal_session_id(
            "acct_1",
            "cloud_agent_x"
        )));
        assert!(!is_personal_session_id("session:self-agent:acct_1:default"));
        assert!(!is_personal_session_id("session:group:personal:x"));
    }
}
