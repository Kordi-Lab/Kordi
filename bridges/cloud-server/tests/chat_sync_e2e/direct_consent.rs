use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

fn requires_contact(result: Result<impl Sized, StoreError>) -> bool {
    matches!(
        result,
        Err(StoreError::RelationshipRequired(message)) if message == store::DIRECT_REQUIRES_CONTACT
    )
}

fn text(body: &str) -> SendMessageRequest {
    SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: content(body),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    }
}

fn direct(peer: &str, session: String) -> CreateConversationRequest {
    CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Direct,
        shared_title: None,
        client_session_id: session,
        member_account_ids: vec![peer.to_string()],
    }
}

async fn remove_contact(pool: &PgPool, left: &str, right: &str) {
    query(
        "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
         OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(left)
    .bind(right)
    .execute(pool)
    .await
    .expect("remove contact");
}

async fn block(pool: &PgPool, blocker: &str, blocked: &str) {
    query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(blocker)
    .bind(blocked)
    .execute(pool)
    .await
    .expect("block account");
}

async fn attachment(pool: &PgPool, owner: &str, content_type: &str) -> String {
    let id = format!("att-{}", Uuid::new_v4());
    query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at,content_type,detected_content_type,size_bytes) VALUES($1,$2,$1,$3,$3,$4,$4,100)")
        .bind(&id).bind(owner).bind(chrono::Utc::now().to_rfc3339()).bind(content_type)
        .execute(pool).await.expect("insert attachment");
    id
}

#[tokio::test]
async fn direct_conversations_start_only_between_mutual_contacts() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "consent-direct-owner").await;
    let peer = account(&pool, "consent-direct-peer").await;
    let session = direct_person_session_id(&owner, &peer);

    assert!(requires_contact(
        store::create_conversation(&pool, &owner, direct(&peer, session.clone())).await
    ));
    // A single row from an older one-sided add grants nothing.
    query(
        "INSERT INTO cloud_contacts(account_id, peer_account_id, created_at) VALUES ($1, $2, $3)",
    )
    .bind(&owner)
    .bind(&peer)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    assert!(requires_contact(
        store::create_conversation(&pool, &owner, direct(&peer, session.clone())).await
    ));
    remove_contact(&pool, &owner, &peer).await;
    connect_accounts(&pool, &owner, &peer).await;
    block(&pool, &peer, &owner).await;
    assert!(requires_contact(
        store::create_conversation(&pool, &owner, direct(&peer, session.clone())).await
    ));
    query("DELETE FROM cloud_account_blocks WHERE blocker_account_id = $1")
        .bind(&peer)
        .execute(&pool)
        .await
        .unwrap();
    let created = store::create_conversation(&pool, &owner, direct(&peer, session.clone()))
        .await
        .expect("contacts can start a direct chat");
    assert!(created.inserted);

    // Reopening an existing chat still works after removal; writing does not.
    remove_contact(&pool, &owner, &peer).await;
    let reopened = store::create_conversation(&pool, &peer, direct(&owner, session))
        .await
        .expect("reopen the existing chat");
    assert_eq!(reopened.value.id, created.value.id);
    assert!(requires_contact(
        store::send_message(&pool, &peer, created.value.id, text("still there?")).await
    ));
}

