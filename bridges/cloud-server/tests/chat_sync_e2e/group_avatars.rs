use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

fn control(
    kind: &str,
    session: &str,
    space: &str,
    actor: &str,
    peer: &str,
    avatar: Option<serde_json::Value>,
) -> SendMessageRequest {
    let mut envelope = json!({
        "kind": kind, "groupId": session, "groupSpaceId": space, "groupTitle": "Test group",
        "createdByAccountId": actor,
        "actor": { "accountId": actor, "displayName": "Editor", "avatarUrl": null, "role": "admin" },
        "participants": [
            { "accountId": actor, "displayName": "Editor", "avatarUrl": null, "role": "admin" },
            { "accountId": peer, "displayName": "Member", "avatarUrl": null, "role": "person" }
        ]
    });
    if let Some(avatar) = avatar {
        envelope["groupAvatar"] = avatar;
    }
    SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: content(&format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
        )),
        reply_to_message_id: None,
        attachment_ids: vec![],
    }
}

async fn group(pool: &PgPool, owner: &str, peer: &str, session: &str) -> Uuid {
    store::create_conversation(
        pool,
        owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Test channel".to_string()),
            client_session_id: session.to_string(),
            member_account_ids: vec![peer.to_string()],
        },
    )
    .await
    .unwrap()
    .value
    .id
}

async fn avatar_asset(pool: &PgPool, owner: &str) -> String {
    let id = format!("ava_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_avatar_assets (asset_id, owner_account_id, entity_type, entity_id, object_prefix, source_content_type, source_size_bytes, source_width, source_height) VALUES ($1, $2, 'human', $2, $1, 'image/png', 100, 16, 16)")
        .bind(&id).bind(owner).execute(pool).await.unwrap();
    format!("kordi-avatar://uploaded/{id}")
}

