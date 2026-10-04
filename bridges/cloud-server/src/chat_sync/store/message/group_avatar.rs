use serde_json::{json, Value};
use sqlx_core::{query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;
use uuid::Uuid;

use super::super::insert_sync_event_fanout;
use super::super::support::load_active_conversation_projections;
use super::super::StoreError;
use super::group_identity::GroupEnvelopeProjection;

pub(super) fn avatar_image(value: &Value) -> Result<Option<&str>, StoreError> {
    match value.get("imageUrl") {
        Some(Value::Null) => Ok(None),
        Some(Value::String(image))
            if crate::avatars::assets::parse_uploaded_avatar_marker(image).is_some() =>
        {
            Ok(Some(image))
        }
        _ => Err(StoreError::InvalidInput(
            "group avatar must be an uploaded image reference",
        )),
    }
}

/// Refuses a group envelope that names a space other than the one the
/// conversation belongs to, so no envelope moves a conversation between
/// spaces. A conversation that belongs to no space yet may name an existing
/// space only when the sender is an active member of it: of the space's main
/// conversation or of a conversation already in the space.
pub(super) async fn authorize_group_space_attachment(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    group_space_id: &str,
) -> Result<(), StoreError> {
    let (stored_space,): (Option<String>,) = query_as(
        "SELECT group_space_id FROM cloud_chat_conversations \
         WHERE conversation_id = $1 FOR UPDATE",
    )
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?;
    if let Some(stored_space) = stored_space {
        return if stored_space.trim_start_matches("group:") == group_space_id {
            Ok(())
        } else {
            Err(StoreError::Forbidden)
        };
    }
    let (exists, member): (bool, bool) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_conversations conversation \
           WHERE conversation.group_space_id = $1 \
              OR (conversation.legacy_session_id = $1 AND conversation.kind = 'group')), \
         EXISTS (SELECT 1 FROM cloud_chat_conversations conversation \
           JOIN cloud_chat_conversation_members member USING (conversation_id) \
           WHERE (conversation.group_space_id = $1 \
                  OR (conversation.legacy_session_id = $1 AND conversation.kind = 'group')) \
             AND member.account_id = $2 AND member.membership_state = 'active')",
    )
    .bind(group_space_id)
    .bind(account_id)
    .fetch_one(&mut **transaction)
    .await?;
    if exists && !member {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}

pub(super) async fn prepare_group_avatar(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    projection: &GroupEnvelopeProjection,
) -> Result<Option<Value>, StoreError> {
    let explicit_update = projection.kind == "group-avatar-update";
    if !explicit_update && projection.kind != "group-invite" {
        return Ok(None);
    }
    let Some(avatar) = projection.group_avatar.as_ref() else {
        return if explicit_update {
            Err(StoreError::InvalidInput("group avatar is required"))
        } else {
            Ok(None)
        };
    };
    let row: Option<(String, String, Option<String>, Option<String>)> = query_as(
        "SELECT conversation.kind, member.role, conversation.group_space_id, conversation.legacy_session_id \
         FROM cloud_chat_conversations conversation JOIN cloud_chat_conversation_members member \
         ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.conversation_id = $1 AND member.account_id = $2 AND member.membership_state = 'active'",
    ).bind(conversation_id).bind(account_id).fetch_optional(&mut **transaction).await?;
    let Some((kind, role, stored_space, legacy_id)) = row else {
        return Err(StoreError::Forbidden);
    };
    if kind != "group" || !matches!(role.as_str(), "owner" | "admin") {
        return Err(StoreError::Forbidden);
    }
    let expected_space = stored_space
        .as_deref()
        .or(legacy_id.as_deref())
        .unwrap_or_default();
    if expected_space.trim_start_matches("group:")
        != projection.group_space_id.trim_start_matches("group:")
    {
        return Err(StoreError::Forbidden);
    }
    // Owning a channel with a claimed space ID cannot authorize changes to
    // another group's channels. The actor must belong to every fanout target.
    let inaccessible_sibling: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_chat_conversations sibling \
         WHERE sibling.group_space_id = $1 AND NOT EXISTS ( \
           SELECT 1 FROM cloud_chat_conversation_members member \
           WHERE member.conversation_id = sibling.conversation_id \
             AND member.account_id = $2 AND member.membership_state = 'active' \
         ) LIMIT 1",
    )
    .bind(&projection.group_space_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if inaccessible_sibling.is_some() {
        return Err(StoreError::Forbidden);
    }
    let previous: Option<(Value,)> = query_as(
        "SELECT group_avatar FROM cloud_chat_conversations WHERE group_space_id = $1 AND group_avatar IS NOT NULL \
         ORDER BY (group_avatar->>'updatedAtMs')::bigint DESC LIMIT 1",
    ).bind(&projection.group_space_id).fetch_optional(&mut **transaction).await?;
    if !explicit_update && previous.is_some() {
        return Ok(None);
    }
    let image = avatar_image(avatar)?;
    if let Some(image) = image {
        crate::avatars::assets::activate_avatar_asset(
            transaction,
            account_id,
            "human",
            account_id,
            image,
        )
        .await
        .map_err(|error| match error {
            crate::avatars::assets::AvatarAssetError::Database(error) => {
                StoreError::Database(error)
            }
            _ => StoreError::InvalidInput("uploaded group avatar is unavailable"),
        })?;
    }
    let previous_revision = previous
        .and_then(|row| row.0.get("updatedAtMs").and_then(Value::as_i64))
        .unwrap_or(0);
    let revision = chrono::Utc::now()
        .timestamp_millis()
        .max(previous_revision.saturating_add(1));
    Ok(Some(json!({ "imageUrl": image, "updatedAtMs": revision })))
}

pub(super) async fn publish_group_avatar(
    transaction: &mut Transaction<'_, Postgres>,
    group_space_id: &str,
    avatar: &Value,
) -> Result<(), StoreError> {
    let conversations: Vec<(Uuid,)> = query_as(
        "UPDATE cloud_chat_conversations SET group_avatar = $2, version = version + 1 \
         WHERE group_space_id = $1 RETURNING conversation_id",
    )
    .bind(group_space_id)
    .bind(avatar)
    .fetch_all(&mut **transaction)
    .await?;
    for (id,) in conversations {
        let payloads = load_active_conversation_projections(transaction, id)
            .await?
            .into_iter()
            .map(|(account, conversation)| (account, json!({ "conversation": conversation })))
            .collect();
        insert_sync_event_fanout(
            transaction,
            "conversation.updated",
            Some(id),
            None,
            None,
            payloads,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_inline_images_external_urls_and_missing_values() {
        for value in [
            json!({}),
            json!({"imageUrl":"data:image/png;base64,AA=="}),
            json!({"imageUrl":"https://example.com/avatar.png"}),
        ] {
            assert!(avatar_image(&value).is_err());
        }
        assert_eq!(avatar_image(&json!({"imageUrl":null})).unwrap(), None);
        assert!(avatar_image(
            &json!({"imageUrl":"kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef"})
        )
        .unwrap()
        .is_some());
    }
}
