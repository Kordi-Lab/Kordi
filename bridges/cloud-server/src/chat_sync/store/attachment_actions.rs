use std::collections::{HashMap, HashSet};

use super::support::*;
use super::*;
use crate::chat_sync::models::AttachmentReactionSnapshot;
mod content;
use content::{has_content, is_live_component, metadata_is_photo, remove_references};

fn project(message: &mut MessageSnapshot, hidden: &HashSet<String>) {
    if hidden.is_empty() {
        return;
    }
    let mut removed = hidden.clone();
    remove_references(&mut message.content, &mut removed);
    message.attachment_ids.retain(|id| !removed.contains(id));
    message
        .attachment_reactions
        .retain(|reaction| !removed.contains(&reaction.attachment_id));
}

async fn hidden_ids(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, HashSet<String>>, StoreError> {
    let rows: Vec<(Uuid, String)> = query_as(
        "SELECT message_id, attachment_id FROM cloud_chat_attachment_visibility WHERE account_id=$1 AND message_id=ANY($2)"
    ).bind(account_id).bind(ids).fetch_all(&mut **transaction).await?;
    let mut result = HashMap::<Uuid, HashSet<String>>::new();
    for (message, attachment) in rows {
        result.entry(message).or_default().insert(attachment);
    }
    Ok(result)
}

pub(super) async fn hydrate(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: Option<&str>,
    messages: &mut [MessageSnapshot],
) -> Result<(), StoreError> {
    if messages.is_empty() {
        return Ok(());
    }
    let ids: Vec<_> = messages.iter().map(|message| message.id).collect();
    let rows: Vec<(Uuid, String, String, Vec<String>)> = query_as(
        "SELECT message_id, attachment_id, reaction, ARRAY_AGG(account_id ORDER BY account_id) \
         FROM cloud_chat_attachment_reactions WHERE message_id=ANY($1) AND deleted_at IS NULL \
         GROUP BY message_id, attachment_id, reaction ORDER BY attachment_id, reaction",
    )
    .bind(&ids)
    .fetch_all(&mut **transaction)
    .await?;
    let mut reactions = HashMap::<Uuid, Vec<AttachmentReactionSnapshot>>::new();
    for (id, attachment_id, reaction, account_ids) in rows {
        reactions
            .entry(id)
            .or_default()
            .push(AttachmentReactionSnapshot {
                attachment_id,
                reaction,
                account_ids,
            });
    }
    let hidden = match account_id {
        Some(account) => hidden_ids(transaction, account, &ids).await?,
        None => HashMap::new(),
    };
    for message in messages {
        message.attachment_reactions = reactions.remove(&message.id).unwrap_or_default();
        if let Some(hidden) = hidden.get(&message.id) {
            project(message, hidden);
        }
    }
    Ok(())
}

pub(super) async fn apply_visibility(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    messages: &mut [MessageSnapshot],
) -> Result<(), StoreError> {
    let ids: Vec<_> = messages.iter().map(|message| message.id).collect();
    let hidden = hidden_ids(transaction, account_id, &ids).await?;
    for message in messages {
        if let Some(hidden) = hidden.get(&message.id) {
            project(message, hidden);
        }
    }
    Ok(())
}

pub(super) async fn for_viewer(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    mut message: MessageSnapshot,
) -> Result<MessageSnapshot, StoreError> {
    let hidden = hidden_ids(transaction, account_id, &[message.id]).await?;
    if let Some(hidden) = hidden.get(&message.id) {
        project(&mut message, hidden);
    }
    Ok(message)
}

pub async fn message_for_viewer(
    pool: &PgPool,
    account_id: &str,
    message: MessageSnapshot,
) -> Result<MessageSnapshot, StoreError> {
    let mut transaction = pool.begin().await?;
    let message = for_viewer(&mut transaction, account_id, message).await?;
    transaction.commit().await?;
    Ok(message)
}

/// Apply current private visibility even to old events, including websocket
/// replay. Canonical events in storage are never rewritten for another viewer.
pub(super) async fn project_events(
    pool: &PgPool,
    account_id: &str,
    events: &mut [SyncEventSnapshot],
) -> Result<(), StoreError> {
    let ids: Vec<Uuid> = events
        .iter()
        .filter_map(|event| {
            event
                .payload
                .get("message")?
                .get("id")?
                .as_str()?
                .parse()
                .ok()
        })
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let mut transaction = pool.begin().await?;
    let hidden = hidden_ids(&mut transaction, account_id, &ids).await?;
    for event in events {
        let Some(value) = event.payload.get_mut("message") else {
            continue;
        };
        let Some(id) = value
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| id.parse::<Uuid>().ok())
        else {
            continue;
        };
        let Some(hidden) = hidden.get(&id) else {
            continue;
        };
        let mut message: MessageSnapshot = serde_json::from_value(value.clone())
            .map_err(|_| StoreError::InvariantViolation("stored message event is invalid"))?;
        project(&mut message, hidden);
        if message.attachment_ids.is_empty() && !has_content(&message.content) {
            event.event_type = "message.hidden".into();
            event.entity_id = Some(id);
            event.payload = json!({ "message_id": id });
        } else {
            *value = serde_json::to_value(message)
                .map_err(|_| StoreError::InvariantViolation("message projection failed"))?;
        }
    }
    transaction.commit().await?;
    Ok(())
}

