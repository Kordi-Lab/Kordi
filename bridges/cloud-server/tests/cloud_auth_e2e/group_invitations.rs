use super::*;

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn group_invitation_updates_canonical_membership_and_never_creates_contacts() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (admin_token, admin_id) = signup_account(&router, "group-invite-admin").await;
    let (member_token, member_id) = signup_account(&router, "group-invite-member").await;
    let (recipient_token, recipient_id) = signup_account(&router, "group-invite-recipient").await;
    let (second_token, second_id) = signup_account(&router, "group-invite-second").await;
    let (third_token, third_id) = signup_account(&router, "group-invite-third").await;
    let group_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());

    let now = chrono::Utc::now().to_rfc3339();
    for (owner, peer) in [(&admin_id, &member_id), (&member_id, &admin_id)] {
        sqlx_core::query::query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(owner)
        .bind(peer)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    }
    let conversation = kordi_cloud_server::chat_sync::store::create_conversation(
        &pool,
        &admin_id,
        kordi_cloud_server::chat_sync::models::CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: kordi_cloud_server::chat_sync::models::ConversationKind::Group,
            shared_title: Some("Product Team".to_string()),
            client_session_id: group_id.clone(),
            member_account_ids: vec![member_id.clone()],
        },
    )
    .await
    .unwrap()
    .value;

    let member_create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/invitations/groups",
            &member_token,
            json!({
                "groupId": group_id,
                "groupSpaceId": group_id,
                "groupTitle": "Product Team"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(member_create.status(), StatusCode::FORBIDDEN);

    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/invitations/groups",
            &admin_token,
            json!({
                "groupId": group_id,
                "groupSpaceId": group_id,
                "groupTitle": "Product Team"
            }),
        ))
        .await
        .unwrap();
    let create_status = create.status();
    let create_body = read_json(create).await;
    assert_eq!(create_status, StatusCode::OK, "got body {create_body}");
    let invitation_id = create_body["invitationId"].as_str().unwrap();
    let invite_url = create_body["inviteUrl"].as_str().unwrap();
    let token = invite_url.rsplit('/').next().unwrap();
    assert!(token.starts_with("kordi_gi_"));

    let stored_token_hash: (String,) = sqlx_core::query_as::query_as(
        "SELECT token_hash FROM cloud_group_invitations WHERE invitation_id = $1",
    )
    .bind(invitation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(stored_token_hash.0, token);

    let preview = router
        .clone()
        .oneshot(get(&format!(
            "/v1/cloud/invitations/groups/resolve/{token}"
        )))
        .await
        .unwrap();
    let preview_status = preview.status();
    let preview_body = read_json(preview).await;
    assert_eq!(preview_status, StatusCode::OK, "got body {preview_body}");
    assert_eq!(preview_body["group"]["name"], "Product Team");
    assert_eq!(preview_body["group"]["memberCount"], 2);

    let accept = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{token}"),
            &recipient_token,
        ))
        .await
        .unwrap();
    let accept_status = accept.status();
    let accept_body = read_json(accept).await;
    assert_eq!(accept_status, StatusCode::OK, "got body {accept_body}");
    assert_eq!(accept_body["status"], "joined");
    assert_eq!(accept_body["groupSpaceId"], group_id);

    let contacts_after: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_contacts WHERE account_id = $1 OR peer_account_id = $1",
    )
    .bind(&recipient_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        contacts_after.0, 0,
        "joining a group must not create contacts"
    );

    let membership: (String, String) = sqlx_core::query_as::query_as(
        "SELECT role, membership_state FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&recipient_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(membership, ("member".to_string(), "active".to_string()));
    let membership_event_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND conversation_id = $2 AND event_type = 'membership.updated'",
    )
    .bind(&recipient_id)
    .bind(conversation.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(membership_event_count.0, 1);

    let duplicate = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{token}"),
            &recipient_token,
        ))
        .await
        .unwrap();
    assert_eq!(read_json(duplicate).await["status"], "already_joined");

    let self_accept = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{token}"),
            &admin_token,
        ))
        .await
        .unwrap();
    assert_eq!(self_accept.status(), StatusCode::CONFLICT);

    let second_join = router.clone().oneshot(post_with_token(
        &format!("/v1/cloud/invitations/groups/accept/{token}"),
        &second_token,
    ));
    let third_join = router.clone().oneshot(post_with_token(
        &format!("/v1/cloud/invitations/groups/accept/{token}"),
        &third_token,
    ));
    let (second_join, third_join) = tokio::join!(second_join, third_join);
    assert_eq!(second_join.unwrap().status(), StatusCode::OK);
    assert_eq!(third_join.unwrap().status(), StatusCode::OK);

    let joined_ids: Vec<(String,)> = sqlx_core::query_as::query_as(
        "SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active' ORDER BY account_id",
    )
    .bind(conversation.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let joined_ids = joined_ids.into_iter().map(|row| row.0).collect::<Vec<_>>();
    assert!(joined_ids.contains(&second_id));
    assert!(joined_ids.contains(&third_id));

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/invitations/groups/{invitation_id}"),
            &admin_token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);

    let revoked_preview = router
        .oneshot(get(&format!(
            "/v1/cloud/invitations/groups/resolve/{token}"
        )))
        .await
        .unwrap();
    assert_eq!(revoked_preview.status(), StatusCode::NOT_FOUND);
}

