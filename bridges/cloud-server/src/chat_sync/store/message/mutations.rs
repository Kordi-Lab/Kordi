use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const CLOUD_DIRECT_PREFIX: &str = "kordi-cloud-message:";
const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";
const MAX_EDITED_MESSAGE_BYTES: usize = 256 * 1024;

fn replace_encoded_text(
    value: &str,
    prefix: &str,
    sender_account_id: &str,
    text: &str,
) -> Result<Option<String>, StoreError> {
    let Some(encoded) = value.strip_prefix(prefix) else {
        return Ok(None);
    };
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| StoreError::InvalidInput("message content is invalid"))?;
    let mut envelope: Value = serde_json::from_slice(&decoded)
        .map_err(|_| StoreError::InvalidInput("message content is invalid"))?;
    let object = envelope
        .as_object_mut()
        .ok_or(StoreError::InvalidInput("message content is invalid"))?;
    if prefix == CLOUD_GROUP_PREFIX {
        let message = object
            .get_mut("message")
            .and_then(Value::as_object_mut)
            .ok_or(StoreError::InvalidInput("group message content is invalid"))?;
        if message.get("senderAccountId").and_then(Value::as_str) != Some(sender_account_id) {
            return Err(StoreError::Forbidden);
        }
        message.insert("text".to_string(), Value::String(text.to_string()));
    } else {
        if object.get("kind").and_then(Value::as_str) != Some("message") {
            return Err(StoreError::InvalidInput("message content is invalid"));
        }
        object.insert("text".to_string(), Value::String(text.to_string()));
    }
    Ok(Some(format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&envelope)
                .map_err(|_| StoreError::InvalidInput("message content is invalid"))?
        )
    )))
}

fn replace_message_text(
    content: &mut Value,
    sender_account_id: &str,
    text: &str,
) -> Result<(), StoreError> {
    let blocks = content
        .get_mut("blocks")
        .and_then(Value::as_array_mut)
        .ok_or(StoreError::InvalidInput("message content is invalid"))?;
    let block = blocks
        .iter_mut()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(Value::as_object_mut)
        .ok_or(StoreError::InvalidInput("message has no editable text"))?;
    let current = block
        .get("text")
        .and_then(Value::as_str)
        .ok_or(StoreError::InvalidInput("message has no editable text"))?;
    let replacement = replace_encoded_text(current, CLOUD_GROUP_PREFIX, sender_account_id, text)?
        .or(replace_encoded_text(
            current,
            CLOUD_DIRECT_PREFIX,
            sender_account_id,
            text,
        )?)
        .unwrap_or_else(|| text.to_string());
    block.insert("text".to_string(), Value::String(replacement));
    Ok(())
}

