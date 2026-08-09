use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const GROUP_CONTROL_PREFIX: &str = "kordi-cloud-group:";

fn group_control_body(group_id: &str, admin_account_id: &str, member_account_id: &str) -> String {
    let envelope = json!({
        "kind": "group-invite",
        "groupId": group_id,
        "groupSpaceId": group_id,
        "groupTitle": "Product Team",
        "createdByAccountId": admin_account_id,
        "actor": {
            "accountId": admin_account_id,
            "displayName": "Admin",
            "avatarUrl": null,
            "role": "admin"
        },
        "participants": [
            {
                "accountId": admin_account_id,
                "displayName": "Admin",
                "avatarUrl": null,
                "role": "admin"
            },
            {
                "accountId": member_account_id,
                "displayName": "Member",
                "avatarUrl": null,
                "role": "person"
            }
        ],
        "memberJoins": [],
        "message": null
    });
    format!(
        "{GROUP_CONTROL_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

fn forged_admin_control_body(
    group_id: &str,
    creator_account_id: &str,
    member_account_id: &str,
) -> String {
    let envelope = json!({
        "kind": "group-update",
        "groupId": group_id,
        "groupSpaceId": group_id,
        "groupTitle": "Product Team",
        "createdByAccountId": creator_account_id,
        "actor": {
            "accountId": member_account_id,
            "displayName": "Member",
            "avatarUrl": null,
            "role": "admin"
        },
        "participants": [
            { "accountId": creator_account_id, "displayName": "Admin", "avatarUrl": null, "role": "admin" },
            { "accountId": member_account_id, "displayName": "Member", "avatarUrl": null, "role": "admin" }
        ],
        "memberLeaves": [],
        "message": null
    });
    format!(
        "{GROUP_CONTROL_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn group_invitation_requires_explicit_acceptance_and_never_creates_contacts() {
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
    let seed_body = group_control_body(&group_id, &admin_id, &member_id);
    persist_cloud_message(
        &pool,
        PersistCloudMessageInput {
            message_id: &format!("msg_{}", uuid::Uuid::new_v4().simple()),
            from_account_id: &admin_id,
            to_account_id: &member_id,
            client_message_id: Some(&format!("group-seed:{}", uuid::Uuid::new_v4().simple())),
            body: &seed_body,
            session_id: Some(&group_id),
            created_at: &now,
            delivered_at: &now,
            read_at: None,
            attachments: &[],
            claim_legacy_self_replay: false,
        },
    )
    .await
    .unwrap();

    let forged = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &member_token,
            json!({
                "peerAccountId": member_id,
                "body": forged_admin_control_body(&group_id, &admin_id, &member_id),
                "sessionId": group_id,
                "clientMessageId": format!("forged-group-admin:{}", uuid::Uuid::new_v4().simple())
            }),
        ))
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::CREATED);
    let forged_create = router
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
    assert_eq!(forged_create.status(), StatusCode::FORBIDDEN);

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
    let token = invite_url.rsplit('/').next().unwrap().to_string();
    assert!(token.starts_with("kordi_gi_"));

    let active = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/invitations/groups/active/{group_id}"),
            &admin_token,
        ))
        .await
        .unwrap();
    let active_body = read_json(active).await;
    assert_eq!(active_body["invitations"][0]["invitationId"], invitation_id);

    let stored_token_hash: (String,) = sqlx_core::query_as::query_as(
        "SELECT token_hash FROM cloud_group_invitations WHERE invitation_id = $1",
    )
    .bind(invitation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(
        stored_token_hash.0, token,
        "the bearer token must never be stored raw"
    );

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

    let contacts_before: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_contacts WHERE account_id = $1 OR peer_account_id = $1",
    )
    .bind(&recipient_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(contacts_before.0, 0);

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

    let joined_message: (String,) = sqlx_core::query_as::query_as(
        "SELECT body FROM cloud_messages \
         WHERE from_account_id = $1 AND to_account_id = $2 AND session_id = $3 \
           AND client_message_id LIKE 'group-invitation:%' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&admin_id)
    .bind(&recipient_id)
    .bind(&group_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(joined_message.0.starts_with(GROUP_CONTROL_PREFIX));

    let duplicate = router
        .clone()
        .oneshot(post_with_token(
            &format!("/v1/cloud/invitations/groups/accept/{token}"),
            &recipient_token,
        ))
        .await
        .unwrap();
    let duplicate_body = read_json(duplicate).await;
    assert_eq!(duplicate_body["status"], "already_joined");

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

    let latest_control: (String,) = sqlx_core::query_as::query_as(
        "SELECT body FROM cloud_messages WHERE session_id = $1 AND body LIKE $2 \
         ORDER BY created_at DESC, message_id DESC LIMIT 1",
    )
    .bind(&group_id)
    .bind(format!("{GROUP_CONTROL_PREFIX}%"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let encoded = latest_control.0.strip_prefix(GROUP_CONTROL_PREFIX).unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    let participant_ids = value["participants"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|participant| participant["accountId"].as_str())
        .collect::<Vec<_>>();
    assert!(participant_ids.contains(&second_id.as_str()));
    assert!(participant_ids.contains(&third_id.as_str()));

    let mut blocker = pool.begin().await.unwrap();
    sqlx_core::query::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&group_id)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let pending_accept = tokio::spawn({
        let router = router.clone();
        let token = token.clone();
        let member_token = member_token.clone();
        async move {
            router
                .oneshot(post_with_token(
                    &format!("/v1/cloud/invitations/groups/accept/{token}"),
                    &member_token,
                ))
                .await
                .unwrap()
        }
    });
    let mut accept_is_waiting = false;
    for _ in 0..100 {
        let waiting: (bool,) = sqlx_core::query_as::query_as(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity \
             WHERE wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        if waiting.0 {
            accept_is_waiting = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        accept_is_waiting,
        "acceptance did not reach the group lock before revocation"
    );

    let revoke = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/invitations/groups/{invitation_id}"),
            &admin_token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::NO_CONTENT);
    blocker.commit().await.unwrap();

    let raced_accept = pending_accept.await.unwrap();
    assert_eq!(raced_accept.status(), StatusCode::NOT_FOUND);

    let active_after_revoke = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/invitations/groups/active/{group_id}"),
            &admin_token,
        ))
        .await
        .unwrap();
    let active_after_revoke = read_json(active_after_revoke).await;
    assert_eq!(active_after_revoke["invitations"], json!([]));

    let revoked_preview = router
        .clone()
        .oneshot(get(&format!(
            "/v1/cloud/invitations/groups/resolve/{token}"
        )))
        .await
        .unwrap();
    assert_eq!(revoked_preview.status(), StatusCode::NOT_FOUND);
}
