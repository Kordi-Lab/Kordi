use super::*;

#[tokio::test]
async fn private_agent_fork_preserves_lineage_on_bootstrap_and_retry() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "fork-owner").await;
    let parent_id = format!("session:self-agent:{}", Uuid::new_v4());
    let child_id = format!("session:self-agent:{}", Uuid::new_v4());
    let request = |id: &str| CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Ai,
        shared_title: None,
        client_session_id: id.into(),
        member_account_ids: vec![],
    };
    store::create_conversation(&pool, &owner, request(&parent_id))
        .await
        .unwrap();
    let child_request = request(&child_id);
    let child = store::create_conversation(&pool, &owner, child_request.clone())
        .await
        .unwrap();
    query("INSERT INTO cloud_session_forks (fork_session_id,parent_session_id,parent_message_id,created_by_account_id,created_at) VALUES ($1,$2,$3,$4,$5)")
        .bind(&child_id).bind(&parent_id).bind("msg:parent").bind(&owner)
        .bind(chrono::Utc::now().to_rfc3339()).execute(&pool).await.unwrap();
    let bootstrap = store::bootstrap(&pool, &owner).await.unwrap();
    let snapshot = bootstrap
        .conversations
        .iter()
        .find(|item| item.id == child.value.id)
        .unwrap();
    assert_eq!(
        snapshot.forked_from_session_id.as_deref(),
        Some(parent_id.as_str())
    );
    assert_eq!(
        snapshot.forked_from_message_id.as_deref(),
        Some("msg:parent")
    );
    let retry = store::create_conversation(&pool, &owner, child_request)
        .await
        .unwrap();
    assert!(!retry.inserted);
    assert_eq!(retry.value.id, child.value.id);
}
