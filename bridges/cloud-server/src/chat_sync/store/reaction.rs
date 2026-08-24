use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use unicode_properties::UnicodeEmoji;
use unicode_segmentation::UnicodeSegmentation;

use super::support::*;
use super::*;

pub(super) async fn reactions_by_message(
    transaction: &mut Transaction<'_, Postgres>,
    message_ids: &[Uuid],
) -> Result<HashMap<Uuid, Vec<ReactionSnapshot>>, StoreError> {
    if message_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(Uuid, String, Vec<String>)> = query_as(
        "SELECT message_id, reaction, ARRAY_AGG(account_id ORDER BY account_id) \
         FROM cloud_chat_message_reactions \
         WHERE message_id = ANY($1) AND deleted_at IS NULL \
         GROUP BY message_id, reaction ORDER BY message_id ASC, reaction ASC",
    )
    .bind(message_ids)
    .fetch_all(&mut **transaction)
    .await?;
    let mut result = HashMap::<Uuid, Vec<ReactionSnapshot>>::new();
    for (message_id, reaction, account_ids) in rows {
        result
            .entry(message_id)
            .or_default()
            .push(ReactionSnapshot {
                reaction,
                account_ids,
            });
    }
    Ok(result)
}

pub async fn set_reaction(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_key: Uuid,
    reaction: &str,
    active: bool,
) -> Result<MessageSnapshot, StoreError> {
    let reaction = normalized_reaction(reaction)?;
    let mut transaction = pool.begin().await?;
    require_active_member(&mut transaction, conversation_id, account_id).await?;
    let message_id: Option<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND deleted_at IS NULL \
         AND (message_id = $2 OR client_message_id = $2) \
         ORDER BY (message_id = $2) DESC LIMIT 1 FOR UPDATE",
    )
    .bind(conversation_id)
    .bind(message_key)
    .fetch_optional(&mut *transaction)
    .await?;
    let message_id = message_id.ok_or(StoreError::NotFound)?.0;
    let changed = if active {
        query(
            "INSERT INTO cloud_chat_message_reactions(message_id, account_id, reaction) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (message_id, account_id, reaction) \
             DO UPDATE SET created_at = now(), deleted_at = NULL \
             WHERE cloud_chat_message_reactions.deleted_at IS NOT NULL",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(&reaction)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    } else {
        query(
            "UPDATE cloud_chat_message_reactions SET deleted_at = now() \
             WHERE message_id = $1 AND account_id = $2 AND reaction = $3 \
             AND deleted_at IS NULL",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(&reaction)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
            == 1
    };
    let message = load_message(&mut transaction, message_id).await?;
    if changed {
        for recipient in active_member_ids(&mut transaction, conversation_id).await? {
            let conversation =
                load_conversation(&mut transaction, conversation_id, &recipient).await?;
            insert_noncritical_sync_event(
                &mut transaction,
                &recipient,
                "reaction.updated",
                Some(conversation_id),
                Some(message_id),
                None,
                &json!({ "message": &message, "conversation": &conversation }),
            )
            .await?;
        }
    }
    transaction.commit().await?;
    Ok(message)
}

pub(crate) fn normalized_reaction(value: &str) -> Result<String, StoreError> {
    let reaction = value.trim();
    if let Some(id) = reaction.strip_prefix("blob:") {
        if blob_emoji_ids().contains(id) {
            return Ok(reaction.to_string());
        }
        return Err(StoreError::InvalidInput(
            "reaction must reference a known Blob Emoji",
        ));
    }
    if reaction.is_empty()
        || reaction.len() > 64
        || reaction.graphemes(true).count() != 1
        || !reaction.chars().any(UnicodeEmoji::is_emoji_char)
    {
        return Err(StoreError::InvalidInput(
            "reaction must be one Unicode emoji",
        ));
    }
    Ok(reaction.to_string())
}

fn blob_emoji_ids() -> &'static HashSet<&'static str> {
    static IDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    IDS.get_or_init(|| {
        include_str!("../../../../../shared/blob-emoji/ids.txt")
            .lines()
            .filter(|value| !value.is_empty())
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::normalized_reaction;

    #[test]
    fn reactions_require_one_unicode_emoji_grapheme() {
        assert_eq!(normalized_reaction("👨‍👩‍👧‍👦").unwrap(), "👨‍👩‍👧‍👦");
        assert_eq!(normalized_reaction("👍🏽").unwrap(), "👍🏽");
        assert_eq!(
            normalized_reaction("blob:blobwave").unwrap(),
            "blob:blobwave"
        );
        assert!(normalized_reaction("hello").is_err());
        assert!(normalized_reaction("👍 ❤️").is_err());
        assert!(normalized_reaction("blob:not-in-the-catalog").is_err());
    }
}
