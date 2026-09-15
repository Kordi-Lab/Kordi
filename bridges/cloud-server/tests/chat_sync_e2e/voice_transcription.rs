use super::*;

#[tokio::test]
async fn voice_retry_is_versioned_idempotent_and_authorized() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "voice-owner").await;
    let peer = account(&pool, "voice-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let conversation = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &peer),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    let media = format!("att-{}", Uuid::new_v4());
    query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at,content_type,detected_content_type,size_bytes) VALUES($1,$2,$1,$3,$3,'audio/mp4','audio/mp4',2048)")
        .bind(&media).bind(&owner).bind(chrono::Utc::now().to_rfc3339()).execute(&pool).await.unwrap();
    let sent = store::send_message(&pool, &owner, conversation.id, SendMessageRequest {
        client_message_id: Uuid::now_v7(), kind: "voice".into(), reply_to_message_id: None,
        attachment_ids: vec![media.clone()], content: json!({"schema":1,"blocks":[
            {"type":"text","text":"Transcription unavailable."},
            {"type":"voice","mediaId":media,"mimeType":"audio/mp4","durationMs":2000,"waveformSamples":[0.2],"transcript":"",
             "transcription":{"status":"failed","sourceVersion":media,"engine":"apple-speech-v1","attempts":1}}
        ]}),
    }).await.unwrap().value;
    let request = |version, attempts, text: &str| store::UpdateVoiceTranscriptRequest {
        expected_version: version,
        media_id: media.clone(),
        transcript: text.into(),
        transcription: json!({"status":if text.is_empty(){"failed"}else{"ready"},"sourceVersion":media,
            "engine":"apple-speech-v1","language":"en-US","attempts":attempts}),
    };
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &peer,
            conversation.id,
            sent.id,
            request(1, 2, "Hello")
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &owner,
            Uuid::now_v7(),
            sent.id,
            request(1, 2, "Hello")
        )
        .await,
        Err(StoreError::NotFound)
    ));
    let mut wrong_source = request(1, 2, "Hello");
    wrong_source.transcription["sourceVersion"] = json!("replaced-audio");
    assert!(matches!(
        store::update_voice_transcript(&pool, &owner, conversation.id, sent.id, wrong_source).await,
        Err(StoreError::InvalidInput(_))
    ));
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation.id).bind(&owner).execute(&pool).await.unwrap();
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &owner,
            conversation.id,
            sent.id,
            request(1, 2, "Hello")
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    query("UPDATE cloud_chat_conversation_members SET membership_state='active' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation.id).bind(&owner).execute(&pool).await.unwrap();
    let failed =
        store::update_voice_transcript(&pool, &owner, conversation.id, sent.id, request(1, 2, ""))
            .await
            .unwrap();
    assert_eq!(failed.version, 2);
    assert_eq!(failed.id, sent.id);
    assert_eq!(failed.conversation_sequence, sent.conversation_sequence);
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &owner,
            conversation.id,
            sent.id,
            request(1, 3, "Hello")
        )
        .await,
        Err(StoreError::MessageVersionConflict(_))
    ));
    let ready = store::update_voice_transcript(
        &pool,
        &owner,
        conversation.id,
        sent.id,
        request(2, 3, "Hello"),
    )
    .await
    .unwrap();
    assert_eq!(ready.version, 3);
    assert_eq!(ready.attachment_ids, sent.attachment_ids);
    assert_eq!(ready.content["blocks"][0]["text"], "Hello");
    let duplicate = store::update_voice_transcript(
        &pool,
        &owner,
        conversation.id,
        sent.id,
        request(2, 3, "Hello"),
    )
    .await
    .unwrap();
    assert_eq!(duplicate.version, 3);
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &owner,
            conversation.id,
            sent.id,
            request(3, 4, "Different")
        )
        .await,
        Err(StoreError::InvalidInput(_))
    ));
    store::delete_message(&pool, &owner, conversation.id, sent.id, false)
        .await
        .unwrap();
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &owner,
            conversation.id,
            sent.id,
            request(2, 3, "Hello")
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    store::delete_message(&pool, &owner, conversation.id, sent.id, true)
        .await
        .unwrap();
    assert!(matches!(
        store::update_voice_transcript(
            &pool,
            &owner,
            conversation.id,
            sent.id,
            request(2, 3, "Hello")
        )
        .await,
        Err(StoreError::Forbidden)
    ));
}
