use super::*;

#[tokio::test]
async fn live_photo_send_is_atomic_authorized_and_idempotent() {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = init_pool(&url)
        .await
        .expect("initialize isolated Live Photo test database");
    let owner = account(&pool, "live-owner").await;
    let peer = account(&pool, "live-peer").await;
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
    let ids: Vec<String> = (0..3).map(|_| format!("att-{}", Uuid::new_v4())).collect();
    let types = ["image/heic", "video/quicktime", "video/mp4"];
    for (id, mime) in ids.iter().zip(types) {
        query("INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, created_at, finalized_at, content_type, detected_content_type, size_bytes) VALUES ($1,$2,$1,$3,$3,$4,$4,100)")
            .bind(id).bind(&owner).bind(chrono::Utc::now().to_rfc3339()).bind(mime).execute(&pool).await.unwrap();
    }
    let metadata = json!({ "legacy_attachments": [{
        "attachmentId": ids[0], "name": "Photo.heic", "kind": "image", "mimeType": "image/heic", "sizeBytes": 100,
        "livePhoto": {
            "video": { "attachmentId": ids[1], "name": "Live.mov", "mimeType": "video/quicktime", "sizeBytes": 100 },
            "playback": { "attachmentId": ids[2], "name": "Live.mp4", "mimeType": "video/mp4", "sizeBytes": 100 }
        }
    }], "schema": 1, "blocks": [{ "type": "text", "text": "" }] });
    let request = SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".into(),
        content: metadata.clone(),
        reply_to_message_id: None,
        attachment_ids: ids.clone(),
    };
    // No message may be published if any component is missing, unfinalized, or owned by someone else.
    for unavailable in &ids {
        query("UPDATE cloud_attachments SET finalized_at = NULL WHERE attachment_id = $1")
            .bind(unavailable)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            store::send_message(&pool, &owner, conversation.id, request.clone())
                .await
                .is_err()
        );
        query("UPDATE cloud_attachments SET finalized_at = $2 WHERE attachment_id = $1")
            .bind(unavailable)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&pool)
            .await
            .unwrap();
    }
    query("UPDATE cloud_attachments SET owner_account_id = $2 WHERE attachment_id = $1")
        .bind(&ids[1])
        .bind(&peer)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        store::send_message(&pool, &owner, conversation.id, request.clone())
            .await
            .is_err()
    );
    query("UPDATE cloud_attachments SET owner_account_id = $2 WHERE attachment_id = $1")
        .bind(&ids[1])
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let sent = store::send_message(&pool, &owner, conversation.id, request.clone())
        .await
        .unwrap();
    assert!(sent.inserted);
    assert_eq!(sent.value.conversation_sequence, 1);
    let duplicate = store::send_message(&pool, &owner, conversation.id, request)
        .await
        .unwrap();
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.value.id, sent.value.id);
    let reloaded = store::load_message_snapshot(&pool, sent.value.id)
        .await
        .unwrap();
    assert_eq!(reloaded.content, metadata);
    assert_eq!(reloaded.attachment_ids, ids);
    let linked: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_message_attachments WHERE message_id = $1")
            .bind(sent.value.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(linked.0, 3);
}
