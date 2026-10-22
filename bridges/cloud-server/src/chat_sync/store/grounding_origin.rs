//! Marks the group chats Grounding started, so clients can badge them. A
//! Grounding group is one started from a room: its row in
//! `cloud_common_ground_room_groups` names the conversation and its group
//! space, which later sessions of the same group share.

use std::collections::HashSet;

use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::StoreError;

/// The `origin` a Grounding group carries in its conversation snapshot.
pub const GROUNDING_ORIGIN: &str = "grounding";

/// The ids among `conversation_ids` that belong to a Grounding group.
pub(super) async fn grounding_conversation_ids(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_ids: &[Uuid],
) -> Result<HashSet<Uuid>, StoreError> {
    if conversation_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id FROM cloud_chat_conversations conversation \
         WHERE conversation.conversation_id = ANY($1) AND EXISTS ( \
           SELECT 1 FROM cloud_common_ground_room_groups room_group \
           WHERE room_group.conversation_id = conversation.conversation_id \
              OR room_group.group_space_id = conversation.group_space_id \
         )",
    )
    .bind(conversation_ids)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// `origin` for one conversation: `Some("grounding")` or `None`.
pub(super) async fn conversation_origin(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Option<String>, StoreError> {
    let ids = grounding_conversation_ids(transaction, &[conversation_id]).await?;
    Ok(origin_for(&ids, conversation_id))
}

/// `origin` for a conversation given the Grounding ids found for a batch.
pub(super) fn origin_for(grounding: &HashSet<Uuid>, conversation_id: Uuid) -> Option<String> {
    grounding
        .contains(&conversation_id)
        .then(|| GROUNDING_ORIGIN.to_string())
}
