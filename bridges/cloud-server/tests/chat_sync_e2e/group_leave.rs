use super::group_consent::{
    create_channel, create_group, join_by_invitation, leave_request, members_request,
};
use super::*;

async fn membership(pool: &PgPool, conversation_id: Uuid, account_id: &str) -> (String, String) {
    query_as(
        "SELECT membership_state, role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
    .expect("load membership")
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

async fn invitation(pool: &PgPool, inviter: &str, root_session: &str) -> String {
    let invitation_id = format!("ginv_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    query(
        "INSERT INTO cloud_group_invitations (invitation_id, inviter_account_id, token_hash, \
           group_id, group_space_id, group_title, group_snapshot, created_at, expires_at) \
         VALUES ($1, $2, $1, $3, $3, 'Team', '{}'::jsonb, $4, $5)",
    )
    .bind(&invitation_id)
    .bind(inviter)
    .bind(root_session)
    .bind(now.to_rfc3339())
    .bind((now + chrono::Duration::days(7)).to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
    invitation_id
}

#[tokio::test]
async fn leaving_a_space_leaves_every_channel_and_tells_every_member() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "leave-space-owner").await;
    let leaver = account(&pool, "leave-space-leaver").await;
    let stayer = account(&pool, "leave-space-stayer").await;
    connect_accounts(&pool, &owner, &leaver).await;
    connect_accounts(&pool, &owner, &stayer).await;
    let (root, root_session) = create_group(&pool, &owner, &[&leaver, &stayer]).await;
    let (channel, _) = create_channel(&pool, &owner, &root_session, &[&leaver, &stayer]).await;
    let (unrelated, _) = create_group(&pool, &owner, &[&leaver]).await;
    let open_link = invitation(&pool, &leaver, &root_session).await;
    let leaver_head = sync_head(&pool, &leaver).await.0;
    let stayer_head = sync_head(&pool, &stayer).await.0;

    let response = store::leave_group(&pool, &leaver, root, leave_request(None))
        .await
        .expect("leave the group");
    let mut expected = vec![root, channel];
    expected.sort();
    assert_eq!(response.left_conversation_ids, expected);
    assert_eq!(response.successor_account_id, None);
    for conversation_id in [root, channel] {
        assert_eq!(
            membership(&pool, conversation_id, &leaver).await,
            ("left".to_string(), "member".to_string())
        );
    }
    assert_eq!(membership(&pool, unrelated, &leaver).await.0, "active");

    let leaver_events = store::sync_batch(&pool, &leaver, leaver_head, Some(50))
        .await
        .unwrap()
        .events;
    let removed = leaver_events
        .iter()
        .filter(|event| event.event_type == "membership.removed")
        .map(|event| {
            assert_eq!(event.payload["membership_state"], "left");
            assert_eq!(event.payload["account_id"], leaver.as_str());
            event.conversation_id.unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(removed.len(), 2);
    let stayer_events = store::sync_batch(&pool, &stayer, stayer_head, Some(50))
        .await
        .unwrap()
        .events;
    for conversation_id in [root, channel] {
        let update = stayer_events
            .iter()
            .find(|event| {
                event.event_type == "membership.updated"
                    && event.conversation_id == Some(conversation_id)
            })
            .expect("remaining members hear about the leave");
        assert!(update.payload["conversation"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|member| member["account_id"] == leaver.as_str()
                && member["membership_state"] == "left"));
    }

    assert!(matches!(
        store::history(&pool, &leaver, root, None, None).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store::send_message(&pool, &leaver, channel, text("hello?")).await,
        Err(StoreError::Forbidden)
    ));
    let revoked: (Option<String>,) =
        query_as("SELECT revoked_at FROM cloud_group_invitations WHERE invitation_id = $1")
            .bind(&open_link)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.0.is_some());
}

#[tokio::test]
async fn leaving_a_channel_leaves_only_that_channel() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "leave-channel-owner").await;
    let member = account(&pool, "leave-channel-member").await;
    connect_accounts(&pool, &owner, &member).await;
    let (root, root_session) = create_group(&pool, &owner, &[&member]).await;
    let (channel, _) = create_channel(&pool, &owner, &root_session, &[&member]).await;
    let open_link = invitation(&pool, &member, &root_session).await;
    let response = store::leave_group(&pool, &member, channel, leave_request(None))
        .await
        .unwrap();
    assert_eq!(response.left_conversation_ids, vec![channel]);
    assert_eq!(membership(&pool, root, &member).await.0, "active");
    assert_eq!(membership(&pool, channel, &member).await.0, "left");
    let revoked: (Option<String>,) =
        query_as("SELECT revoked_at FROM cloud_group_invitations WHERE invitation_id = $1")
            .bind(&open_link)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.0.is_none());
}

