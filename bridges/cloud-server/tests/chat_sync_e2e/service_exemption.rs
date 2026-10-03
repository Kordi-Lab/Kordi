//! Kordi Support chats need no contact because their other member is a Kordi
//! service account. The exemption follows that membership, never a session id
//! a client chose, so no other chat can borrow it.
use super::direct_consent::{
    attachment, block, direct, remove_contact, requires_contact, shared_ai, text, title,
};
use super::*;
use kordi_cloud_server::chat_sync::store::attachment_backfill::{
    backfill_missing_images, MissingImageInput,
};

/// An account that owns a system-managed agent, as Kordi Support's owner does.
async fn service_account(pool: &PgPool, label: &str) -> String {
    let account_id = account(pool, label).await;
    query(
        "INSERT INTO cloud_agent_definitions(agent_id, owner_account_id, status, name, role, \
         system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
         avatar_renderer_version, avatar_version, avatar_updated_at, is_system_managed) \
         VALUES ($1, $2, 'active', 'Support', 'support', 'test', 'test', 'test', 'generated', \
         'thumbs', $1, 'test', 1, 'test', TRUE)",
    )
    .bind(format!("cloud_agent_{}", Uuid::new_v4().simple()))
    .bind(&account_id)
    .execute(pool)
    .await
    .expect("register a service account");
    account_id
}

fn support_session(user: &str) -> String {
    format!("session:direct-system-agent:{user}:support-agent")
}

#[tokio::test]
async fn support_chats_are_exempt_and_agent_chats_follow_the_contact_rule() {
    let Some(pool) = try_pool().await else { return };
    let user = account(&pool, "consent-support-user").await;
    let support_owner = service_account(&pool, "consent-support-owner").await;
    let support = store::create_conversation_with_trusted_peer(
        &pool,
        &user,
        direct(&support_owner, support_session(&user)),
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

    // The session id alone exempts nothing: the other member must be a
    // Kordi service account.
    let impostor = account(&pool, "consent-support-impostor").await;
    let other_user = account(&pool, "consent-support-other").await;
    let borrowed = store::create_conversation_with_trusted_peer(
        &pool,
        &other_user,
        direct(&impostor, support_session(&other_user)),
        Some(&impostor),
    )
    .await
    .expect("create a chat under a support session id")
    .value;
    for account_id in [&other_user, &impostor] {
        assert!(requires_contact(
            store::send_message(&pool, account_id, borrowed.id, text("hello")).await
        ));
    }

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

#[tokio::test]
async fn shared_ai_chats_cannot_borrow_the_support_exemption() {
    let Some(pool) = try_pool().await else { return };
    let victim = account(&pool, "consent-borrow-victim").await;
    let abuser = account(&pool, "consent-borrow-abuser").await;
    connect_accounts(&pool, &victim, &abuser).await;
    let mut borrowed = shared_ai(vec![victim.clone()]);
    for prefix in [
        "session:direct-system-agent:",
        "session:direct-person:",
        "session:direct-agent:",
    ] {
        borrowed.client_operation_id = Uuid::now_v7();
        borrowed.client_session_id = format!("{prefix}{abuser}:{}", Uuid::now_v7());
        assert!(matches!(
            store::create_conversation(&pool, &abuser, borrowed.clone()).await,
            Err(StoreError::InvalidInput(_))
        ));
    }

    // A chat created under such an id before this check is still gated.
    let shared = store::create_conversation(&pool, &abuser, shared_ai(vec![victim.clone()]))
        .await
        .expect("contacts can share an AI chat")
        .value;
    query("UPDATE cloud_chat_conversations SET legacy_session_id = $2 WHERE conversation_id = $1")
        .bind(shared.id)
        .bind(support_session(&abuser))
        .execute(&pool)
        .await
        .unwrap();
    let sent = store::send_message(&pool, &abuser, shared.id, text("hello"))
        .await
        .expect("contacts can write")
        .value;

    block(&pool, &victim, &abuser).await;
    assert!(requires_contact(
        store::send_message(&pool, &abuser, shared.id, text("after block")).await
    ));
    assert!(requires_contact(
        store::edit_message(
            &pool,
            &abuser,
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
        store::set_reaction(&pool, &abuser, shared.id, sent.id, "👍", true).await
    ));
    assert!(requires_contact(
        store::update_shared_title(&pool, &abuser, shared.id, title(shared.version, "Mine")).await
    ));
}

#[tokio::test]
async fn history_images_cannot_be_added_to_a_shared_chat_after_removal() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "consent-backfill-owner").await;
    let peer = account(&pool, "consent-backfill-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let shared = store::create_conversation(&pool, &owner, shared_ai(vec![peer.clone()]))
        .await
        .unwrap()
        .value;
    let history = store::send_message(
        &pool,
        &owner,
        shared.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "canonical-history-user".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": "Look"}],
                            "canonical_history": {"local_message_id": "synthetic-local"},
                            "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("contacts can write")
    .value;
    let image = attachment(&pool, &owner, "image/png").await;
    let images = || {
        vec![MissingImageInput {
            attachment_id: image.clone(),
            name: "synthetic.png".to_string(),
        }]
    };

    remove_contact(&pool, &owner, &peer).await;
    assert!(requires_contact(
        backfill_missing_images(&pool, &owner, shared.id, history.id, images()).await
    ));

    connect_accounts(&pool, &owner, &peer).await;
    let repaired = backfill_missing_images(&pool, &owner, shared.id, history.id, images())
        .await
        .expect("contacts can repair their own history");
    assert_eq!(repaired.attachment_ids, vec![image.clone()]);
}
