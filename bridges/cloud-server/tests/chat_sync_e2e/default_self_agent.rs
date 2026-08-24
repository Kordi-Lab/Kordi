use super::*;

#[tokio::test]
async fn legacy_default_self_agent_session_is_independent_per_account() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping default self-agent session test");
        return;
    };
    let first = account(&pool, "default-agent-first").await;
    let second = account(&pool, "default-agent-second").await;

    let first_conversation = store::create_conversation(
        &pool,
        &first,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: None,
            client_session_id: "session:self-agent:default".to_string(),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .expect("create first default self-agent conversation")
    .value;
    let second_conversation = store::create_conversation(
        &pool,
        &second,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Ai,
            shared_title: None,
            client_session_id: "session:self-agent:default".to_string(),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .expect("create second default self-agent conversation")
    .value;
    let first_session_id = format!("session:self-agent:{first}:default");
    let second_session_id = format!("session:self-agent:{second}:default");

    assert_eq!(
        first_conversation.legacy_session_id.as_deref(),
        Some(first_session_id.as_str())
    );
    assert_eq!(
        second_conversation.legacy_session_id.as_deref(),
        Some(second_session_id.as_str())
    );
    assert_ne!(first_conversation.id, second_conversation.id);
    assert_eq!(first_conversation.members.len(), 1);
    assert_eq!(second_conversation.members.len(), 1);
}