#[tokio::test]
async fn an_owner_who_leaves_hands_the_group_on() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "succession-owner").await;
    let early = account(&pool, "succession-early").await;
    let admin = account(&pool, "succession-admin").await;
    let suggested = account(&pool, "succession-suggested").await;
    for member in [&early, &admin, &suggested] {
        connect_accounts(&pool, &owner, member).await;
    }
    let make_group = || async {
        let (group, _) = create_group(&pool, &owner, &[&early]).await;
        // Later joiners, one of them an admin.
        store::add_conversation_members(
            &pool,
            &owner,
            group,
            members_request(&[&admin, &suggested], false),
        )
        .await
        .unwrap();
        query(
            "UPDATE cloud_chat_conversation_members SET role = 'admin' \
             WHERE conversation_id = $1 AND account_id = $2",
        )
        .bind(group)
        .bind(&admin)
        .execute(&pool)
        .await
        .unwrap();
        group
    };

    let group = make_group().await;
    let response = store::leave_group(&pool, &owner, group, leave_request(Some(&suggested)))
        .await
        .unwrap();
    assert_eq!(
        response.successor_account_id.as_deref(),
        Some(suggested.as_str())
    );
    assert_eq!(membership(&pool, group, &suggested).await.1, "owner");

    // A suggestion that is not an active member is ignored: admins first.
    let group = make_group().await;
    let outsider = account(&pool, "succession-outsider").await;
    let response = store::leave_group(&pool, &owner, group, leave_request(Some(&outsider)))
        .await
        .unwrap();
    assert_eq!(
        response.successor_account_id.as_deref(),
        Some(admin.as_str())
    );

    // Without admins, the earliest member to join.
    let group = make_group().await;
    query("UPDATE cloud_chat_conversation_members SET role = 'member' WHERE conversation_id = $1 AND account_id = $2")
        .bind(group)
        .bind(&admin)
        .execute(&pool)
        .await
        .unwrap();
    let response = store::leave_group(&pool, &owner, group, leave_request(None))
        .await
        .unwrap();
    assert_eq!(
        response.successor_account_id.as_deref(),
        Some(early.as_str())
    );
    // The new owner can manage the group.
    let newcomer = account(&pool, "succession-newcomer").await;
    connect_accounts(&pool, &early, &newcomer).await;
    store::add_conversation_members(&pool, &early, group, members_request(&[&newcomer], false))
        .await
        .expect("the successor can add members");

    // A member who is not the owner hands nothing on.
    let response = store::leave_group(&pool, &admin, group, leave_request(Some(&suggested)))
        .await
        .unwrap();
    assert_eq!(response.successor_account_id, None);
    assert_eq!(membership(&pool, group, &suggested).await.1, "member");
}