async fn locked_message(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    key: Uuid,
) -> Result<MessageSnapshot, StoreError> {
    require_active_member(transaction, conversation_id, account_id).await?;
    let row: Option<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_messages WHERE conversation_id=$1 \
         AND (message_id=$2 OR client_message_id=$2) ORDER BY (message_id=$2) DESC LIMIT 1 FOR UPDATE"
    ).bind(conversation_id).bind(key).fetch_optional(&mut **transaction).await?;
    load_message(transaction, row.ok_or(StoreError::NotFound)?.0).await
}

async fn require_photo(
    transaction: &mut Transaction<'_, Postgres>,
    message: &MessageSnapshot,
    attachment: &str,
) -> Result<(), StoreError> {
    if is_live_component(&message.content, attachment) {
        return Err(StoreError::InvalidInput(
            "select the Live Photo, not an internal component",
        ));
    }
    let row: Option<(Option<String>, Option<String>)> = query_as(
        "SELECT detected_content_type,content_type FROM cloud_attachments WHERE attachment_id=$1",
    )
    .bind(attachment)
    .fetch_optional(&mut **transaction)
    .await?;
    let (detected, declared) = row.ok_or(StoreError::NotFound)?;
    let is_photo = match detected.or(declared) {
        Some(mime) if mime != "application/octet-stream" => {
            mime.to_ascii_lowercase().starts_with("image/")
        }
        _ => metadata_is_photo(&message.content, attachment),
    };
    if !is_photo {
        return Err(StoreError::InvalidInput(
            "attachment-scoped actions currently support photos only",
        ));
    }
    Ok(())
}

pub async fn set_attachment_reaction(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_key: Uuid,
    attachment_id: &str,
    value: &str,
    active: bool,
) -> Result<MessageSnapshot, StoreError> {
    let reaction = reaction::normalized_reaction(value)?;
    let mut transaction = pool.begin().await?;
    let current =
        locked_message(&mut transaction, account_id, conversation_id, message_key).await?;
    let visible = for_viewer(&mut transaction, account_id, current.clone()).await?;
    if current.deleted_at.is_some() || !visible.attachment_ids.iter().any(|id| id == attachment_id)
    {
        return Err(StoreError::NotFound);
    }
    require_photo(&mut transaction, &current, attachment_id).await?;
    let hidden: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_chat_message_visibility WHERE account_id=$1 AND message_id=$2)")
        .bind(account_id).bind(current.id).fetch_one(&mut *transaction).await?;
    if hidden.0 {
        return Err(StoreError::NotFound);
    }
    let changed = if active {
        query("INSERT INTO cloud_chat_attachment_reactions(message_id,attachment_id,account_id,reaction) VALUES($1,$2,$3,$4) \
               ON CONFLICT(message_id,attachment_id,account_id,reaction) DO UPDATE SET deleted_at=NULL,created_at=now() \
               WHERE cloud_chat_attachment_reactions.deleted_at IS NOT NULL")
            .bind(current.id).bind(attachment_id).bind(account_id).bind(&reaction).execute(&mut *transaction).await?.rows_affected() > 0
    } else {
        query("UPDATE cloud_chat_attachment_reactions SET deleted_at=now() WHERE message_id=$1 AND attachment_id=$2 AND account_id=$3 AND reaction=$4 AND deleted_at IS NULL")
            .bind(current.id).bind(attachment_id).bind(account_id).bind(&reaction).execute(&mut *transaction).await?.rows_affected() > 0
    };
    let message = load_message(&mut transaction, current.id).await?;
    if changed {
        for recipient in active_member_ids(&mut transaction, conversation_id).await? {
            let conversation =
                load_conversation(&mut transaction, conversation_id, &recipient).await?;
            insert_noncritical_sync_event(
                &mut transaction,
                &recipient,
                "reaction.updated",
                Some(conversation_id),
                Some(message.id),
                None,
                &json!({ "message": &message, "conversation": conversation }),
            )
            .await?;
        }
    }
    let result = for_viewer(&mut transaction, account_id, message).await?;
    transaction.commit().await?;
    Ok(result)
}

