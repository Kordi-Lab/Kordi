use super::*;

#[derive(serde::Deserialize)]
pub struct UpdateVoiceTranscriptRequest {
    pub expected_version: i32,
    pub media_id: String,
    pub transcript: String,
    pub transcription: Value,
}

pub async fn update_voice_transcript(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    message_id: Uuid,
    request: UpdateVoiceTranscriptRequest,
) -> Result<MessageSnapshot, StoreError> {
    if request.expected_version < 1 {
        return Err(StoreError::InvalidInput("message version is invalid"));
    }
    let mut transaction = pool.begin().await?;
    let row: Option<(Uuid, String)> = query_as("SELECT conversation_id,sender_account_id FROM cloud_chat_messages WHERE message_id=$1 FOR UPDATE")
        .bind(message_id).fetch_optional(&mut *transaction).await?;
    let Some((conversation, sender)) = row else {
        return Err(StoreError::NotFound);
    };
    if conversation != conversation_id {
        return Err(StoreError::NotFound);
    }
    require_active_member(&mut transaction, conversation_id, account_id).await?;
    if sender != account_id {
        return Err(StoreError::Forbidden);
    }
    let current = load_message(&mut transaction, message_id).await?;
    let hidden: (bool,) = query_as("SELECT EXISTS(SELECT 1 FROM cloud_chat_message_visibility WHERE account_id=$1 AND message_id=$2)")
        .bind(account_id).bind(message_id).fetch_one(&mut *transaction).await?;
    let visible =
        super::super::attachment_actions::for_viewer(&mut transaction, account_id, current.clone())
            .await?;
    if current.kind != "voice"
        || current.deleted_at.is_some()
        || hidden.0
        || visible.attachment_ids != current.attachment_ids
        || current.attachment_ids != [request.media_id.clone()]
    {
        return Err(StoreError::Forbidden);
    }
    let mut content = current.content.clone();
    let voice = content["blocks"]
        .as_array_mut()
        .and_then(|blocks| blocks.iter_mut().find(|b| b["type"] == "voice"))
        .ok_or(StoreError::InvalidInput("voice metadata is missing"))?;
    if voice["mediaId"].as_str() != Some(&request.media_id) {
        return Err(StoreError::Forbidden);
    }
    if voice["transcript"] == request.transcript && voice["transcription"] == request.transcription
    {
        transaction.commit().await?;
        return Ok(current);
    }
    if current.version != request.expected_version {
        return Err(StoreError::MessageVersionConflict(Box::new(visible)));
    }
    let old_attempts = voice["transcription"]["attempts"].as_u64().unwrap_or(0);
    let old_text = voice["transcript"].as_str().unwrap_or_default().trim();
    if crate::chat_sync::voice::valid_transcription(voice)
        && !old_text.is_empty()
        && old_text != "Transcription unavailable."
    {
        return Err(StoreError::InvalidInput(
            "successful transcription is already cached",
        ));
    }
    if old_attempts >= 3
        || request.transcription["attempts"].as_u64() != Some(old_attempts + 1)
        || !matches!(
            request.transcription["status"].as_str(),
            Some("ready" | "failed" | "unavailable")
        )
    {
        return Err(StoreError::InvalidInput(
            "transcription retry limit or state is invalid",
        ));
    }
    voice["transcript"] = json!(request.transcript);
    voice["transcription"] = request.transcription;
    if !crate::chat_sync::voice::valid_transcription(voice) {
        return Err(StoreError::InvalidInput(
            "transcription metadata is invalid",
        ));
    }
    content["blocks"][0]["text"] = json!(crate::chat_sync::voice::replace_body_text(
        &content,
        request.transcript
    ));
    query("UPDATE cloud_chat_messages SET content=$2,version=version+1,edited_at=now() WHERE message_id=$1")
        .bind(message_id).bind(&content).execute(&mut *transaction).await?;
    let message = load_message(&mut transaction, message_id).await?;
    fanout_message_sync_event(&mut transaction, "message.updated", &message).await?;
    transaction.commit().await?;
    Ok(message)
}
