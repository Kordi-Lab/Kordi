//! Participant messages in an agent subsession share the sender's message
//! budget, and messages that run the agent share the agent run budget.

use super::*;
use kordi_cloud_server::auth::rate_limit::{AGENT_RUN_CLAIM_LIMIT, MESSAGE_SEND_LIMIT};

/// A finished subsession of the owner's default agent in a group the peer
/// belongs to.
async fn group_subsession(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    peer: &TestAccount,
) -> uuid::Uuid {
    let session_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Group,
        vec![peer.account_id.clone()],
    )
    .await;
    let id = uuid::Uuid::new_v4();
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_subsessions(subsession_id,parent_conversation_id,parent_session_id,parent_request_id,owner_account_id,publisher_device_id,execution_backend,agent_id,title,status) \
         VALUES($1,$2,$3,$4,$5,'budget-device','cloud','cloud-agent:'||$5,'Budget task','done')",
    )
    .bind(id)
    .bind(conversation)
    .bind(&session_id)
    .bind(format!("budget-request-{id}"))
    .bind(&owner.account_id)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn subsession_message(invoked_agent: Option<&str>) -> Value {
    let mentions = invoked_agent
        .map(|agent| {
            vec![json!({
                "label": "Kordi", "targetKind": "agent", "agentId": agent,
                "targetIdentityId": agent, "startUtf16": 0, "lengthUtf16": 6
            })]
        })
        .unwrap_or_default();
    json!({
        "clientMessageId": uuid::Uuid::new_v4(),
        "text": "@Kordi continue the comparison",
        "mentions": mentions,
    })
}

async fn subsession_runs(pool: &sqlx_postgres::PgPool, id: uuid::Uuid) -> i64 {
    let (count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE subsession_id=$1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

async fn setup() -> Option<(
    sqlx_postgres::PgPool,
    Arc<ServerState>,
    TestAccount,
    TestAccount,
    uuid::Uuid,
)> {
    let pool = try_pool().await?;
    let state = Arc::new(signup_email_fixture::state(pool.clone()));
    let setup = test_router(state.clone());
    let owner = signup(&setup, "subsession-budget-owner", "Owner").await;
    let peer = signup(&setup, "subsession-budget-peer", "Peer").await;
    accept_contacts(&setup, &owner, &peer).await;
    let id = group_subsession(&pool, &owner, &peer).await;
    Some((pool, state, owner, peer, id))
}

#[tokio::test]
async fn subsession_agent_invocations_share_the_agent_run_budget() {
    let Some((pool, state, owner, peer, id)) = setup().await else {
        return;
    };
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    for _ in 1..AGENT_RUN_CLAIM_LIMIT.limit {
        limiter
            .observe_account_limit(AGENT_RUN_CLAIM_LIMIT, &peer.account_id)
            .await;
    }
    let router = router_with_rate_limiter(state, limiter);
    let uri = format!("/v1/cloud/agent-subsessions/{id}/messages");
    let agent = format!("cloud-agent:{}", owner.account_id);

    let last_allowed = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &peer.token,
            subsession_message(Some(&agent)),
        ))
        .await
        .unwrap();
    assert_eq!(last_allowed.status(), StatusCode::OK);
    assert_eq!(subsession_runs(&pool, id).await, 1);

    let limited = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &peer.token,
            subsession_message(Some(&agent)),
        ))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(read_json(limited).await["error"]["code"], "rate_limited");
    assert_eq!(
        subsession_runs(&pool, id).await,
        1,
        "a refused invocation queues no agent run"
    );

    let conversation = router
        .clone()
        .oneshot(post_json_with_token(
            &uri,
            &peer.token,
            subsession_message(None),
        ))
        .await
        .unwrap();
    assert_eq!(
        conversation.status(),
        StatusCode::OK,
        "messages that do not run the agent use only the message budget"
    );

    // Keep the shared runner queue free of this test's run.
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET status='cancelled', updated_at=$2 \
         WHERE subsession_id=$1 AND status='queued'",
    )
    .bind(id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn subsession_messages_share_the_message_budget() {
    let Some((pool, state, _owner, peer, id)) = setup().await else {
        return;
    };
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    for _ in 0..MESSAGE_SEND_LIMIT.limit {
        limiter
            .observe_account_limit(MESSAGE_SEND_LIMIT, &peer.account_id)
            .await;
    }
    let router = router_with_rate_limiter(state, limiter);
    let limited = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-subsessions/{id}/messages"),
            &peer.token,
            subsession_message(None),
        ))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    let (stored,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT count(*) FROM cloud_agent_subsession_chat WHERE subsession_id=$1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, 0);
}
