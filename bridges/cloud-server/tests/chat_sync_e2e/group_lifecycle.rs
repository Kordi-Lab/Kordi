use super::*;

fn group_request(members: Vec<String>, title: Option<&str>) -> CreateConversationRequest {
    CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Group,
        shared_title: title.map(str::to_string),
        client_session_id: format!("session:group:{}", Uuid::now_v7()),
        member_account_ids: members,
        organization_id: None,
    }
}

async fn removal_events(pool: &PgPool, account_id: &str, conversation_id: Uuid) -> Vec<String> {
    query_as::<_, (serde_json::Value,)>(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'membership.removed'",
    )
    .bind(account_id)
    .bind(conversation_id)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(payload,)| payload["reason"].as_str().unwrap_or_default().to_string())
    .collect()
}

async fn active_people(pool: &PgPool, conversation_id: Uuid) -> i64 {
    query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn a_new_group_opens_with_who_created_it_for_everyone() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "Ava").await;
    let member = account(&pool, "Ben").await;
    connect_accounts(&pool, &owner, &member).await;
    let created =
        store::create_conversation(&pool, &owner, group_request(vec![member.clone()], None))
            .await
            .unwrap();
    assert!(created.inserted);

    for viewer in [&owner, &member] {
        let page = store::history(&pool, viewer, created.value.id, None, None)
            .await
            .unwrap();
        let notices: Vec<_> = page
            .messages
            .iter()
            .filter(|message| message.kind == "system-notice")
            .collect();
        assert_eq!(notices.len(), 1, "one created line for {viewer}");
        let notice = notices[0];
        assert_eq!(
            notice.conversation_sequence, 1,
            "the created line comes first"
        );
        assert_eq!(notice.sender_account_id, owner);
        assert_eq!(notice.content["blocks"][0]["text"], "Ava created the group");
        assert_eq!(
            notice.content["group_event"]["type"],
            store::GROUP_CREATED_EVENT
        );
        assert_eq!(
            notice.content["group_event"]["actor_account_id"],
            owner.as_str()
        );
    }

    // Opening the same group again posts nothing new.
    let mut replay = group_request(vec![member.clone()], None);
    replay.client_session_id = created.value.legacy_session_id.clone().unwrap();
    let replayed = store::create_conversation(&pool, &owner, replay)
        .await
        .unwrap();
    assert!(!replayed.inserted);
    let page = store::history(&pool, &owner, created.value.id, None, None)
        .await
        .unwrap();
    assert_eq!(
        page.messages
            .iter()
            .filter(|message| message.kind == "system-notice")
            .count(),
        1
    );

    // A direct chat gets no created line.
    let other = account(&pool, "Cal").await;
    connect_accounts(&pool, &owner, &other).await;
    let direct = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: direct_person_session_id(&owner, &other),
            member_account_ids: vec![other.clone()],
            organization_id: None,
        },
    )
    .await
    .unwrap();
    let page = store::history(&pool, &owner, direct.value.id, None, None)
        .await
        .unwrap();
    assert!(page.messages.is_empty());
}

