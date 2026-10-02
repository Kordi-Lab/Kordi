use super::*;

/// The group's newest stored message: (kind, sender, first text block).
async fn newest_message(group: &Group) -> (String, String, String) {
    query_as(
        "SELECT message_kind, sender_account_id, content #>> '{blocks,0,text}'
         FROM cloud_chat_messages WHERE conversation_id=$1
         ORDER BY conversation_sequence DESC LIMIT 1",
    )
    .bind(group.conversation)
    .fetch_one(&group.pool)
    .await
    .unwrap()
}

async fn notice_count(group: &Group) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_messages
         WHERE conversation_id=$1 AND message_kind='ai-access-notice'",
    )
    .bind(group.conversation)
    .fetch_one(&group.pool)
    .await
    .unwrap();
    count
}

fn decoded_group_text(body: &str) -> String {
    let encoded = body
        .strip_prefix("kordi-cloud-group:")
        .expect("group envelope");
    let envelope: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    envelope["message"]["text"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn new_groups_start_mention_only_without_pip() {
    let Some(group) = Group::new("settings-new").await else {
        return;
    };
    for reference in [
        urlencoding_session(&group.session),
        group.conversation.to_string(),
    ] {
        let (status, body) = call(
            &group.router,
            request(
                "GET",
                &format!("/v2/chat/conversations/{reference}/ai-access"),
                Some(&group.owner.token),
                None,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["conversation_id"], group.conversation.to_string());
        let access = &body["ai_access"];
        assert_eq!(access["history_scope"], "mentions");
        assert_eq!(access["pip"]["enabled"], false);
        assert_eq!(access["excluded_member_ids"], json!([]));
        assert_eq!(access["viewer_can_manage"], true);
    }
    let (status, member_view) = call(
        &group.router,
        request(
            "GET",
            &format!("/v2/chat/conversations/{}/ai-access", group.conversation),
            Some(&group.member.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(member_view["ai_access"]["viewer_can_manage"], false);
    let (status, features) = call(
        &group.router,
        request(
            "GET",
            "/v2/chat/ai-features",
            Some(&group.member.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(features["pip"]["available"].is_boolean());
    // Creating a group never posts a notice or adds PiP.
    assert_eq!(notice_count(&group).await, 0);
}

#[tokio::test]
async fn an_opt_out_is_announced_and_projected_to_every_member() {
    let Some(group) = Group::new("settings-opt-out").await else {
        return;
    };
    let (status, body) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let access = &body["conversation"]["ai_access"];
    assert_eq!(access["viewer_excluded"], true);
    assert_eq!(
        access["excluded_member_ids"],
        json!([group.member.account_id])
    );

    let (kind, sender, text) = newest_message(&group).await;
    assert_eq!(kind, "ai-access-notice");
    assert_eq!(sender, group.member.account_id);
    let text = decoded_group_text(&text);
    assert!(
        text.starts_with("Morgan Member turned on \u{201c}Don't let AI use my messages.\u{201d}"),
        "{text}"
    );
    // Every member's devices receive the new projection.
    let updates: Vec<(String, Value)> = query_as(
        "SELECT account_id, payload FROM cloud_chat_user_sync_events
         WHERE conversation_id=$1 AND event_type='conversation.updated'",
    )
    .bind(group.conversation)
    .fetch_all(&group.pool)
    .await
    .unwrap();
    for account in [
        &group.owner,
        &group.requester,
        &group.member,
        &group.member2,
    ] {
        let (_, payload) = updates
            .iter()
            .find(|(recipient, _)| recipient == &account.account_id)
            .expect("every member hears about the change");
        assert_eq!(
            payload["conversation"]["ai_access"]["excluded_member_ids"],
            json!([group.member.account_id])
        );
        assert_eq!(
            payload["conversation"]["ai_access"]["viewer_excluded"],
            account.account_id == group.member.account_id
        );
    }

    // The same value again changes nothing and posts nothing.
    let (status, _) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(notice_count(&group).await, 1);
    let (status, body) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": false}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["conversation"]["ai_access"]["excluded_member_ids"],
        json!([])
    );
    assert_eq!(notice_count(&group).await, 2);
}

#[tokio::test]
async fn only_owners_and_admins_change_group_settings() {
    let Some(group) = Group::new("settings-managers").await else {
        return;
    };
    let (status, body) = group
        .set_ai_access(&group.requester, json!({"history_scope": "recent"}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "CHAT_FORBIDDEN");
    let outsider = signup(&group.router, "settings-outsider", "Outsider").await;
    let (status, body) = group
        .set_ai_access(&outsider, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "CHAT_FORBIDDEN");
    let (status, _) = call(
        &group.router,
        request(
            "GET",
            &format!("/v2/chat/conversations/{}/ai-access", group.conversation),
            Some(&outsider.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(notice_count(&group).await, 0);

    let (status, body) = group
        .set_ai_access(&group.owner, json!({"history_scope": "recent"}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"]["ai_access"]["history_scope"], "recent");
    let (kind, sender, text) = newest_message(&group).await;
    assert_eq!(
        (kind.as_str(), sender.as_str()),
        ("ai-access-notice", group.owner.account_id.as_str())
    );
    assert_eq!(
        decoded_group_text(&text),
        "Olive Owner let agents read recent messages in this group when someone asks them."
    );
}

#[tokio::test]
async fn invalid_and_reused_requests_are_refused() {
    let Some(group) = Group::new("settings-invalid").await else {
        return;
    };
    let path = format!("/v2/chat/conversations/{}/ai-access", group.conversation);
    let put = |token: &str, body: Value| request("PUT", &path, Some(token), Some(body));
    for body in [
        json!({"client_operation_id": Uuid::new_v4()}),
        json!({"client_operation_id": Uuid::new_v4(), "history_scope": "recent", "pip_enabled": false}),
        json!({"client_operation_id": Uuid::new_v4(), "history_scope": "everything"}),
        json!({"client_operation_id": Uuid::new_v4(), "unknown_setting": true}),
    ] {
        let (status, error) = call(&group.router, put(&group.owner.token, body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"]["code"], "INVALID_AI_ACCESS");
    }
    let (status, error) = call(
        &group.router,
        request(
            "PUT",
            &format!("/v2/chat/conversations/{}/ai-access", Uuid::new_v4()),
            Some(&group.owner.token),
            Some(json!({"client_operation_id": Uuid::new_v4(), "exclude_my_messages": true})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error["error"]["code"], "CHAT_ENTITY_NOT_FOUND");

    // A direct conversation has no group settings, but members can opt out.
    let mut pair = [
        group.owner.account_id.clone(),
        group.requester.account_id.clone(),
    ];
    pair.sort();
    let direct = urlencoding_session(&format!("session:direct-person:{}:{}", pair[0], pair[1]));
    let direct_path = format!("/v2/chat/conversations/{direct}/ai-access");
    let (status, error) = call(
        &group.router,
        request(
            "PUT",
            &direct_path,
            Some(&group.owner.token),
            Some(json!({"client_operation_id": Uuid::new_v4(), "history_scope": "recent"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "INVALID_AI_ACCESS");
    let (status, body) = call(
        &group.router,
        request(
            "PUT",
            &direct_path,
            Some(&group.requester.token),
            Some(json!({"client_operation_id": Uuid::new_v4(), "exclude_my_messages": true})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"]["ai_access"]["history_scope"], "recent");
    assert_eq!(body["conversation"]["ai_access"]["viewer_excluded"], true);

    // One operation id names one change.
    let operation = Uuid::new_v4();
    let (status, _) = call(
        &group.router,
        put(
            &group.member.token,
            json!({"client_operation_id": operation, "exclude_my_messages": true}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &group.router,
        put(
            &group.member.token,
            json!({"client_operation_id": operation, "exclude_my_messages": true}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "a retry returns the stored result");
    assert_eq!(notice_count(&group).await, 1);
    let (status, error) = call(
        &group.router,
        put(
            &group.member.token,
            json!({"client_operation_id": operation, "exclude_my_messages": false}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "IDEMPOTENCY_KEY_REUSED");
}

#[tokio::test]
async fn pip_cannot_be_turned_on_without_pip_and_clients_cannot_send_notices() {
    let Some(group) = Group::new("settings-reserved").await else {
        return;
    };
    if kordi_cloud_server::pip::service_account_id().is_none() {
        let (status, error) = group
            .set_ai_access(&group.owner, json!({"pip_enabled": true}))
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], "PIP_UNAVAILABLE");
    }
    let (status, error) = call(
        &group.router,
        request(
            "POST",
            &format!("/v2/chat/conversations/{}/messages", group.conversation),
            Some(&group.member.token),
            Some(json!({
                "client_message_id": Uuid::now_v7(),
                "kind": "ai-access-notice",
                "content": {"schema": 1, "blocks": [{"type": "text", "text": "Imitation"}]},
                "reply_to_message_id": null,
            })),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "RESERVED_MESSAGE_KIND");
    assert_eq!(notice_count(&group).await, 0);
}

#[tokio::test]
async fn a_member_who_leaves_stays_excluded_for_device_filters() {
    let Some(group) = Group::new("settings-left").await else {
        return;
    };
    let (status, body) = group
        .set_ai_access(&group.member, json!({"exclude_my_messages": true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["conversation"]["ai_access"]["excluded_account_ids"],
        json!([group.member.account_id])
    );
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left', left_at = now()
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(group.conversation)
    .bind(&group.member.account_id)
    .execute(&group.pool)
    .await
    .unwrap();
    let (status, view) = call(
        &group.router,
        request(
            "GET",
            &format!("/v2/chat/conversations/{}/ai-access", group.conversation),
            Some(&group.owner.token),
            None,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    // Settings list only people still here; device filters keep everyone.
    assert_eq!(view["ai_access"]["excluded_member_ids"], json!([]));
    assert_eq!(
        view["ai_access"]["excluded_account_ids"],
        json!([group.member.account_id])
    );
}
