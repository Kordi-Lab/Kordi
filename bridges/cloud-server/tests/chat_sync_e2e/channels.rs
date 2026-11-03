use super::*;

fn channel_request(members: Vec<String>) -> CreateConversationRequest {
    CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Group,
        shared_title: Some("Synthetic channel".into()),
        client_session_id: format!("session:group:{}", Uuid::now_v7()),
        member_account_ids: members,
    }
}

#[tokio::test]
async fn group_channels_inherit_membership_without_requiring_contacts() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let owner = account(&pool, "channel-owner").await;
    let member = account(&pool, "channel-member").await;
    let admin = account(&pool, "channel-admin").await;
    let outsider = account(&pool, "channel-outsider").await;
    connect_accounts(&pool, &owner, &member).await;
    connect_accounts(&pool, &owner, &admin).await;
    let source = store::create_conversation(
        &pool,
        &owner,
        channel_request(vec![member.clone(), admin.clone()]),
    )
    .await
    .unwrap()
    .value;
    let space = source.legacy_session_id.clone().unwrap();
    query("UPDATE cloud_chat_conversations SET group_space_id = $2, group_title = 'Synthetic invited group' WHERE conversation_id = $1")
        .bind(source.id).bind(&space).execute(&pool).await.unwrap();
    query("UPDATE cloud_chat_conversation_members SET role = 'admin' WHERE conversation_id = $1 AND account_id = $2")
        .bind(source.id).bind(&admin).execute(&pool).await.unwrap();
    // Grounding invitations establish group membership without a contact relationship.
    query("DELETE FROM cloud_contacts WHERE account_id = $1 OR peer_account_id = $1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let request = channel_request(vec![member.clone(), admin.clone()]);
    assert!(
        matches!(
            store::create_conversation(&pool, &owner, request.clone()).await,
            Err(StoreError::Forbidden)
        ),
        "the old channel path rejects this valid existing group"
    );
    let created = store::create_group_channel(&pool, &owner, &space, request.clone())
        .await
        .unwrap();
    assert!(created.inserted);
    assert_eq!(created.value.members.len(), 3);
    assert_eq!(
        created.value.group_space_id.as_deref(),
        Some(space.as_str())
    );
    assert_eq!(
        created.value.group_title.as_deref(),
        Some("Synthetic invited group")
    );
    let replay = store::create_group_channel(&pool, &owner, &space, request.clone())
        .await
        .unwrap();
    assert!(!replay.inserted);
    assert_eq!(created.value.id, replay.value.id);
    let by_admin = store::create_group_channel(&pool, &admin, &space, channel_request(vec![]))
        .await
        .unwrap();
    assert_eq!(
        by_admin
            .value
            .members
            .iter()
            .find(|entry| entry.account_id == owner)
            .unwrap()
            .role,
        "owner"
    );
    assert_eq!(
        by_admin
            .value
            .members
            .iter()
            .find(|entry| entry.account_id == admin)
            .unwrap()
            .role,
        "admin"
    );
    let by_member = store::create_group_channel(&pool, &member, &space, channel_request(vec![]))
        .await
        .unwrap();
    assert_eq!(
        by_member
            .value
            .members
            .iter()
            .find(|entry| entry.account_id == member)
            .unwrap()
            .role,
        "member"
    );
    assert!(matches!(
        store::create_group_channel(&pool, &outsider, &space, channel_request(vec![])).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store::create_group_channel(&pool, &owner, &space, channel_request(vec![outsider])).await,
        Err(StoreError::Forbidden)
    ));
    query("UPDATE cloud_chat_conversation_members SET membership_state = 'removed' WHERE conversation_id = $1 AND account_id = $2")
        .bind(source.id).bind(&member).execute(&pool).await.unwrap();
    assert!(matches!(
        store::create_group_channel(&pool, &owner, &space, channel_request(vec![member.clone()]))
            .await,
        Err(StoreError::Forbidden)
    ));
    // A lost-response retry still identifies the original operation after a roster change.
    let retry = CreateConversationRequest {
        member_account_ids: vec![],
        ..request
    };
    let replay_after_change = store::create_group_channel(&pool, &owner, &space, retry)
        .await
        .unwrap();
    assert_eq!(replay_after_change.value.id, created.value.id);
    let after_removal = store::create_group_channel(&pool, &owner, &space, channel_request(vec![]))
        .await
        .unwrap();
    assert!(!after_removal
        .value
        .members
        .iter()
        .any(|entry| entry.account_id == member));
}

#[tokio::test]
async fn group_channel_creation_cannot_rebind_an_existing_session_to_another_group() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let owner = account(&pool, "channel-scope-owner").await;
    let member = account(&pool, "channel-scope-member").await;
    connect_accounts(&pool, &owner, &member).await;
    let first = store::create_conversation(&pool, &owner, channel_request(vec![member.clone()]))
        .await
        .unwrap()
        .value;
    let second = store::create_conversation(&pool, &owner, channel_request(vec![member]))
        .await
        .unwrap()
        .value;
    let request = channel_request(vec![]);
    store::create_group_channel(
        &pool,
        &owner,
        first.legacy_session_id.as_deref().unwrap(),
        request.clone(),
    )
    .await
    .unwrap();
    assert!(matches!(
        store::create_group_channel(
            &pool,
            &owner,
            second.legacy_session_id.as_deref().unwrap(),
            request.clone()
        )
        .await,
        Err(StoreError::IdempotencyKeyReused)
    ));
    let reused_session = CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        ..request
    };
    assert!(matches!(
        store::create_group_channel(
            &pool,
            &owner,
            second.legacy_session_id.as_deref().unwrap(),
            reused_session
        )
        .await,
        Err(StoreError::IdempotencyKeyReused)
    ));
}