#[tokio::test]
async fn removing_a_contact_makes_their_direct_chat_read_only() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "consent-readonly-owner").await;
    let peer = account(&pool, "consent-readonly-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let conversation = store::create_conversation(
        &pool,
        &owner,
        direct(&peer, direct_person_session_id(&owner, &peer)),
    )
    .await
    .unwrap()
    .value;
    let sent = store::send_message(&pool, &owner, conversation.id, text("hello"))
        .await
        .unwrap()
        .value;
    let photo = attachment(&pool, &owner, "image/png").await;
    let attachments = json!([{
        "attachmentId": photo, "name": "Photo.png", "kind": "image",
        "mimeType": "image/png", "sizeBytes": 100
    }]);
    let encoded = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "schemaVersion": 1, "kind": "message", "text": "photo", "attachments": attachments
            }))
            .unwrap()
        )
    );
    let photo_message = store::send_message(
        &pool,
        &owner,
        conversation.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": encoded}],
                            "legacy_attachments": attachments}),
            reply_to_message_id: None,
            attachment_ids: vec![photo.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    let voice = attachment(&pool, &owner, "audio/mp4").await;
    let voice_message = store::send_message(
        &pool,
        &owner,
        conversation.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "voice".into(),
            reply_to_message_id: None,
            attachment_ids: vec![voice.clone()],
            content: json!({"schema": 1, "blocks": [
                {"type": "text", "text": "Transcription unavailable."},
                {"type": "voice", "mediaId": voice, "mimeType": "audio/mp4", "durationMs": 2000,
                 "waveformSamples": [0.2], "transcript": "",
                 "transcription": {"status": "failed", "sourceVersion": voice,
                                   "engine": "apple-speech-v1", "attempts": 1}}
            ]}),
        },
    )
    .await
    .unwrap()
    .value;
    store::set_reaction(&pool, &peer, conversation.id, sent.id, "👍", true)
        .await
        .unwrap();
    store::set_attachment_reaction(
        &pool,
        &peer,
        conversation.id,
        photo_message.id,
        &photo,
        "👍",
        true,
    )
    .await
    .unwrap();

    remove_contact(&pool, &owner, &peer).await;

    for account_id in [&owner, &peer] {
        assert!(requires_contact(
            store::send_message(&pool, account_id, conversation.id, text("after")).await
        ));
    }
    assert!(requires_contact(
        store::edit_message(
            &pool,
            &owner,
            conversation.id,
            sent.id,
            UpdateMessageRequest {
                expected_version: sent.version,
                text: "edited".to_string(),
            },
        )
        .await
    ));
    assert!(requires_contact(
        store::set_reaction(&pool, &owner, conversation.id, sent.id, "🎉", true).await
    ));
    assert!(requires_contact(
        store::set_attachment_reaction(
            &pool,
            &owner,
            conversation.id,
            photo_message.id,
            &photo,
            "🎉",
            true,
        )
        .await
    ));
    assert!(requires_contact(
        store::update_voice_transcript(
            &pool,
            &owner,
            conversation.id,
            voice_message.id,
            store::UpdateVoiceTranscriptRequest {
                expected_version: voice_message.version,
                media_id: voice.clone(),
                transcript: "Hello".into(),
                transcription: json!({"status": "ready", "sourceVersion": voice,
                    "engine": "apple-speech-v1", "language": "en-US", "attempts": 2}),
            },
        )
        .await
    ));

    // History stays readable, and taking things back stays possible.
    for account_id in [&owner, &peer] {
        let history = store::history(&pool, account_id, conversation.id, None, None)
            .await
            .expect("history stays readable");
        assert_eq!(history.messages.len(), 3);
    }
    let unreacted = store::set_reaction(&pool, &peer, conversation.id, sent.id, "👍", false)
        .await
        .expect("remove own reaction");
    assert!(unreacted.reactions.is_empty());
    store::set_attachment_reaction(
        &pool,
        &peer,
        conversation.id,
        photo_message.id,
        &photo,
        "👍",
        false,
    )
    .await
    .expect("remove own photo reaction");
    store::delete_message(&pool, &owner, conversation.id, sent.id, true)
        .await
        .expect("delete own message");

    // Contacts again: writing works.
    connect_accounts(&pool, &owner, &peer).await;
    store::send_message(&pool, &peer, conversation.id, text("welcome back"))
        .await
        .expect("contacts can write again");
    // A block in either direction ends it, even with both rows present.
    block(&pool, &owner, &peer).await;
    assert!(requires_contact(
        store::send_message(&pool, &peer, conversation.id, text("blocked")).await
    ));
    assert!(requires_contact(
        store::send_message(&pool, &owner, conversation.id, text("blocker")).await
    ));
}

#[tokio::test]
async fn support_chats_are_exempt_and_agent_chats_follow_the_contact_rule() {
    let Some(pool) = try_pool().await else { return };
    let user = account(&pool, "consent-support-user").await;
    let support_owner = account(&pool, "consent-support-owner").await;
    let support = store::create_conversation_with_trusted_peer(
        &pool,
        &user,
        direct(
            &support_owner,
            format!("session:direct-system-agent:{user}:support-agent"),
        ),
        Some(&support_owner),
    )
    .await
    .expect("support chats need no contact");
    store::send_message(&pool, &user, support.value.id, text("help"))
        .await
        .expect("users can write to support");
    store::send_message(&pool, &support_owner, support.value.id, text("hi"))
        .await
        .expect("support can answer");

    let owner = account(&pool, "consent-agent-owner").await;
    let agent_session = format!("session:direct-agent:{owner}:cloud-agent:{owner}");
    assert!(requires_contact(
        store::create_conversation(&pool, &user, direct(&owner, agent_session.clone())).await
    ));
    connect_accounts(&pool, &user, &owner).await;
    let agent_chat = store::create_conversation(&pool, &user, direct(&owner, agent_session))
        .await
        .expect("contacts can open each other's agent chat")
        .value;
    store::send_message(&pool, &user, agent_chat.id, text("question"))
        .await
        .unwrap();
    remove_contact(&pool, &user, &owner).await;
    assert!(requires_contact(
        store::send_message(&pool, &user, agent_chat.id, text("another")).await
    ));
}

