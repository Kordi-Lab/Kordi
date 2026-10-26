//! Personal sessions: one `kind = 'ai'` conversation per owned agent (the
//! default agent and every active definition), with the owner as its only
//! member. The server creates them on demand; clients never archive or
//! delete them, and a message there without a target goes to its agent.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};
use crate::chat_sync::store::{self, StoreError};
use crate::proactive::agents::default_agent_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersonalSession {
    pub agent_id: String,
    pub conversation_id: Uuid,
    /// The conversation's legacy session id.
    pub session_id: String,
}

/// The owner's agents in list order: the default agent first, then active
/// definitions by creation time.
pub(crate) async fn owned_agents(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Vec<String>, sqlx_core::Error> {
    let rows: Vec<(String,)> = query_as(
        "SELECT agent_id FROM cloud_agent_definitions
         WHERE owner_account_id = $1 AND status = 'active' AND is_system_managed = FALSE
         ORDER BY created_at ASC, agent_id ASC",
    )
    .bind(owner_account_id)
    .fetch_all(pool)
    .await?;
    let mut agents = vec![default_agent_id(owner_account_id)];
    agents.extend(rows.into_iter().map(|(agent_id,)| agent_id));
    Ok(agents)
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

/// Returns the agent's personal session, creating and binding it first when
/// it has none and the agent is the default agent or an active definition.
/// Racing calls get one conversation: creation takes the session id's lock
/// and uses an operation id derived from the session id.
pub(crate) async fn ensure(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<PersonalSession, StoreError> {
    if let Some(found) = bound(pool, owner_account_id, agent_id).await? {
        return Ok(found);
    }
    let session_id = store::personal_session_id(owner_account_id, agent_id);
    let request = CreateConversationRequest {
        client_operation_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, session_id.as_bytes()),
        kind: ConversationKind::Ai,
        shared_title: None,
        client_session_id: session_id,
        member_account_ids: vec![owner_account_id.to_string()],
    };
    let mut transaction = pool.begin().await?;
    // A definition must still be active when it is bound. The lock holds an
    // archive until this commits; the archive then unbinds the session.
    if crate::proactive::agents::default_owner(agent_id).is_none() {
        let active: Option<(String,)> = query_as(
            "SELECT agent_id FROM cloud_agent_definitions
             WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'
               AND is_system_managed = FALSE
             FOR SHARE",
        )
        .bind(agent_id)
        .bind(owner_account_id)
        .fetch_optional(&mut *transaction)
        .await?;
        if active.is_none() {
            return Err(StoreError::NotFound);
        }
    }
    let outcome = store::create_personal_session_in_transaction(
        &mut transaction,
        owner_account_id,
        request,
        agent_id,
    )
    .await?;
    // A conversation that already existed is bound here.
    query(
        "INSERT INTO cloud_personal_agent_sessions (agent_id, owner_account_id, conversation_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .bind(outcome.value.id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    bound(pool, owner_account_id, agent_id)
        .await?
        .ok_or(StoreError::NotFound)
}

/// Whether `conversation_id` is a personal session, which cannot be hidden
/// or deleted.
pub(crate) async fn locked(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let (locked,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_personal_agent_sessions WHERE conversation_id = $1)",
    )
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
