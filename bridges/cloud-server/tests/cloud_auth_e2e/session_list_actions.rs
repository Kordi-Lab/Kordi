use super::*;
use kordi_cloud_server::chat_sync::models::{ConversationKind, CreateConversationRequest};
use kordi_cloud_server::chat_sync::store;

fn put_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn chat_list_preferences_are_account_scoped_and_archive_delete_clear_pin() {
    let Some(pool) = try_pool().await else { return };
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let router = fast_router(state);
    let (token, account_id) = signup_account(&router, "session-list-actions").await;
    let session_id = format!("session:self-agent:{}", uuid::Uuid::now_v7());
    store::create_conversation(
        &pool,
        &account_id,
        CreateConversationRequest {
            client_operation_id: uuid::Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: Some("List actions".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .expect("create AI conversation");
    let path = format!("/v1/cloud/sessions/{session_id}");

    for suffix in ["pinned", "muted"] {
        let response = router
            .clone()
            .oneshot(put_with_token(&format!("{path}/{suffix}"), &token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }
    let visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["pinnedSessionIds"], json!([session_id.clone()]));
    assert_eq!(visibility["mutedSessionIds"], json!([session_id.clone()]));

    let archived = router
        .clone()
        .oneshot(put_with_token(&format!("{path}/hidden"), &token))
        .await
        .unwrap();
    assert_eq!(archived.status(), StatusCode::NO_CONTENT);
    let visibility = read_json(
        router
            .clone()
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["hiddenSessionIds"], json!([session_id.clone()]));
    assert_eq!(visibility["pinnedSessionIds"], json!([]));
    assert_eq!(visibility["mutedSessionIds"], json!([session_id.clone()]));

    let deleted = router
        .clone()
        .oneshot(delete_with_token(&path, &token))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let visibility = read_json(
        router
            .oneshot(get_with_token("/v1/cloud/sessions/visibility", &token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(visibility["deletedSessionIds"], json!([session_id]));
    assert_eq!(visibility["pinnedSessionIds"], json!([]));
    assert_eq!(visibility["mutedSessionIds"], json!([]));
}
