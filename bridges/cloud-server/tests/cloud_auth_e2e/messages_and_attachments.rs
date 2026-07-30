use super::*;

#[tokio::test]
async fn cloud_self_messages_are_private_to_the_signed_in_account() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("self-message");
    let other_email = unique_email("self-message-other");
    let state = Arc::new(ServerState::new(pool, EventBus::noop()));
    let router = fast_router(state);

    let signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let signup_json = read_json(signup_resp).await;
    let token = signup_json["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let account_id = signup_json["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let other_signup_resp = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&other_email, "correct horse"),
        ))
        .await
        .unwrap();
    let other_signup_body = read_json(other_signup_resp).await;
    let other_token = other_signup_body["session"]["token"]
        .as_str()
        .unwrap()
        .to_string();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &token,
            json!({
                "peerAccountId": account_id,
                "body": "@Kordi remember this private note",
                "sessionId": "f51f7d19-8c8f-4228-9cdd-074ae9b2146e",
            }),
        ))
        .await
        .unwrap();
    let send_status = send_resp.status();
    let send_body = read_json(send_resp).await;
    assert_eq!(send_status, StatusCode::CREATED, "got body {send_body}");

    let self_list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(self_list_resp.status(), StatusCode::OK);
    let self_list = read_json(self_list_resp).await;
    assert_eq!(self_list["messages"].as_array().unwrap().len(), 1);
    assert_eq!(
        self_list["messages"][0]["body"],
        "@Kordi remember this private note"
    );
    assert_eq!(
        self_list["messages"][0]["sessionId"],
        "f51f7d19-8c8f-4228-9cdd-074ae9b2146e"
    );
    assert_eq!(self_list["messages"][0]["fromAccountId"], account_id);
    assert_eq!(self_list["messages"][0]["toAccountId"], account_id);

    let other_list_resp = router
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={account_id}"),
            &other_token,
        ))
        .await
        .unwrap();
    assert_eq!(other_list_resp.status(), StatusCode::OK);
    let other_list = read_json(other_list_resp).await;
    assert_eq!(other_list["messages"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn cloud_messages_preserve_attachment_metadata_and_enforce_attachment_ownership() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("attachments-owner");
    let other_email = unique_email("attachments-other");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let owner_body = read_json(owner_signup).await;
    let owner_token = owner_body["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let other_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&other_email, "correct horse"),
        ))
        .await
        .unwrap();
    let other_body = read_json(other_signup).await;
    let other_token = other_body["session"]["token"].as_str().unwrap().to_string();
    let other_account_id = other_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_attachments \
         (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6)",
    )
    .bind("att_owner")
    .bind(&owner_account_id)
    .bind("attachments/test/att_owner")
    .bind("image/png")
    .bind(123_i64)
    .bind("2026-05-12T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &owner_token,
            json!({
                "peerAccountId": owner_account_id,
                "body": "",
                "attachments": [{
                    "attachmentId": "att_owner",
                    "name": "screen.png",
                    "kind": "image",
                    "mimeType": "image/png",
                    "sizeBytes": 123,
                    "previewUrl": "data:image/webp;base64,compressed-preview"
                }]
            }),
        ))
        .await
        .unwrap();
    let send_status = send_resp.status();
    let send_body = read_json(send_resp).await;
    assert_eq!(send_status, StatusCode::CREATED, "got body {send_body}");
    assert_eq!(send_body["message"]["body"], "");
    assert_eq!(
        send_body["message"]["attachments"][0]["attachmentId"],
        "att_owner"
    );
    assert_eq!(send_body["message"]["attachments"][0]["name"], "screen.png");
    assert!(send_body["message"]["attachments"][0]["downloadUrl"].is_null());
    assert_eq!(
        send_body["message"]["attachments"][0]["previewUrl"],
        "data:image/webp;base64,compressed-preview"
    );

    let list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &owner_token,
        ))
        .await
        .unwrap();
    let list_body = read_json(list_resp).await;
    assert_eq!(
        list_body["messages"][0]["attachments"][0]["attachmentId"],
        "att_owner"
    );
    assert!(list_body["messages"][0]["attachments"][0]["downloadUrl"].is_null());
    assert_eq!(
        list_body["messages"][0]["attachments"][0]["previewUrl"],
        "data:image/webp;base64,compressed-preview"
    );

    let forbidden_resp = router
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &other_token,
            json!({
                "peerAccountId": other_account_id,
                "body": "steal",
                "attachments": [{
                    "attachmentId": "att_owner",
                    "name": "screen.png",
                    "kind": "image"
                }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(forbidden_resp.status(), StatusCode::FORBIDDEN);
    let forbidden_body = read_json(forbidden_resp).await;
    assert_eq!(forbidden_body["errorCode"], "invalid_attachment");
}

#[tokio::test]
async fn cloud_attachment_preview_recovery_updates_old_message_links() {
    let Some(pool) = try_pool().await else { return };
    let email = unique_email("preview-recovery-owner");
    let other_email = unique_email("preview-recovery-other");
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);

    let owner_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&email, "correct horse"),
        ))
        .await
        .unwrap();
    let owner_body = read_json(owner_signup).await;
    let owner_token = owner_body["session"]["token"].as_str().unwrap().to_string();
    let owner_account_id = owner_body["account"]["accountId"]
        .as_str()
        .unwrap()
        .to_string();

    let other_signup = router
        .clone()
        .oneshot(post(
            "/v1/cloud/auth/signup",
            signup_body(&other_email, "correct horse"),
        ))
        .await
        .unwrap();
    let other_body = read_json(other_signup).await;
    let other_token = other_body["session"]["token"].as_str().unwrap().to_string();

    sqlx_core::query::query(
        "INSERT INTO cloud_attachments \
         (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6)",
    )
    .bind("att_recover_old")
    .bind(&owner_account_id)
    .bind("attachments/test/att_recover_old")
    .bind("image/png")
    .bind(24_i64 * 1024 * 1024)
    .bind("2026-05-12T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    let send_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/messages",
            &owner_token,
            json!({
                "peerAccountId": owner_account_id,
                "body": "old image",
                "attachments": [{
                    "attachmentId": "att_recover_old",
                    "name": "old.png",
                    "kind": "image",
                    "mimeType": "image/png",
                    "sizeBytes": 25165824
                }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(send_resp.status(), StatusCode::CREATED);

    let forbidden_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/att_recover_old/preview",
            &other_token,
            json!({ "previewUrl": "data:image/webp;base64,recovered-preview" }),
        ))
        .await
        .unwrap();
    assert_eq!(forbidden_resp.status(), StatusCode::NOT_FOUND);

    let update_resp = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/attachments/att_recover_old/preview",
            &owner_token,
            json!({ "previewUrl": "data:image/webp;base64,recovered-preview" }),
        ))
        .await
        .unwrap();
    let update_status = update_resp.status();
    let update_body = read_json(update_resp).await;
    assert_eq!(update_status, StatusCode::OK, "got body {update_body}");
    assert_eq!(update_body["attachmentId"], "att_recover_old");
    assert_eq!(
        update_body["previewUrl"],
        "data:image/webp;base64,recovered-preview"
    );
    assert_eq!(update_body["updatedLinks"], 1);

    let list_resp = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/messages?peerAccountId={owner_account_id}"),
            &owner_token,
        ))
        .await
        .unwrap();
    let list_body = read_json(list_resp).await;
    assert_eq!(
        list_body["messages"][0]["attachments"][0]["previewUrl"],
        "data:image/webp;base64,recovered-preview"
    );
}
