use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

async fn photo_message(
    pool: &PgPool,
    owner: &str,
    conversation: Uuid,
    caption: &str,
) -> (
    store::InsertOutcome<kordi_cloud_server::chat_sync::models::MessageSnapshot>,
    Vec<String>,
) {
    let ids: Vec<String> = (0..2).map(|_| format!("att-{}", Uuid::new_v4())).collect();
    for id in &ids {
        query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at,content_type,detected_content_type,size_bytes) VALUES($1,$2,$1,$3,$3,'image/png','image/png',100)")
            .bind(id).bind(owner).bind(chrono::Utc::now().to_rfc3339()).execute(pool).await.unwrap();
    }
    let attachments: Vec<_> = ids.iter().map(|id| json!({
        "attachmentId":id,"name":"Photo.png","kind":"image","mimeType":"image/png","sizeBytes":100
    })).collect();
    let payload =
        json!({"schemaVersion":1,"kind":"message","text":caption,"attachments":attachments});
    let encoded = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
    );
    let sent = store::send_message(pool, owner, conversation, SendMessageRequest {
        client_message_id: Uuid::now_v7(), kind:"text".into(),
        content:json!({"schema":1,"blocks":[{"type":"text","text":encoded}],"legacy_attachments":attachments}),
        reply_to_message_id:None, attachment_ids:ids.clone(),
    }).await.unwrap();
    (sent, ids)
}

