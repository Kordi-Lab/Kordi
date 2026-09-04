use super::*;

#[tokio::test]
async fn unicode_reactions_are_idempotent_authorized_and_synced() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping chat reaction test");
        return;
    };
    let owner = account(&pool, "reaction-owner").await;
    let peer = account(&pool, "reaction-peer").await;
    let outsider = account(&pool, "reaction-outsider").await;
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
    .expect("create reaction conversation")
    .value;
    let client_message_id = Uuid::now_v7();
    let message = store::send_message(
        &pool,
        &owner,
        conversation.id,
        SendMessageRequest {
            client_message_id,
            kind: "text".to_string(),
            content: content("react to this"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send reaction target")
    .value;
    let owner_head = sync_head(&pool, &owner).await.0;
    let peer_head = sync_head(&pool, &peer).await.0;

    let reacted = store::set_reaction(&pool, &peer, conversation.id, client_message_id, "👍🏽", true)
        .await
        .expect("add reaction by logical client message id");
    assert_eq!(reacted.id, message.id);
    assert_eq!(reacted.reactions.len(), 1);
    assert_eq!(reacted.reactions[0].reaction, "👍🏽");
    assert_eq!(reacted.reactions[0].account_ids, vec![peer.clone()]);
    assert_eq!(sync_head(&pool, &owner).await.0, owner_head + 1);
    assert_eq!(sync_head(&pool, &peer).await.0, peer_head + 1);
    let event = store::sync_batch(&pool, &owner, owner_head, Some(10))
        .await
        .expect("load reaction event")
        .events
        .into_iter()
        .next()
        .expect("reaction event");
    assert_eq!(event.event_type, "reaction.updated");
    assert!(
        !event.critical,
        "older clients must be able to skip reaction events"
    );
    assert_eq!(event.payload["message"]["reactions"][0]["reaction"], "👍🏽");

    let unchanged_head = sync_head(&pool, &peer).await.0;
    store::set_reaction(&pool, &peer, conversation.id, message.id, "👍🏽", true)
        .await
        .expect("repeat reaction is a no-op");
    assert_eq!(sync_head(&pool, &peer).await.0, unchanged_head);

    let two_reactors = store::set_reaction(&pool, &owner, conversation.id, message.id, "👍🏽", true)
        .await
        .expect("second member reacts");
    assert_eq!(
        two_reactors.reactions[0].account_ids,
        vec![owner.clone(), peer.clone()]
    );
    let owner_only = store::set_reaction(&pool, &peer, conversation.id, message.id, "👍🏽", false)
        .await
        .expect("remove own reaction");
    assert_eq!(owner_only.reactions[0].account_ids, vec![owner.clone()]);
    assert!(matches!(
        store::set_reaction(&pool, &outsider, conversation.id, message.id, "❤️", true,).await,
        Err(StoreError::Forbidden)
    ));
    let bootstrapped = store::bootstrap(&pool, &peer)
        .await
        .expect("bootstrap reactions");
    assert_eq!(
        bootstrapped.latest_messages[0].reactions,
        owner_only.reactions
    );
}