pub async fn delete_attachment(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_key: Uuid,
    attachment_id: &str,
    for_everyone: bool,
) -> Result<Option<MessageSnapshot>, StoreError> {
    let mut transaction = pool.begin().await?;
    let current =
        locked_message(&mut transaction, account_id, conversation_id, message_key).await?;
    if for_everyone && current.sender_account_id != account_id {
        return Err(StoreError::Forbidden);
    }
    if current.deleted_at.is_some() {
        return Ok(None);
    }
    if !current.attachment_ids.iter().any(|id| id == attachment_id) {
        let result = for_viewer(&mut transaction, account_id, current).await?;
        transaction.commit().await?;
        return Ok(Some(result));
    }
    require_photo(&mut transaction, &current, attachment_id).await?;
    let mut removed = HashSet::from([attachment_id.to_owned()]);
    let mut replacement = current.clone();
    remove_references(&mut replacement.content, &mut removed);
    replacement
        .attachment_ids
        .retain(|id| !removed.contains(id));
    if !for_everyone {
        let changed = query("INSERT INTO cloud_chat_attachment_visibility(account_id,message_id,attachment_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(account_id).bind(current.id).bind(attachment_id).execute(&mut *transaction).await?.rows_affected() > 0;
        let visible = for_viewer(&mut transaction, account_id, current.clone()).await?;
        let empty = visible.attachment_ids.is_empty() && !has_content(&visible.content);
        if empty {
            let changed = query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
                .bind(account_id).bind(current.id).execute(&mut *transaction).await?.rows_affected() > 0;
            if changed {
                insert_noncritical_sync_event(
                    &mut transaction,
                    account_id,
                    "message.hidden",
                    Some(conversation_id),
                    Some(current.id),
                    Some(current.version),
                    &json!({ "message_id": current.id }),
                )
                .await?;
            }
        } else if changed {
            let conversation =
                load_conversation(&mut transaction, conversation_id, account_id).await?;
            insert_noncritical_sync_event(
                &mut transaction,
                account_id,
                "message.updated",
                Some(conversation_id),
                Some(current.id),
                Some(current.version),
                &json!({ "message": &visible, "conversation": conversation }),
            )
            .await?;
        }
        transaction.commit().await?;
        return Ok(if empty { None } else { Some(visible) });
    }
    let empty = replacement.attachment_ids.is_empty() && !has_content(&replacement.content);
    if empty {
        query("UPDATE cloud_chat_messages SET content='{\"schema\":1,\"blocks\":[]}'::jsonb, version=version+1, deleted_at=now(), generation_status=NULL,provider_response_id=NULL WHERE message_id=$1")
            .bind(current.id).execute(&mut *transaction).await?;
        query("DELETE FROM cloud_chat_message_attachments WHERE message_id=$1")
            .bind(current.id)
            .execute(&mut *transaction)
            .await?;
        query("DELETE FROM cloud_chat_message_reactions WHERE message_id=$1")
            .bind(current.id)
            .execute(&mut *transaction)
            .await?;
    } else {
        query("UPDATE cloud_chat_messages SET content=$2,version=version+1,edited_at=now() WHERE message_id=$1")
            .bind(current.id).bind(&replacement.content).execute(&mut *transaction).await?;
        let removed: Vec<_> = removed.into_iter().collect();
        query("DELETE FROM cloud_chat_message_attachments WHERE message_id=$1 AND attachment_id=ANY($2)")
            .bind(current.id).bind(&removed).execute(&mut *transaction).await?;
    }
    let message = load_message(&mut transaction, current.id).await?;
    if !empty {
        for recipient in active_member_ids(&mut transaction, conversation_id).await? {
            let visible = for_viewer(&mut transaction, &recipient, message.clone()).await?;
            if visible.attachment_ids.is_empty() && !has_content(&visible.content) {
                query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
                    .bind(&recipient).bind(message.id).execute(&mut *transaction).await?;
            }
        }
    }
    message::fanout_message_sync_event(
        &mut transaction,
        if empty {
            "message.deleted"
        } else {
            "message.updated"
        },
        &message,
    )
    .await?;
    let result = if empty {
        None
    } else {
        let visible = for_viewer(&mut transaction, account_id, message).await?;
        if visible.attachment_ids.is_empty() && !has_content(&visible.content) {
            None
        } else {
            Some(visible)
        }
    };
    transaction.commit().await?;
    Ok(result)
}