#[tokio::test]
async fn individual_photos_have_independent_reactions_and_deletions() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "photo-owner").await;
    let peer = account(&pool, "photo-peer").await;
    let outsider = account(&pool, "photo-outsider").await;
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
    let (sent, ids) = photo_message(&pool, &owner, conversation.id, "Keep this caption.").await;
    let message = sent.value;
    let one = store::set_attachment_reaction(
        &pool,
        &peer,
        conversation.id,
        message.client_message_id,
        &ids[0],
        "👍",
        true,
    )
    .await
    .unwrap();
    assert!(one.reactions.is_empty());
    assert_eq!(one.attachment_reactions.len(), 1);
    let two = store::set_attachment_reaction(
        &pool,
        &owner,
        conversation.id,
        message.id,
        &ids[1],
        "👍",
        true,
    )
    .await
    .unwrap();
    assert_eq!(two.attachment_reactions.len(), 2);
    assert!(matches!(
        store::set_attachment_reaction(
            &pool,
            &outsider,
            conversation.id,
            message.id,
            &ids[0],
            "👍",
            true
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store::set_attachment_reaction(
            &pool,
            &peer,
            conversation.id,
            message.id,
            "unrelated-photo",
            "👍",
            true
        )
        .await,
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store::delete_attachment(&pool, &peer, conversation.id, message.id, &ids[0], true).await,
        Err(StoreError::Forbidden)
    ));

    let cursor = sync_head(&pool, &peer).await.0;
    let hidden =
        store::delete_attachment(&pool, &peer, conversation.id, message.id, &ids[0], false)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(hidden.attachment_ids, vec![ids[1].clone()]);
    assert_eq!(hidden.attachment_reactions.len(), 1);
    assert_eq!(hidden.attachment_reactions[0].attachment_id, ids[1]);
    assert_eq!(
        hidden.content["legacy_attachments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let encoded = hidden.content["blocks"][0]["text"]
        .as_str()
        .unwrap()
        .strip_prefix("kordi-cloud-message:")
        .unwrap();
    let payload: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    assert_eq!(payload["text"], "Keep this caption.");
    assert_eq!(payload["attachments"].as_array().unwrap().len(), 1);
    let head = sync_head(&pool, &peer).await.0;
    store::delete_attachment(&pool, &peer, conversation.id, message.id, &ids[0], false)
        .await
        .unwrap();
    assert_eq!(
        sync_head(&pool, &peer).await.0,
        head,
        "Repeating a private hide must not create more events."
    );

    // Neither a normal reaction, a history load, bootstrap, nor replay may resurrect a hidden photo.
    store::set_reaction(&pool, &owner, conversation.id, message.id, "❤️", true)
        .await
        .unwrap();
    let history = store::history(&pool, &peer, conversation.id, None, None)
        .await
        .unwrap();
    assert_eq!(history.messages[0].attachment_ids, vec![ids[1].clone()]);
    let bootstrap = store::bootstrap(&pool, &peer).await.unwrap();
    assert_eq!(
        bootstrap.latest_messages[0].attachment_ids,
        vec![ids[1].clone()]
    );
    let sync = store::sync_batch(&pool, &peer, cursor, Some(100))
        .await
        .unwrap();
    for event in sync.events {
        if let Some(message) = event.payload.get("message") {
            assert!(!message["attachment_ids"]
                .as_array()
                .unwrap()
                .contains(&json!(ids[0])));
        }
    }
    let owner_history = store::history(&pool, &owner, conversation.id, None, None)
        .await
        .unwrap();
    assert_eq!(owner_history.messages[0].attachment_ids.len(), 2);

    let removed =
        store::delete_attachment(&pool, &owner, conversation.id, message.id, &ids[1], true)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(removed.attachment_ids, vec![ids[0].clone()]);
    assert_eq!(removed.attachment_reactions.len(), 1);
    let peer_history = store::history(&pool, &peer, conversation.id, None, None)
        .await
        .unwrap();
    assert!(
        peer_history.messages[0].attachment_ids.is_empty(),
        "The caption remains, but private hides stay private."
    );
    assert!(
        store::delete_attachment(&pool, &owner, conversation.id, message.id, &ids[0], true)
            .await
            .unwrap()
            .is_some(),
        "Deleting the last photo must retain a caption."
    );
    assert!(store::history(&pool, &owner, conversation.id, None, None)
        .await
        .unwrap()
        .messages[0]
        .attachment_ids
        .is_empty());

    let (empty, empty_ids) = photo_message(&pool, &owner, conversation.id, "").await;
    assert!(store::delete_attachment(
        &pool,
        &owner,
        conversation.id,
        empty.value.id,
        &empty_ids[0],
        true
    )
    .await
    .unwrap()
    .is_some());
    assert!(
        store::delete_attachment(
            &pool,
            &owner,
            conversation.id,
            empty.value.id,
            &empty_ids[1],
            true
        )
        .await
        .unwrap()
        .is_none(),
        "An empty photo-only message is removed with its last photo."
    );
    assert!(store::history(&pool, &owner, conversation.id, None, None)
        .await
        .unwrap()
        .messages
        .iter()
        .all(|item| item.id != empty.value.id));
}

#[tokio::test]
async fn unchanged_edits_do_not_restore_the_senders_hidden_photo() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "photo-edit-owner").await;
    let peer = account(&pool, "photo-edit-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let conversation = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &peer),
            member_account_ids: vec![peer],
        },
    )
    .await
    .unwrap()
    .value;
    let (sent, ids) = photo_message(&pool, &owner, conversation.id, "Unchanged caption").await;
    store::delete_attachment(
        &pool,
        &owner,
        conversation.id,
        sent.value.id,
        &ids[0],
        false,
    )
    .await
    .unwrap();
    let edited = store::edit_message(
        &pool,
        &owner,
        conversation.id,
        sent.value.id,
        UpdateMessageRequest {
            expected_version: sent.value.version,
            text: "Unchanged caption".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(edited.attachment_ids, vec![ids[1].clone()]);
    let conflict = store::edit_message(
        &pool,
        &owner,
        conversation.id,
        sent.value.id,
        UpdateMessageRequest {
            expected_version: sent.value.version + 1,
            text: "New caption".into(),
        },
    )
    .await;
    match conflict {
        Err(StoreError::MessageVersionConflict(current)) => {
            assert_eq!(current.attachment_ids, vec![ids[1].clone()])
        }
        _ => panic!("expected a version conflict with a viewer-filtered message"),
    }
}

#[tokio::test]
async fn globally_removing_the_last_visible_photo_hides_empty_private_projections() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "photo-empty-owner").await;
    let peer = account(&pool, "photo-empty-peer").await;
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
    let (sent, ids) = photo_message(&pool, &owner, conversation.id, "").await;
    store::delete_attachment(&pool, &peer, conversation.id, sent.value.id, &ids[0], false)
        .await
        .unwrap();
    store::delete_attachment(&pool, &owner, conversation.id, sent.value.id, &ids[1], true)
        .await
        .unwrap();
    assert!(store::history(&pool, &peer, conversation.id, None, None)
        .await
        .unwrap()
        .messages
        .is_empty());
    assert!(store::bootstrap(&pool, &peer)
        .await
        .unwrap()
        .latest_messages
        .iter()
        .all(|item| item.id != sent.value.id));
    assert_eq!(
        store::history(&pool, &owner, conversation.id, None, None)
            .await
            .unwrap()
            .messages[0]
            .attachment_ids,
        vec![ids[0].clone()]
    );
}
