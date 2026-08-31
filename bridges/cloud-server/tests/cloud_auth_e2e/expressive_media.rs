use super::*;

#[tokio::test]
async fn saved_media_delete_is_account_scoped_and_cannot_be_resurrected() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (owner_token, owner_id) = signup_account(&router, "media-delete-owner").await;
    let (stranger_token, _) = signup_account(&router, "media-delete-stranger").await;
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let attachment_id = format!("attachment-{suffix}");
    let item_id = format!("media-{suffix}");
    let now = chrono::Utc::now().to_rfc3339();

    sqlx_core::query::query(
        "INSERT INTO cloud_attachments \
         (attachment_id, owner_account_id, object_key, content_type, size_bytes, created_at, finalized_at) \
         VALUES ($1, $2, $3, 'image/webp', 4, $4, $4)",
    )
    .bind(&attachment_id)
    .bind(&owner_id)
    .bind(format!("attachments/{owner_id}/{attachment_id}"))
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    sqlx_core::query::query(
        "INSERT INTO cloud_expressive_media_items \
         (item_id, account_id, attachment_id, kind, name, mime_type, size_bytes, created_at, updated_at) \
         VALUES ($1, $2, $3, 'sticker', 'saved.webp', 'image/webp', 4, $4, $4)",
    )
    .bind(&item_id)
    .bind(&owner_id)
    .bind(&attachment_id)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    let stranger_delete = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/expressive-media/{item_id}"),
            &stranger_token,
        ))
        .await
        .unwrap();
    assert_eq!(stranger_delete.status(), StatusCode::NO_CONTENT);

    let before = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/expressive-media", &owner_token))
        .await
        .unwrap();
    assert_eq!(
        read_json(before).await["items"].as_array().unwrap().len(),
        1
    );

    let deleted = router
        .clone()
        .oneshot(delete_with_token(
            &format!("/v1/cloud/expressive-media/{attachment_id}"),
            &owner_token,
        ))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

    let after = router
        .clone()
        .oneshot(get_with_token("/v1/cloud/expressive-media", &owner_token))
        .await
        .unwrap();
    assert!(read_json(after).await["items"]
        .as_array()
        .unwrap()
        .is_empty());

    let tombstone: (Option<String>,) = sqlx_core::query_as::query_as(
        "SELECT deleted_at FROM cloud_expressive_media_items WHERE item_id = $1",
    )
    .bind(&item_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(tombstone.0.is_some());

    let restore = router
        .oneshot(post_json_with_token(
            "/v1/cloud/expressive-media",
            &owner_token,
            json!({
                "attachmentId": attachment_id,
                "kind": "sticker",
                "name": "saved.webp",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(restore.status(), StatusCode::CONFLICT);
    assert_eq!(read_json(restore).await["errorCode"], "media_deleted");
}