fn shared_ai(members: Vec<String>) -> CreateConversationRequest {
    CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Ai,
        shared_title: None,
        client_session_id: format!("session:self-agent:{}", Uuid::now_v7()),
        member_account_ids: members,
    }
}

fn title(expected_version: i32, value: &str) -> UpdateConversationTitleRequest {
    UpdateConversationTitleRequest {
        client_operation_id: Uuid::now_v7(),
        expected_version,
        shared_title: Some(value.to_string()),
    }
}

async fn sync_events(pool: &PgPool, account_id: &str, conversation_id: Uuid) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2",
    )
    .bind(account_id)
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn ai_conversations_with_another_person_follow_the_contact_rule() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "consent-ai-owner").await;
    let peer = account(&pool, "consent-ai-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let shared = store::create_conversation(&pool, &owner, shared_ai(vec![peer.clone()]))
        .await
        .expect("contacts can share an AI conversation")
        .value;
    let own = store::create_conversation(&pool, &owner, shared_ai(Vec::new()))
        .await
        .expect("an AI conversation of one's own")
        .value;
    let sent = store::send_message(&pool, &owner, shared.id, text("hello"))
        .await
        .expect("contacts can write")
        .value;

    // Nobody can leave an AI conversation, so removal must stop writing.
    remove_contact(&pool, &owner, &peer).await;
    for account_id in [&owner, &peer] {
        assert!(requires_contact(
            store::send_message(&pool, account_id, shared.id, text("after removal")).await
        ));
    }
    assert!(requires_contact(
        store::edit_message(
            &pool,
            &owner,
            shared.id,
            sent.id,
            UpdateMessageRequest {
                expected_version: sent.version,
                text: "edited".to_string(),
            },
        )
        .await
    ));
    assert!(requires_contact(
        store::set_reaction(&pool, &peer, shared.id, sent.id, "👍", true).await
    ));
    assert!(requires_contact(
        store::update_shared_title(&pool, &owner, shared.id, title(shared.version, "Plans")).await
    ));
    for account_id in [&owner, &peer] {
        let history = store::history(&pool, account_id, shared.id, None, None)
            .await
            .expect("history stays readable");
        assert_eq!(history.messages.len(), 1);
    }
    store::send_message(&pool, &owner, own.id, text("note to self"))
        .await
        .expect("an AI conversation of one's own needs nobody's consent");

    // Contacts again: writing works until a block in either direction.
    connect_accounts(&pool, &owner, &peer).await;
    store::send_message(&pool, &peer, shared.id, text("welcome back"))
        .await
        .expect("contacts can write again");
    block(&pool, &peer, &owner).await;
    for account_id in [&owner, &peer] {
        assert!(requires_contact(
            store::send_message(&pool, account_id, shared.id, text("after block")).await
        ));
    }
    store::send_message(&pool, &owner, own.id, text("still mine"))
        .await
        .expect("a block leaves one's own AI conversations alone");
}

#[tokio::test]
async fn shared_titles_outside_groups_follow_the_contact_rule() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "consent-title-owner").await;
    let peer = account(&pool, "consent-title-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let chat = store::create_conversation(
        &pool,
        &owner,
        direct(&peer, direct_person_session_id(&owner, &peer)),
    )
    .await
    .unwrap()
    .value;
    let (group, _) = super::group_consent::create_group(&pool, &owner, &[&peer]).await;
    let renamed = store::update_shared_title(&pool, &owner, chat.id, title(chat.version, "Plans"))
        .await
        .expect("contacts can name their chat");

    block(&pool, &peer, &owner).await;
    let before = sync_events(&pool, &peer, chat.id).await;
    assert!(requires_contact(
        store::update_shared_title(&pool, &owner, chat.id, title(renamed.version, "Again")).await
    ));
    assert_eq!(sync_events(&pool, &peer, chat.id).await, before);

    // Groups keep their own rules: the owner can still rename a shared group.
    let (group_version,): (i32,) =
        query_as("SELECT version FROM cloud_chat_conversations WHERE conversation_id = $1")
            .bind(group)
            .fetch_one(&pool)
            .await
            .unwrap();
    store::update_shared_title(&pool, &owner, group, title(group_version, "Team"))
        .await
        .expect("group titles do not need contacts");
}