#[tokio::test]
async fn group_avatar_sync_removal_inheritance_and_permissions() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "group-avatar-owner").await;
    let peer = account(&pool, "group-avatar-member").await;
    connect_accounts(&pool, &owner, &peer).await;
    let space = format!("session:group:{}", Uuid::now_v7());
    let root = group(&pool, &owner, &peer, &space).await;
    let image = avatar_asset(&pool, &owner).await;
    let snapshot = json!({ "imageUrl": image, "updatedAtMs": 1 });
    let request = control(
        "group-invite",
        &space,
        &space,
        &owner,
        &peer,
        Some(snapshot.clone()),
    );
    let first = store::send_message(&pool, &owner, root, request.clone())
        .await
        .unwrap();
    assert!(first.inserted);
    assert!(
        !store::send_message(&pool, &owner, root, request)
            .await
            .unwrap()
            .inserted
    );
    let activated: (bool,) =
        query_as("SELECT activated_at IS NOT NULL FROM cloud_avatar_assets WHERE asset_id = $1")
            .bind(image.rsplit('/').next().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(activated.0);
    let channel_id = format!("session:group:{}", Uuid::now_v7());
    let channel = group(&pool, &owner, &peer, &channel_id).await;
    store::send_message(
        &pool,
        &owner,
        channel,
        control("group-invite", &channel_id, &space, &owner, &peer, None),
    )
    .await
    .unwrap();
    let bootstrap = store::bootstrap(&pool, &peer).await.unwrap();
    let avatars = bootstrap
        .conversations
        .iter()
        .filter(|c| c.id == root || c.id == channel)
        .map(|c| c.group_avatar.clone().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(avatars.len(), 2);
    assert_eq!(avatars[0], avatars[1]);
    assert_eq!(avatars[0]["imageUrl"], image);
    assert!(avatars[0]["updatedAtMs"].as_i64().unwrap() > 1);

    // A forged admin role in the envelope cannot grant a regular member permission.
    let unauthorized = store::send_message(
        &pool,
        &peer,
        root,
        control(
            "group-avatar-update",
            &space,
            &space,
            &peer,
            &owner,
            Some(json!({"imageUrl": null, "updatedAtMs": 2})),
        ),
    )
    .await;
    assert!(matches!(unauthorized, Err(StoreError::Forbidden)));
    let foreign_image = avatar_asset(&pool, &peer).await;
    let invalid = store::send_message(
        &pool,
        &owner,
        root,
        control(
            "group-avatar-update",
            &space,
            &space,
            &owner,
            &peer,
            Some(json!({"imageUrl": foreign_image, "updatedAtMs": 2})),
        ),
    )
    .await;
    assert!(matches!(invalid, Err(StoreError::InvalidInput(_))));
    let inline = store::send_message(
        &pool,
        &owner,
        root,
        control(
            "group-avatar-update",
            &space,
            &space,
            &owner,
            &peer,
            Some(json!({"imageUrl": "data:image/png;base64,AA==", "updatedAtMs": 2})),
        ),
    )
    .await;
    assert!(matches!(inline, Err(StoreError::InvalidInput(_))));

    let before = sync_head(&pool, &peer).await.0;
    store::send_message(
        &pool,
        &owner,
        channel,
        control(
            "group-avatar-update",
            &channel_id,
            &space,
            &owner,
            &peer,
            Some(json!({"imageUrl": null, "updatedAtMs": 1})),
        ),
    )
    .await
    .unwrap();
    // Ordinary messages cannot restore an old snapshot, even with a fake future revision.
    let stale = store::send_message(
        &pool,
        &peer,
        root,
        control(
            "group-message",
            &space,
            &space,
            &peer,
            &owner,
            Some(json!({"imageUrl": image, "updatedAtMs": 999999999999999_i64})),
        ),
    )
    .await
    .unwrap()
    .value;
    let text = stale.content["blocks"][0]["text"]
        .as_str()
        .unwrap()
        .strip_prefix("kordi-cloud-group:")
        .unwrap();
    let stored: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(text).unwrap()).unwrap();
    assert!(stored["groupAvatar"]["imageUrl"].is_null());
    let after = store::bootstrap(&pool, &peer).await.unwrap();
    for c in after
        .conversations
        .iter()
        .filter(|c| c.group_space_id.as_deref() == Some(space.as_str()))
    {
        let avatar = c.group_avatar.as_ref().unwrap();
        assert!(avatar["imageUrl"].is_null());
        assert!(
            avatar["updatedAtMs"].as_i64().unwrap() > avatars[0]["updatedAtMs"].as_i64().unwrap()
        );
    }
    let updates = store::sync_batch(&pool, &peer, before, None).await.unwrap();
    assert_eq!(
        updates
            .events
            .iter()
            .filter(|e| e.event_type == "conversation.updated")
            .count(),
        2
    );
    // A new channel created after removal inherits the removal revision too.
    let newest_id = format!("session:group:{}", Uuid::now_v7());
    let newest = group(&pool, &owner, &peer, &newest_id).await;
    store::send_message(
        &pool,
        &owner,
        newest,
        control("group-invite", &newest_id, &space, &owner, &peer, None),
    )
    .await
    .unwrap();
    let reloaded = store::bootstrap(&pool, &owner).await.unwrap();
    assert!(reloaded
        .conversations
        .iter()
        .find(|c| c.id == newest)
        .unwrap()
        .group_avatar
        .as_ref()
        .unwrap()["imageUrl"]
        .is_null());
}

