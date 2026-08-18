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