async fn group_invite_token(router: &axum::Router, token: &str, group_id: &str) -> String {
    let create = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/invitations/groups",
            token,
            json!({ "groupId": group_id, "groupSpaceId": group_id, "groupTitle": "Consent Team" }),
        ))
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::OK);
    let body = read_json(create).await;
    body["inviteUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string()
}

async fn accept_group_invite(
    router: &axum::Router,
    token: &str,
    invite: &str,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{invite}"),
            token,
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn resolve(router: &axum::Router, path: &str) -> serde_json::Value {
    let response = router.clone().oneshot(get(path)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    read_json(response).await
}

fn sorted_keys(value: &serde_json::Value) -> Vec<String> {
    let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    keys.sort_unstable();
    keys
}

async fn set_membership(
    pool: &sqlx_postgres::PgPool,
    conversation: uuid::Uuid,
    account: &str,
    state: &str,
) {
    sqlx_core::query::query(
        "UPDATE cloud_chat_conversation_members SET membership_state = $3, left_at = now() \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation)
    .bind(account)
    .bind(state)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn invitation_previews_hide_account_ids_and_blocks_and_rejoins_follow_the_rules() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (admin_token, admin_id) = signup_account(&router, "invite-consent-admin").await;
    let (member_token, member_id) = signup_account(&router, "invite-consent-member").await;
    let (joiner_token, joiner_id) = signup_account(&router, "invite-consent-joiner").await;
    let (blocked_token, blocked_id) = signup_account(&router, "invite-consent-blocked").await;
    let now = chrono::Utc::now().to_rfc3339();
    for (owner, peer) in [(&admin_id, &member_id), (&member_id, &admin_id)] {
        sqlx_core::query::query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3)",
        )
        .bind(owner)
        .bind(peer)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    }
    let group_id = format!("session:group:{}", uuid::Uuid::new_v4().simple());
    let conversation = kordi_cloud_server::chat_sync::store::create_conversation(
        &pool,
        &admin_id,
        kordi_cloud_server::chat_sync::models::CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: kordi_cloud_server::chat_sync::models::ConversationKind::Group,
            shared_title: Some("Consent Team".to_string()),
            client_session_id: group_id.clone(),
            member_account_ids: vec![member_id.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    // Accounts created before random avatar seeds used their account id.
    sqlx_core::query::query(
        "UPDATE cloud_accounts SET avatar_seed = account_id, \
         avatar_url = 'kordi-avatar://' || avatar_renderer_version || '/lorelei/' || account_id \
                      || '?version=' || avatar_version \
         WHERE account_id = $1",
    )
    .bind(&admin_id)
    .execute(&pool)
    .await
    .unwrap();

    let invite = group_invite_token(&router, &admin_token, &group_id).await;
    let preview = resolve(
        &router,
        &format!("/v1/cloud/invitations/groups/resolve/{invite}"),
    )
    .await;
    assert_eq!(sorted_keys(&preview), vec!["expiresAt", "group", "inviter"]);
    assert_eq!(
        sorted_keys(&preview["inviter"]),
        vec!["avatarUrl", "displayName"]
    );
    assert_eq!(sorted_keys(&preview["group"]), vec!["memberCount", "name"]);
    assert_eq!(preview["inviter"]["avatarUrl"], serde_json::Value::Null);
    assert_eq!(preview["group"]["memberCount"], 2);
    assert!(!preview.to_string().contains("acct_"), "got {preview}");

    let app_invite = read_json(
        router
            .clone()
            .oneshot(post_with_token("/v1/cloud/invitations/app", &admin_token))
            .await
            .unwrap(),
    )
    .await;
    let app_token = app_invite["inviteUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let app_preview = resolve(
        &router,
        &format!("/v1/cloud/invitations/app/resolve/{app_token}"),
    )
    .await;
    assert!(app_preview["inviter"]["kordiId"].as_str().is_some());
    assert_eq!(app_preview["inviter"]["avatarUrl"], serde_json::Value::Null);
    assert!(
        !app_preview.to_string().contains("acct_"),
        "got {app_preview}"
    );

    let uploaded = format!("kordi-avatar://uploaded/ava_{}", "0".repeat(32));
    sqlx_core::query::query("UPDATE cloud_accounts SET avatar_url = $2 WHERE account_id = $1")
        .bind(&admin_id)
        .bind(&uploaded)
        .execute(&pool)
        .await
        .unwrap();
    let preview = resolve(
        &router,
        &format!("/v1/cloud/invitations/groups/resolve/{invite}"),
    )
    .await;
    assert_eq!(preview["inviter"]["avatarUrl"], uploaded);

    // Someone the inviter blocked cannot use the inviter's link, but a link
    // from another admin still works.
    let block = router
        .clone()
        .oneshot(put_json_with_token(
            &format!("/v1/cloud/blocks/{blocked_id}"),
            &admin_token,
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(block.status(), StatusCode::OK);
    let (status, body) = accept_group_invite(&router, &blocked_token, &invite).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["errorCode"], "invalid_group_invitation");
    sqlx_core::query::query(
        "UPDATE cloud_chat_conversation_members SET role = 'admin' \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&member_id)
    .execute(&pool)
    .await
    .unwrap();
    let member_invite = group_invite_token(&router, &member_token, &group_id).await;
    let (status, body) = accept_group_invite(&router, &blocked_token, &member_invite).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (StatusCode::OK, Some("joined"))
    );

    // A member who left may rejoin with the same link.
    let (_, body) = accept_group_invite(&router, &joiner_token, &invite).await;
    assert_eq!(body["status"], "joined");
    set_membership(&pool, conversation.id, &joiner_id, "left").await;
    let (status, body) = accept_group_invite(&router, &joiner_token, &invite).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (StatusCode::OK, Some("joined"))
    );
    let membership: (String, String) = sqlx_core::query_as::query_as(
        "SELECT role, membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&joiner_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(membership, ("member".to_string(), "active".to_string()));
    let preview = resolve(
        &router,
        &format!("/v1/cloud/invitations/groups/resolve/{invite}"),
    )
    .await;
    assert_eq!(preview["group"]["memberCount"], 4);

    // A member an admin removed stays out of a link they already used.
    set_membership(&pool, conversation.id, &joiner_id, "removed").await;
    let (_, body) = accept_group_invite(&router, &joiner_token, &invite).await;
    assert_eq!(body["status"], "already_joined");
    let (state,): (String,) = sqlx_core::query_as::query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation.id)
    .bind(&joiner_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "removed");
}
