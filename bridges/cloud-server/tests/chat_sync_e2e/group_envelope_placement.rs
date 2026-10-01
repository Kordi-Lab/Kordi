//! Group envelopes must stay at the start of the first text block, so edits,
//! voice transcripts, and new messages cannot move one into place.

use super::*;

#[tokio::test]
async fn edits_cannot_join_message_blocks_into_an_envelope() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping split envelope edit test");
        return;
    };
    let group = group(&pool, "edit-split").await;
    let named_owner = envelope(
        &group,
        &group.owner,
        json!({ "id": "e1", "senderAccountId": group.owner, "senderKind": "human",
            "senderDisplayName": "Owner", "text": "hello", "createdAtMs": 1 }),
    );
    let tail = named_owner
        .strip_prefix("kordi-cloud-")
        .unwrap()
        .to_string();
    let sent = store::send_message(
        &pool,
        &group.member,
        group.conversation_id,
        request(json!({ "schema": 1, "blocks": [
            { "type": "text", "text": "hello" },
            { "type": "text", "text": tail }
        ] })),
    )
    .await
    .expect("plain two-block message");
    let edited = store::edit_message(
        &pool,
        &group.member,
        group.conversation_id,
        sent.value.id,
        UpdateMessageRequest {
            expected_version: sent.value.version,
            text: "kordi-cloud-".to_string(),
        },
    )
    .await;
    assert!(matches!(edited, Err(StoreError::InvalidInput(_))));
    let stored = store::load_message_snapshot(&pool, sent.value.id)
        .await
        .expect("load message");
    assert_eq!(stored.version, sent.value.version);
    assert!(!joined_text(&stored.content).starts_with(GROUP_PREFIX));

    // An ordinary edit of the same message still works.
    let edited = store::edit_message(
        &pool,
        &group.member,
        group.conversation_id,
        sent.value.id,
        UpdateMessageRequest {
            expected_version: sent.value.version,
            text: "hi there".to_string(),
        },
    )
    .await
    .expect("plain edit");
    assert_eq!(edited.content["blocks"][0]["text"], "hi there");
}

async fn voice_message(
    pool: &PgPool,
    group: &Group,
    sender: &str,
) -> (
    kordi_cloud_server::chat_sync::models::MessageSnapshot,
    String,
) {
    let media = format!("att-{}", Uuid::new_v4());
    query(
        "INSERT INTO cloud_attachments(attachment_id, owner_account_id, object_key, created_at, \
         finalized_at, content_type, detected_content_type, size_bytes) \
         VALUES ($1, $2, $1, $3, $3, 'audio/mp4', 'audio/mp4', 2048)",
    )
    .bind(&media)
    .bind(sender)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .expect("voice attachment");
    let sent = store::send_message(
        pool,
        sender,
        group.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "voice".to_string(),
            reply_to_message_id: None,
            attachment_ids: vec![media.clone()],
            content: json!({ "schema": 1, "blocks": [
                { "type": "text", "text": "" },
                { "type": "voice", "mediaId": media, "mimeType": "audio/mp4",
                  "durationMs": 2000, "waveformSamples": [0.2], "transcript": "",
                  "transcription": { "status": "failed", "sourceVersion": media,
                    "engine": "apple-speech-v1", "attempts": 1 } }
            ] }),
        },
    )
    .await
    .expect("voice message")
    .value;
    (sent, media)
}

fn transcript_request(
    sent: &kordi_cloud_server::chat_sync::models::MessageSnapshot,
    media: &str,
    transcript: String,
) -> store::UpdateVoiceTranscriptRequest {
    store::UpdateVoiceTranscriptRequest {
        expected_version: sent.version,
        media_id: media.to_string(),
        transcript,
        transcription: json!({ "status": "ready", "sourceVersion": media,
            "engine": "apple-speech-v1", "language": "en-US", "attempts": 2 }),
    }
}

#[tokio::test]
async fn voice_transcripts_cannot_replace_a_plain_body_with_an_envelope() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping voice transcript envelope test");
        return;
    };
    let group = group(&pool, "voice-envelope").await;
    let owner_agent = custom_agent(&pool, &group.owner, "Owner Research", "active").await;
    let (sent, media) = voice_message(&pool, &group, &group.member).await;
    let named_agent = envelope(
        &group,
        &group.member,
        json!({ "id": "v1", "senderAccountId": group.member, "senderKind": "agent",
            "senderAgentId": owner_agent, "senderDisplayName": "Owner Research",
            "senderOwnerName": "Owner", "senderOwnerAccountId": group.owner,
            "text": "approved", "createdAtMs": 1 }),
    );
    let updated = store::update_voice_transcript(
        &pool,
        &group.member,
        group.conversation_id,
        sent.id,
        transcript_request(&sent, &media, named_agent),
    )
    .await;
    assert!(matches!(updated, Err(StoreError::InvalidInput(_))));

    let updated = store::update_voice_transcript(
        &pool,
        &group.member,
        group.conversation_id,
        sent.id,
        transcript_request(&sent, &media, "Meet at noon".to_string()),
    )
    .await
    .expect("ordinary transcript");
    assert_eq!(updated.content["blocks"][0]["text"], "Meet at noon");
}

#[tokio::test]
async fn group_envelopes_outside_the_first_text_block_are_refused() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping group envelope placement test");
        return;
    };
    let group = group(&pool, "envelope-placement").await;
    let body = envelope(
        &group,
        &group.owner,
        json!({ "id": "p1", "senderAccountId": group.owner, "text": "hi", "createdAtMs": 1 }),
    );
    let (head, tail) = body.split_at(10);
    for content in [
        json!({ "schema": 1, "blocks": [
            { "type": "text", "text": "" }, { "type": "text", "text": body }
        ] }),
        json!({ "schema": 1, "blocks": [
            { "type": "text", "text": head }, { "type": "text", "text": tail }
        ] }),
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": format!(" {body}") }] }),
        json!({ "schema": 1, "blocks": [{ "type": "text", "text": format!("{body}=") }] }),
    ] {
        assert!(
            matches!(
                store::send_message(
                    &pool,
                    &group.member,
                    group.conversation_id,
                    request(content.clone())
                )
                .await,
                Err(StoreError::InvalidInput(_))
            ),
            "{content}"
        );
    }
}