#[tokio::test]
async fn only_an_admin_dissolves_a_group_and_everyone_loses_it() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "dissolve-owner").await;
    let admin = account(&pool, "dissolve-admin").await;
    let member = account(&pool, "dissolve-member").await;
    let outsider = account(&pool, "dissolve-outsider").await;
    connect_accounts(&pool, &owner, &admin).await;
    connect_accounts(&pool, &owner, &member).await;
    let group = store::create_conversation(
        &pool,
        &owner,
        group_request(vec![admin.clone(), member.clone()], None),
    )
    .await
    .unwrap()
    .value;
    let space = group.legacy_session_id.clone().unwrap();
    query("UPDATE cloud_chat_conversation_members SET role = 'admin' WHERE conversation_id = $1 AND account_id = $2")
        .bind(group.id).bind(&admin).execute(&pool).await.unwrap();
    let channel = store::create_group_channel(
        &pool,
        &owner,
        &space,
        group_request(vec![], Some("Synthetic launch channel")),
    )
    .await
    .unwrap()
    .value;
    store::send_message(
        &pool,
        &member,
        group.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: content("hello"),
            reply_to_message_id: None,
            attachment_ids: vec![],
        },
    )
    .await
    .unwrap();
    let now = chrono::Utc::now();
    query(
        "INSERT INTO cloud_group_invitations (invitation_id, inviter_account_id, token_hash, group_id, \
           group_space_id, group_title, group_snapshot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $4, 'Synthetic group', '{}'::jsonb, $5, $6)",
    )
    .bind(format!("groupinv_{}", Uuid::new_v4().simple()))
    .bind(&owner)
    .bind(Uuid::new_v4().to_string())
    .bind(&space)
    .bind(now.to_rfc3339())
    .bind((now + chrono::Duration::days(7)).to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_account_group_space_preferences (account_id, group_space_id, pinned_at) \
         VALUES ($1, $2, now())",
    )
    .bind(&member)
    .bind(&space)
    .execute(&pool)
    .await
    .unwrap();

    for denied in [&member, &outsider] {
        assert!(matches!(
            store::dissolve_group(&pool, denied, &space).await,
            Err(StoreError::Forbidden)
        ));
    }
    assert_eq!(active_people(&pool, group.id).await, 3);

    let outcome = store::dissolve_group(&pool, &admin, &space).await.unwrap();
    let mut dissolved = outcome.conversation_ids.clone();
    dissolved.sort();
    let mut expected = vec![group.id, channel.id];
    expected.sort();
    assert_eq!(dissolved, expected);
    let mut removed = outcome.removed_account_ids.clone();
    removed.sort();
    let mut people = vec![owner.clone(), admin.clone(), member.clone()];
    people.sort();
    assert_eq!(removed, people);

    for conversation_id in [group.id, channel.id] {
        assert_eq!(active_people(&pool, conversation_id).await, 0);
        let messages: (i64,) =
            query_as("SELECT COUNT(*) FROM cloud_chat_messages WHERE conversation_id = $1")
                .bind(conversation_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(messages.0, 0);
        for person in &people {
            assert_eq!(
                removal_events(&pool, person, conversation_id).await,
                vec!["dissolved".to_string()],
                "{person} is told to drop {conversation_id}"
            );
            assert!(matches!(
                store::history(&pool, person, conversation_id, None, None).await,
                Err(StoreError::Forbidden | StoreError::NotFound)
            ));
        }
    }
    let live_links: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_group_invitations WHERE group_space_id = $1 AND revoked_at IS NULL",
    )
    .bind(&space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(live_links.0, 0);
    let pins: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_group_space_preferences WHERE group_space_id = $1",
    )
    .bind(&space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pins.0, 0);
    // A dissolved group takes no new messages, channels or second dissolve.
    assert!(store::send_message(
        &pool,
        &owner,
        group.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: content("after"),
            reply_to_message_id: None,
            attachment_ids: vec![],
        },
    )
    .await
    .is_err());
    assert!(matches!(
        store::dissolve_group(&pool, &owner, &space).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn only_an_admin_dissolves_a_channel_and_the_group_stays() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "channel-dissolve-owner").await;
    let member = account(&pool, "channel-dissolve-member").await;
    connect_accounts(&pool, &owner, &member).await;
    let group =
        store::create_conversation(&pool, &owner, group_request(vec![member.clone()], None))
            .await
            .unwrap()
            .value;
    let space = group.legacy_session_id.clone().unwrap();
    let channel = store::create_group_channel(
        &pool,
        &owner,
        &space,
        group_request(vec![], Some("Synthetic QA channel")),
    )
    .await
    .unwrap()
    .value;

    assert!(matches!(
        store::dissolve_group_channel(&pool, &member, &space, channel.id).await,
        Err(StoreError::Forbidden)
    ));
    assert!(
        matches!(
            store::dissolve_group_channel(&pool, &owner, &space, group.id).await,
            Err(StoreError::InvalidInput(_))
        ),
        "the first channel is the group"
    );
    assert!(matches!(
        store::dissolve_group_channel(&pool, &owner, &format!("{space}-other"), channel.id).await,
        Err(StoreError::NotFound)
    ));

    let outcome = store::dissolve_group_channel(&pool, &owner, &space, channel.id)
        .await
        .unwrap();
    assert_eq!(outcome.conversation_ids, vec![channel.id]);
    assert_eq!(active_people(&pool, channel.id).await, 0);
    for person in [&owner, &member] {
        assert_eq!(
            removal_events(&pool, person, channel.id).await,
            vec!["dissolved".to_string()]
        );
        assert!(removal_events(&pool, person, group.id).await.is_empty());
    }
    assert!(
        active_people(&pool, group.id).await >= 2,
        "the group itself stays"
    );
}
