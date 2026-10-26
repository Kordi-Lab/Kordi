//! Making an agent's personal session ready while its Proactive setting is
//! on: reuse the bound conversation, unhide it when the owner hid it while
//! the setting was off, or replace it with a new conversation when the owner
//! deleted it then. A definition is bound only while it is active.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::sessions::PersonalSession;
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};
use crate::chat_sync::store::{self, StoreError};

/// What [`activate_in_transaction`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Activation {
    /// A new conversation; its `conversation.created` names the agent.
    Created,
    /// The bound conversation was hidden and is shown again.
    Unhidden,
    /// The bound conversation is used as it is.
    Reused,
}

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

/// (conversation id, legacy session id, owner still a member)
type BoundRow = (Uuid, String, bool);

async fn bound_for_update(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Option<BoundRow>, sqlx_core::Error> {
    query_as(
        "SELECT binding.conversation_id, conversation.legacy_session_id,
                EXISTS(SELECT 1 FROM cloud_chat_conversation_members member
                       WHERE member.conversation_id = binding.conversation_id
                         AND member.account_id = binding.owner_account_id
                         AND member.membership_state = 'active')
         FROM cloud_personal_agent_sessions binding
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = binding.conversation_id
         WHERE binding.agent_id = $1 AND binding.owner_account_id = $2
           AND conversation.legacy_session_id IS NOT NULL
         FOR UPDATE OF binding",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .fetch_optional(&mut **transaction)
    .await
}

/// (deleted, hidden) for the owner, under either id a client may have used.
async fn visibility(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    keys: &[String],
) -> Result<(bool, bool), sqlx_core::Error> {
    let (deleted, hidden): (Option<bool>, Option<bool>) = query_as(
        "SELECT bool_or(deleted_at IS NOT NULL), bool_or(hidden_at IS NOT NULL)
         FROM cloud_account_session_visibility WHERE account_id = $1 AND session_id = ANY($2)",
    )
    .bind(owner_account_id)
    .bind(keys)
    .fetch_one(&mut **transaction)
    .await?;
    Ok((deleted.unwrap_or(false), hidden.unwrap_or(false)))
}

/// Shows a hidden session again, as the owner's own unhide does.
async fn unhide(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    conversation_id: Uuid,
    keys: &[String],
) -> Result<(), StoreError> {
    let removed: Vec<(String,)> = query_as(
        "DELETE FROM cloud_account_session_visibility
         WHERE account_id = $1 AND session_id = ANY($2) RETURNING session_id",
    )
    .bind(owner_account_id)
    .bind(keys)
    .fetch_all(&mut **transaction)
    .await?;
    let now = Utc::now().to_rfc3339();
    for (session_id,) in removed {
        store::append_user_sync_events_in_transaction(
            transaction,
            &[owner_account_id.to_string()],
            "session.unhidden",
            Some(conversation_id),
            &serde_json::json!({ "sessionId": session_id, "unhiddenAt": now }),
        )
        .await?;
    }
    Ok(())
}

/// Creates a personal session conversation under `session_id`, or returns
/// the one that has it, bound to the agent unless the agent already has one.
async fn create(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    agent_id: &str,
    session_id: String,
) -> Result<Uuid, StoreError> {
    let request = CreateConversationRequest {
        client_operation_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, session_id.as_bytes()),
        kind: ConversationKind::Ai,
        shared_title: None,
        client_session_id: session_id,
        member_account_ids: vec![owner_account_id.to_string()],
    };
    let outcome = store::create_personal_session_in_transaction(
        transaction,
        owner_account_id,
        request,
        agent_id,
    )
    .await?;
    Ok(outcome.value.id)
}

/// Makes the agent's personal session ready in the caller's transaction and
/// returns it. Racing calls get one conversation: the binding row is locked,
/// and a first creation takes the session id's lock with an operation id
/// derived from the session id.
pub(crate) async fn activate_in_transaction(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<(PersonalSession, Activation), StoreError> {
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
        .fetch_optional(&mut **transaction)
        .await?;
        if active.is_none() {
            return Err(StoreError::NotFound);
        }
    }
    let base_session_id = store::personal_session_id(owner_account_id, agent_id);
    let activation = match bound_for_update(transaction, owner_account_id, agent_id).await? {
        None => {
            let conversation_id =
                create(transaction, owner_account_id, agent_id, base_session_id).await?;
            // A conversation that already existed under this id is bound here.
            query(
                "INSERT INTO cloud_personal_agent_sessions
                     (agent_id, owner_account_id, conversation_id)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(agent_id)
            .bind(owner_account_id)
            .bind(conversation_id)
            .execute(&mut **transaction)
            .await?;
            Activation::Created
        }
        Some((conversation_id, session_id, member)) => {
            let keys = vec![session_id, conversation_id.to_string()];
            let (deleted, hidden) = visibility(transaction, owner_account_id, &keys).await?;
            if deleted || !member {
                // The owner deleted it while the setting was off: a new
                // conversation takes its place, bound before its
                // `conversation.created` is written; the old one stays.
                query("DELETE FROM cloud_personal_agent_sessions WHERE agent_id = $1")
                    .bind(agent_id)
                    .execute(&mut **transaction)
                    .await?;
                let session_id = format!("{base_session_id}:{}", Uuid::new_v4().simple());
                create(transaction, owner_account_id, agent_id, session_id).await?;
                Activation::Created
            } else if hidden {
                unhide(transaction, owner_account_id, conversation_id, &keys).await?;
                Activation::Unhidden
            } else {
                Activation::Reused
            }
        }
    };
    let session: Option<(Uuid, String)> = query_as(
        "SELECT binding.conversation_id, conversation.legacy_session_id
         FROM cloud_personal_agent_sessions binding
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = binding.conversation_id
         WHERE binding.agent_id = $1 AND binding.owner_account_id = $2",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let (conversation_id, session_id) = session.ok_or(StoreError::NotFound)?;
    Ok((
        PersonalSession {
            agent_id: agent_id.to_string(),
            conversation_id,
            session_id,
        },
        activation,
    ))
}