#[tokio::test]
async fn leave_requests_are_idempotent_and_limited_to_groups() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "leave-replay-owner").await;
    let member = account(&pool, "leave-replay-member").await;
    let outsider = account(&pool, "leave-replay-outsider").await;
    connect_accounts(&pool, &owner, &member).await;
    let (group, _) = create_group(&pool, &owner, &[&member]).await;
    let request = leave_request(None);
    let first = store::leave_group(&pool, &member, group, request.clone())
        .await
        .unwrap();
    let replay = store::leave_group(&pool, &member, group, request.clone())
        .await
        .unwrap();
    assert_eq!(replay, first);
    let mut changed = request;
    changed.successor_account_id = Some(owner.clone());
    assert!(matches!(
        store::leave_group(&pool, &member, group, changed).await,
        Err(StoreError::IdempotencyKeyReused)
    ));
    let again = store::leave_group(&pool, &member, group, leave_request(None))
        .await
        .unwrap();
    assert!(again.left_conversation_ids.is_empty());

    assert!(matches!(
        store::leave_group(&pool, &outsider, group, leave_request(None)).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        store::leave_group(&pool, &member, Uuid::now_v7(), leave_request(None)).await,
        Err(StoreError::NotFound)
    ));
    let direct = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &member),
            member_account_ids: vec![member.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    assert!(matches!(
        store::leave_group(&pool, &owner, direct.id, leave_request(None)).await,
        Err(StoreError::InvalidInput("Only groups can be left."))
    ));
}

#[tokio::test]
async fn members_who_left_rejoin_as_members_and_admins_add_them_back_to_channels() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "rejoin-owner").await;
    let member = account(&pool, "rejoin-member").await;
    let friend = account(&pool, "rejoin-friend").await;
    connect_accounts(&pool, &owner, &friend).await;
    let (root, root_session) = create_group(&pool, &owner, &[&friend]).await;
    let (channel, _) = create_channel(&pool, &owner, &root_session, &[&friend]).await;
    join_by_invitation(&pool, &owner, &root_session, &member).await;
    store::add_conversation_members(&pool, &owner, channel, members_request(&[&member], false))
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversation_members SET role = 'admin' WHERE conversation_id = $1 AND account_id = $2")
        .bind(root)
        .bind(&member)
        .execute(&pool)
        .await
        .unwrap();
    store::leave_group(&pool, &member, root, leave_request(None))
        .await
        .unwrap();
    // While they are away, admins' stale lists do not bring them back.
    let channel_snapshot =
        store::add_conversation_members(&pool, &owner, channel, members_request(&[&member], false))
            .await
            .unwrap();
    assert!(channel_snapshot
        .members
        .iter()
        .any(|row| row.account_id == member && row.membership_state == "left"));

    join_by_invitation(&pool, &owner, &root_session, &member).await;
    assert_eq!(
        membership(&pool, root, &member).await,
        ("active".to_string(), "member".to_string())
    );
    assert_eq!(membership(&pool, channel, &member).await.0, "left");
    store::add_conversation_members(&pool, &owner, channel, members_request(&[&member], false))
        .await
        .expect("admins add returning members back to channels");
    assert_eq!(membership(&pool, channel, &member).await.0, "active");
}

#[tokio::test]
async fn members_leaving_one_space_at_the_same_time_all_succeed() {
    let Some(pool) = try_pool().await else { return };
    for _ in 0..20 {
        let owner = account(&pool, "concurrent-leave-owner").await;
        let first = account(&pool, "concurrent-leave-first").await;
        let second = account(&pool, "concurrent-leave-second").await;
        connect_accounts(&pool, &owner, &first).await;
        connect_accounts(&pool, &owner, &second).await;
        let (root, root_session) = create_group(&pool, &owner, &[&first, &second]).await;
        let (channel_a, _) = create_channel(&pool, &owner, &root_session, &[&first, &second]).await;
        let (channel_b, _) = create_channel(&pool, &owner, &root_session, &[&first, &second]).await;
        let (left_root, left_channel) = tokio::join!(
            store::leave_group(&pool, &first, root, leave_request(None)),
            store::leave_group(&pool, &second, channel_b, leave_request(None)),
        );
        assert_eq!(
            left_root.expect("root leave").left_conversation_ids.len(),
            3
        );
        assert_eq!(
            left_channel.expect("channel leave").left_conversation_ids,
            vec![channel_b]
        );
        assert_eq!(membership(&pool, channel_a, &first).await.0, "left");
        assert_eq!(membership(&pool, channel_a, &second).await.0, "active");
    }
}