pub async fn edit_message(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_id: Uuid,
    request: UpdateMessageRequest,
) -> Result<MessageSnapshot, StoreError> {
    if request.expected_version < 1 {
        return Err(StoreError::InvalidInput("message version is invalid"));
    }
    let mut transaction = pool.begin().await?;
    let row: Option<(Uuid, String)> = query_as(
        "SELECT conversation_id, sender_account_id FROM cloud_chat_messages \
         WHERE message_id = $1 FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((stored_conversation_id, sender_account_id)) = row else {
        return Err(StoreError::NotFound);
    };
    if stored_conversation_id != conversation_id {
        return Err(StoreError::NotFound);
    }
    require_active_member(&mut transaction, conversation_id, account_id).await?;
    if sender_account_id != account_id {
        return Err(StoreError::Forbidden);
    }
    let current = load_message(&mut transaction, message_id).await?;
    if current.kind != "text" || current.deleted_at.is_some() {
        return Err(StoreError::Forbidden);
    }
    if current.version != request.expected_version {
        return Err(StoreError::MessageVersionConflict(Box::new(current)));
    }
    if request.text.trim().is_empty() && current.attachment_ids.is_empty() {
        return Err(StoreError::InvalidInput("message text cannot be empty"));
    }
    let mut content = current.content.clone();
    replace_message_text(&mut content, account_id, &request.text)?;
    if serde_json::to_vec(&content)
        .map(|value| value.len())
        .unwrap_or(usize::MAX)
        > MAX_EDITED_MESSAGE_BYTES
    {
        return Err(StoreError::InvalidInput("message content is too large"));
    }
    if content == current.content {
        transaction.commit().await?;
        return Ok(current);
    }
    query(
        "UPDATE cloud_chat_messages \
         SET content = $2, version = version + 1, edited_at = now() \
         WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(&content)
    .execute(&mut *transaction)
    .await?;
    let message = load_message(&mut transaction, message_id).await?;
    fanout_message_sync_event(&mut transaction, "message.updated", &message).await?;
    transaction.commit().await?;
    Ok(message)
}

pub async fn delete_message(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_id: Uuid,
    for_everyone: bool,
) -> Result<(), StoreError> {
    let mut transaction = pool.begin().await?;
    let row: Option<(Uuid, String)> = query_as(
        "SELECT conversation_id, sender_account_id FROM cloud_chat_messages \
         WHERE message_id = $1 FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((stored_conversation_id, sender_account_id)) = row else {
        return Err(StoreError::NotFound);
    };
    if stored_conversation_id != conversation_id {
        return Err(StoreError::NotFound);
    }
    require_active_member(&mut transaction, conversation_id, account_id).await?;
    let current = load_message(&mut transaction, message_id).await?;

    if !for_everyone {
        if current.deleted_at.is_some() {
            transaction.commit().await?;
            return Ok(());
        }
        let inserted = query(
            "INSERT INTO cloud_chat_message_visibility(account_id, message_id) \
             VALUES ($1, $2) ON CONFLICT (account_id, message_id) DO NOTHING",
        )
        .bind(account_id)
        .bind(message_id)
        .execute(&mut *transaction)
        .await?;
        if inserted.rows_affected() > 0 {
            insert_noncritical_sync_event(
                &mut transaction,
                account_id,
                "message.hidden",
                Some(conversation_id),
                Some(message_id),
                Some(current.version),
                &json!({ "message_id": message_id }),
            )
            .await?;
        }
        transaction.commit().await?;
        return Ok(());
    }

    if sender_account_id != account_id {
        return Err(StoreError::Forbidden);
    }
    if current.deleted_at.is_some() {
        transaction.commit().await?;
        return Ok(());
    }
    query(
        "UPDATE cloud_chat_messages \
         SET content = '{\"schema\":1,\"blocks\":[]}'::jsonb, \
             version = version + 1, deleted_at = now(), \
             generation_status = NULL, provider_response_id = NULL \
         WHERE message_id = $1",
    )
    .bind(message_id)
    .execute(&mut *transaction)
    .await?;
    query("DELETE FROM cloud_chat_message_attachments WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut *transaction)
        .await?;
    query("DELETE FROM cloud_chat_message_reactions WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut *transaction)
        .await?;
    let message = load_message(&mut transaction, message_id).await?;
    fanout_message_sync_event(&mut transaction, "message.deleted", &message).await?;
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(prefix: &str, value: Value) -> String {
        format!(
            "{prefix}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
        )
    }

    fn decoded(value: &str, prefix: &str) -> Value {
        serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(value.strip_prefix(prefix).unwrap())
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn edits_plain_direct_and_group_text_without_replacing_envelope_metadata() {
        let mut plain = json!({ "blocks": [{ "type": "text", "text": "before" }] });
        replace_message_text(&mut plain, "acct_me", "after").unwrap();
        assert_eq!(plain["blocks"][0]["text"], "after");

        let mut direct = json!({ "blocks": [{
            "type": "text",
            "text": encoded(CLOUD_DIRECT_PREFIX, json!({
                "schemaVersion": 1,
                "kind": "message",
                "text": "before",
                "messageAction": { "kind": "quote" }
            }))
        }] });
        replace_message_text(&mut direct, "acct_me", "after").unwrap();
        let direct_envelope = decoded(
            direct["blocks"][0]["text"].as_str().unwrap(),
            CLOUD_DIRECT_PREFIX,
        );
        assert_eq!(direct_envelope["text"], "after");
        assert_eq!(direct_envelope["messageAction"]["kind"], "quote");

        let mut group = json!({ "blocks": [{
            "type": "text",
            "text": encoded(CLOUD_GROUP_PREFIX, json!({
                "kind": "group-message",
                "message": {
                    "senderAccountId": "acct_me",
                    "text": "before",
                    "mentions": [{ "label": "@Kordi" }]
                }
            }))
        }] });
        replace_message_text(&mut group, "acct_me", "after").unwrap();
        let group_envelope = decoded(
            group["blocks"][0]["text"].as_str().unwrap(),
            CLOUD_GROUP_PREFIX,
        );
        assert_eq!(group_envelope["message"]["text"], "after");
        assert_eq!(group_envelope["message"]["mentions"][0]["label"], "@Kordi");
        assert!(matches!(
            replace_message_text(&mut group, "acct_other", "no"),
            Err(StoreError::Forbidden)
        ));
    }
}
