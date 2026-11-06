use super::*;

#[tokio::test]
async fn authoritative_group_membership_removal_stops_future_delivery() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping chat sync group membership test");
        return;
    };
    let owner = account(&pool, "group-owner").await;
    let kept = account(&pool, "group-kept").await;
    let removed = account(&pool, "group-removed").await;
    connect_accounts(&pool, &owner, &kept).await;
    connect_accounts(&pool, &owner, &removed).await;
    let created = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Secure group".to_string()),
            client_session_id: format!("session:group:{}", Uuid::now_v7()),
            member_account_ids: vec![kept.clone(), removed.clone()],
            organization_id: None,
        },
    )
    .await
    .expect("create group");
    let conversation_id = created.value.id;
    let removed_head_before = sync_head(&pool, &removed).await.0;
    let updated = store::add_conversation_members(
        &pool,
        &owner,
        conversation_id,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: vec![kept.clone()],
            replace: true,
        },
    )
    .await
    .expect("replace group membership");
    assert!(updated
        .members
        .iter()
        .any(|member| { member.account_id == removed && member.membership_state == "removed" }));
    let removal_batch = store::sync_batch(&pool, &removed, removed_head_before, Some(10))
        .await
        .expect("removed member receives tombstone");
    assert_eq!(removal_batch.events.len(), 1);
    assert_eq!(removal_batch.events[0].event_type, "membership.removed");
    let removed_head_after = sync_head(&pool, &removed).await.0;
    store::send_message(
        &pool,
        &owner,
        conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("members only"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send after removal");
    assert_eq!(sync_head(&pool, &removed).await.0, removed_head_after);
    assert!(store::bootstrap(&pool, &removed)
        .await
        .expect("removed bootstrap")
        .conversations
        .is_empty());
    assert_eq!(
        store::bootstrap(&pool, &kept)
            .await
            .expect("kept bootstrap")
            .latest_messages
            .len(),
        1,
    );
}

fn active_members(
    snapshot: &kordi_cloud_server::chat_sync::models::ConversationSnapshot,
) -> Vec<String> {
    let mut members = snapshot
        .members
        .iter()
        .filter(|member| member.membership_state == "active")
        .map(|member| member.account_id.clone())
        .collect::<Vec<_>>();
    members.sort();
    members
}

#[tokio::test]
async fn a_group_can_start_with_its_creator_and_return_to_one_member() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping chat sync single-member group test");
        return;
    };
    let owner = account(&pool, "solo-owner").await;
    let friend = account(&pool, "solo-friend").await;
    connect_accounts(&pool, &owner, &friend).await;
    let created = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Just me".to_string()),
            client_session_id: format!("session:group:{}", Uuid::now_v7()),
            member_account_ids: Vec::new(),
            organization_id: None,
        },
    )
    .await
    .expect("a group may start with only its creator");
    assert!(created.inserted);
    let solo = created.value;
    assert_eq!(solo.kind, ConversationKind::Group);
    assert_eq!(active_members(&solo), vec![owner.clone()]);
    let conversation_id = solo.id;

    store::send_message(
        &pool,
        &owner,
        conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("notes before anyone joins"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("the creator can post into a one-member group");
    let bootstrap = store::bootstrap(&pool, &owner)
        .await
        .expect("owner bootstrap");
    let listed = bootstrap
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .expect("the one-member group is listed");
    assert_eq!(listed.kind, ConversationKind::Group);

    let grown = store::add_conversation_members(
        &pool,
        &owner,
        conversation_id,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: vec![friend.clone()],
            replace: false,
        },
    )
    .await
    .expect("add a contact to the one-member group");
    let mut both = vec![owner.clone(), friend.clone()];
    both.sort();
    assert_eq!(active_members(&grown), both);

    // Removing the only other person leaves a group of one, never a direct chat.
    let shrunk = store::add_conversation_members(
        &pool,
        &owner,
        conversation_id,
        AddConversationMembersRequest {
            client_operation_id: Uuid::now_v7(),
            member_account_ids: Vec::new(),
            replace: true,
        },
    )
    .await
    .expect("replace the member list with only the admin");
    assert_eq!(shrunk.kind, ConversationKind::Group);
    assert_eq!(active_members(&shrunk), vec![owner.clone()]);
    assert!(store::bootstrap(&pool, &friend)
        .await
        .expect("removed member bootstrap")
        .conversations
        .iter()
        .all(|conversation| conversation.id != conversation_id));

    // When the last member leaves Kordi, the empty group goes with them.
    let mut transaction = pool.begin().await.expect("begin removal");
    let removal = store::remove_account_from_conversations(
        &mut transaction,
        &owner,
        &std::collections::HashSet::new(),
    )
    .await
    .expect("remove the last member");
    transaction.commit().await.expect("commit removal");
    assert!(removal.deleted >= 1);
    let remaining: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_conversations WHERE conversation_id = $1")
            .bind(conversation_id)
            .fetch_one(&pool)
            .await
            .expect("count conversation");
    assert_eq!(remaining.0, 0);
}

#[tokio::test]
async fn a_direct_chat_still_needs_two_people() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "direct-alone").await;
    let rejected = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!("session:direct-person:{owner}:{owner}"),
            member_account_ids: Vec::new(),
            organization_id: None,
        },
    )
    .await;
    assert!(matches!(rejected, Err(StoreError::InvalidInput(_))));
}
