//! The team organization a conversation belongs to, as clients see it: a
//! conversation in a team carries `organization` in its snapshot so clients
//! can label it; one in a personal organization carries nothing.

use std::collections::HashMap;

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::support::{active_member_ids, load_conversation};
use super::sync_events::insert_sync_event;
use super::StoreError;
use crate::chat_sync::models::ConversationOrganization;

/// The team organizations of `conversation_ids`, by conversation.
pub(super) async fn labels(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, ConversationOrganization>, StoreError> {
    if conversation_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, String, String)> = query_as(
        "SELECT c.conversation_id, o.organization_id, o.name \
         FROM cloud_chat_conversations c \
         JOIN cloud_organizations o \
           ON o.organization_id = c.organization_id AND o.kind = 'team' \
         WHERE c.conversation_id = ANY($1)",
    )
    .bind(conversation_ids)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(conversation_id, organization_id, name)| {
            (
                conversation_id,
                ConversationOrganization {
                    organization_id,
                    name,
                },
            )
        })
        .collect())
}

/// `organization` for one conversation.
pub(super) async fn label(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Option<ConversationOrganization>, StoreError> {
    let mut found = labels(transaction, &[conversation_id]).await?;
    Ok(found.remove(&conversation_id))
}

/// The organization to write for a conversation `creator` starts: `None`
/// for the creator's personal organization, or `requested` when the creator
/// belongs to it. Anything else is refused as forbidden.
pub(super) async fn for_creator(
    transaction: &mut Transaction<'_, Postgres>,
    creator: &str,
    requested: Option<&str>,
) -> Result<Option<String>, StoreError> {
    use crate::organizations::selection::{for_new_content, SelectionError};
    match for_new_content(&mut **transaction, creator, requested).await {
        Ok(organization_id) => Ok(organization_id),
        Err(SelectionError::NotMember) => Err(StoreError::Forbidden),
        Err(SelectionError::Database(error)) => Err(StoreError::Database(error)),
    }
}

/// Tells every active member's devices that a conversation changed in a way
/// its row does not track by itself, such as its organization: bumps the
/// version and writes `conversation.updated` with each member's projection.
pub async fn announce_conversation_change(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<(), StoreError> {
    query(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now() \
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(&mut **transaction)
    .await?;
    for member in active_member_ids(transaction, conversation_id).await? {
        let projection = load_conversation(transaction, conversation_id, &member).await?;
        let payload = json!({ "conversation": &projection });
        insert_sync_event(
            transaction,
            &member,
            "conversation.updated",
            Some(conversation_id),
            Some(conversation_id),
            Some(projection.version),
            &payload,
        )
        .await?;
    }
    Ok(())
}