#[tokio::test]
async fn a_channel_owner_cannot_change_another_groups_avatar() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "avatar-isolation-owner").await;
    let peer = account(&pool, "avatar-isolation-member").await;
    let outsider = account(&pool, "avatar-isolation-outsider").await;
    connect_accounts(&pool, &owner, &peer).await;
    connect_accounts(&pool, &outsider, &peer).await;
    let space = format!("session:group:{}", Uuid::now_v7());
    let root = group(&pool, &owner, &peer, &space).await;
    let image = avatar_asset(&pool, &owner).await;
    store::send_message(
        &pool,
        &owner,
        root,
        control(
            "group-invite",
            &space,
            &space,
            &owner,
            &peer,
            Some(json!({"imageUrl": image, "updatedAtMs": 1})),
        ),
    )
    .await
    .unwrap();

    // A claimed group-space ID does not grant membership in its other channels.
    let alias = format!("session:group:{}", Uuid::now_v7());
    let channel = group(&pool, &outsider, &peer, &alias).await;
    for kind in ["group-invite", "group-message"] {
        let attached = store::send_message(
            &pool,
            &outsider,
            channel,
            control(kind, &alias, &space, &outsider, &peer, None),
        )
        .await;
        assert!(matches!(attached, Err(StoreError::Forbidden)));
    }
    // Older clients could persist an untrusted association. It still cannot
    // authorize an avatar write to channels the actor has never joined.
    query("UPDATE cloud_chat_conversations SET group_space_id = $2 WHERE conversation_id = $1")
        .bind(channel)
        .bind(&space)
        .execute(&pool)
        .await
        .unwrap();
    let foreign_image = avatar_asset(&pool, &outsider).await;
    for replacement in [Some(foreign_image), None] {
        let result = store::send_message(
            &pool,
            &outsider,
            channel,
            control(
                "group-avatar-update",
                &alias,
                &space,
                &outsider,
                &peer,
                Some(json!({"imageUrl": replacement, "updatedAtMs": 1})),
            ),
        )
        .await;
        assert!(matches!(result, Err(StoreError::Forbidden)));
    }
    let snapshot = store::bootstrap(&pool, &owner).await.unwrap();
    assert_eq!(
        snapshot
            .conversations
            .iter()
            .find(|c| c.id == root)
            .unwrap()
            .group_avatar
            .as_ref()
            .unwrap()["imageUrl"],
        image
    );
}

#[tokio::test]
async fn concurrent_admin_edits_share_one_monotonic_revision() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "avatar-race-owner").await;
    let peer = account(&pool, "avatar-race-admin").await;
    connect_accounts(&pool, &owner, &peer).await;
    let space = format!("session:group:{}", Uuid::now_v7());
    let child_id = format!("session:group:{}", Uuid::now_v7());
    let root = group(&pool, &owner, &peer, &space).await;
    let child = group(&pool, &owner, &peer, &child_id).await;
    for (id, session) in [(root, &space), (child, &child_id)] {
        store::send_message(
            &pool,
            &owner,
            id,
            control("group-invite", session, &space, &owner, &peer, None),
        )
        .await
        .unwrap();
    }
    query("UPDATE cloud_chat_conversation_members SET role = 'admin' WHERE conversation_id = $1 AND account_id = $2")
        .bind(child).bind(&peer).execute(&pool).await.unwrap();
    let image = avatar_asset(&pool, &owner).await;
    let set = control(
        "group-avatar-update",
        &space,
        &space,
        &owner,
        &peer,
        Some(json!({"imageUrl": image, "updatedAtMs": 1})),
    );
    let remove = control(
        "group-avatar-update",
        &child_id,
        &space,
        &peer,
        &owner,
        Some(json!({"imageUrl": null, "updatedAtMs": 1})),
    );
    let (left, right) = tokio::join!(
        store::send_message(&pool, &owner, root, set),
        store::send_message(&pool, &peer, child, remove)
    );
    let left = left.unwrap().value;
    let right = right.unwrap().value;
    let decode = |message: &kordi_cloud_server::chat_sync::models::MessageSnapshot| {
        let text = message.content["blocks"][0]["text"]
            .as_str()
            .unwrap()
            .strip_prefix("kordi-cloud-group:")
            .unwrap();
        serde_json::from_slice::<serde_json::Value>(&URL_SAFE_NO_PAD.decode(text).unwrap()).unwrap()
            ["groupAvatar"]
            .clone()
    };
    let left = decode(&left);
    let right = decode(&right);
    assert_ne!(left["updatedAtMs"], right["updatedAtMs"]);
    let latest = if left["updatedAtMs"].as_i64().unwrap() > right["updatedAtMs"].as_i64().unwrap() {
        left
    } else {
        right
    };
    let reloaded = store::bootstrap(&pool, &owner).await.unwrap();
    for conversation in reloaded
        .conversations
        .iter()
        .filter(|c| c.group_space_id.as_deref() == Some(space.as_str()))
    {
        assert_eq!(conversation.group_avatar.as_ref(), Some(&latest));
    }
}
