use super::group_identity::GroupEnvelopeProjection;
use super::*;

/// Records the group space and title a group envelope names.
///
/// A conversation joins a space only when the envelope names the
/// conversation itself (a space's main conversation) or the sender is an
/// active member of the space's main conversation; otherwise its stored space
/// is kept. A new space title reaches only conversations of that space the
/// sender is an active member of.
pub(super) async fn apply_group_projection(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    projection: &GroupEnvelopeProjection,
) -> Result<(), StoreError> {
    let group_title = matches!(
        projection.kind.as_str(),
        "group-invite" | "group-update" | "group-title-update"
    )
    .then(|| projection.group_title.as_deref())
    .flatten();
    query(
        "WITH space AS ( \
           SELECT CASE WHEN $2 = conversation.legacy_session_id OR EXISTS ( \
                    SELECT 1 FROM cloud_chat_conversations root \
                    JOIN cloud_chat_conversation_members member \
                      ON member.conversation_id = root.conversation_id \
                    WHERE root.legacy_session_id = $2 AND root.kind = 'group' \
                      AND member.account_id = $4 AND member.membership_state = 'active') \
                  THEN $2 ELSE conversation.group_space_id END AS group_space_id \
           FROM cloud_chat_conversations conversation \
           WHERE conversation.conversation_id = $1) \
         UPDATE cloud_chat_conversations conversation \
         SET group_space_id = space.group_space_id, \
             group_title = COALESCE( \
               $3, conversation.group_title, ( \
                 SELECT sibling.group_title \
                 FROM cloud_chat_conversations sibling \
                 WHERE sibling.group_space_id = space.group_space_id \
                   AND sibling.group_title IS NOT NULL \
                 ORDER BY sibling.updated_at DESC LIMIT 1 \
               ) \
             ) \
         FROM space \
         WHERE conversation.conversation_id = $1",
    )
    .bind(conversation_id)
    .bind(&projection.group_space_id)
    .bind(group_title)
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    if let Some(group_title) = group_title {
        query(
            "UPDATE cloud_chat_conversations conversation \
             SET group_title = $2 \
             WHERE conversation.group_space_id = $1 \
               AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                           WHERE member.conversation_id = conversation.conversation_id \
                             AND member.account_id = $3 \
                             AND member.membership_state = 'active')",
        )
        .bind(&projection.group_space_id)
        .bind(group_title)
        .bind(account_id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}
