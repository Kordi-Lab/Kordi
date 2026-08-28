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
