//! Agent task threads live inside their parent conversation. In a direct chat
//! between people who are no longer contacts, nobody can post to them or
//! publish new task content, while the history stays readable.
use super::*;

fn put_json_with_token(uri: &str, token: &str, body: &Value) -> Request<Body> {
    Request::builder()
        .method("PUT")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn send(router: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

fn refused(result: (StatusCode, Value)) {
    assert_eq!(result.0, StatusCode::FORBIDDEN, "{}", result.1);
    assert_eq!(result.1["error"]["code"], "CHAT_RELATIONSHIP_REQUIRED");
}

async fn set_contacts(pool: &sqlx_postgres::PgPool, a: &TestAccount, b: &TestAccount, on: bool) {
    sqlx_core::query::query(
        "DELETE FROM cloud_contacts WHERE (account_id = $1 AND peer_account_id = $2) \
         OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(&a.account_id)
    .bind(&b.account_id)
    .execute(pool)
    .await
    .unwrap();
    if on {
        sqlx_core::query::query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, now()::text), ($2, $1, now()::text)",
        )
        .bind(&a.account_id)
        .bind(&b.account_id)
        .execute(pool)
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn task_threads_in_a_direct_chat_stop_with_the_contact() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "consent-thread-owner", "Owner").await;
    let peer = signup(&router, "consent-thread-peer", "Peer").await;
    accept_contacts(&router, &peer, &owner).await;
    let mut ids = [owner.account_id.clone(), peer.account_id.clone()];
    ids.sort();
    let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    let conversation = chat_store::conversation_id_for_session(&pool, &owner.account_id, &session)
        .await
        .unwrap()
        .expect("accepting a request opens the direct chat");
    let request = format!(
        "kordi-cloud-message:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            json!({"schemaVersion": 1, "kind": "message", "text": "@Kordi plan this",
                   "targetCloudAgentId": format!("cloud-agent:{}", owner.account_id),
                   "targetCloudAgentOwnerAccountId": owner.account_id})
            .to_string()
        )
    );
    let request_id = insert_test_message(&pool, &peer.account_id, conversation, &request).await;
    let snapshot = |title: &str, version: i64, status: &str| {
        json!({"parentSessionId": session, "parentRequestId": request_id, "title": title,
               "status": status, "expectedVersion": version,
               "messages": [{"id": "input", "role": "user", "text": "Task brief",
                             "timestampMs": 1000}]})
    };
    let id = uuid::Uuid::new_v4();
    let uri = format!("/v1/cloud/agent-subsessions/{id}");
    let messages = format!("{uri}/messages");
    let post = |account: &TestAccount, text: &str| {
        post_json_with_token(
            &messages,
            &account.token,
            json!({"clientMessageId": uuid::Uuid::new_v4(), "text": text}),
        )
    };
    let (status, created) = send(
        &router,
        put_json_with_token(&uri, &owner.token, &snapshot("Plan", 0, "running")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (status, _) = send(&router, post(&peer, "Context while contacts")).await;
    assert_eq!(status, StatusCode::OK);
    // The owner asks their own agent to continue the thread while they are
    // contacts; the run waits in the queue.
    let mention = json!([{"label": "Kordi", "targetKind": "agent",
                          "agentId": format!("cloud-agent:{}", owner.account_id),
                          "startUtf16": 0, "lengthUtf16": 6}]);
    let (status, body) = send(
        &router,
        post_json_with_token(
            &messages,
            &owner.token,
            json!({"clientMessageId": uuid::Uuid::new_v4(), "text": "@Kordi continue",
                   "mentions": mention}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (follow_up,): (String,) = sqlx_core::query_as::query_as(
        "SELECT run_id FROM cloud_agent_fallback_runs WHERE subsession_id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();

    for blocker in [None, Some(&peer), Some(&owner)] {
        set_contacts(&pool, &owner, &peer, blocker.is_some()).await;
        if let Some(blocker) = blocker {
            let blocked = if blocker.account_id == peer.account_id {
                &owner
            } else {
                &peer
            };
            sqlx_core::query::query(
                "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) \
                 VALUES ($1, $2)",
            )
            .bind(&blocker.account_id)
            .bind(&blocked.account_id)
            .execute(&pool)
            .await
            .unwrap();
        }
        for account in [&peer, &owner] {
            refused(send(&router, post(account, "After the contact ended")).await);
        }
        let (_, current) = send(&router, get_with_token(&uri, &peer.token)).await;
        let version = current["version"].as_i64().unwrap();
        refused(
            send(
                &router,
                put_json_with_token(&uri, &owner.token, &snapshot("Renamed", version, "running")),
            )
            .await,
        );
        let other = format!("/v1/cloud/agent-subsessions/{}", uuid::Uuid::new_v4());
        refused(
            send(
                &router,
                put_json_with_token(&other, &owner.token, &snapshot("New", 0, "running")),
            )
            .await,
        );
        sqlx_core::query::query("DELETE FROM cloud_account_blocks WHERE blocker_account_id = $1")
            .bind(
                blocker
                    .map(|account| account.account_id.clone())
                    .unwrap_or_default(),
            )
            .execute(&pool)
            .await
            .unwrap();
    }

    // The record stays readable, and the owner's desktop can still finish it.
    set_contacts(&pool, &owner, &peer, false).await;
    let (status, current) = send(
        &router,
        get_with_token(&format!("{uri}?includeMessages=true"), &peer.token),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(current["title"], "Plan");
    let texts = current["messages"].to_string();
    assert!(texts.contains("Context while contacts"));
    assert!(!texts.contains("After the contact ended"));
    let version = current["version"].as_i64().unwrap();
    let (status, finished) = send(
        &router,
        put_json_with_token(&uri, &owner.token, &snapshot("Plan", version, "done")),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{finished}");
    assert_eq!(finished["status"], "done");

    // The owner's queued run would answer inside the chat, so it is cancelled
    // when a runner leases it.
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let (status, lease) = send(
        &router,
        post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({"runnerId": "consent-thread-runner", "canaryRunId": follow_up}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{lease}");
    assert_eq!(lease["run"]["status"], "cancelled", "{lease}");
    let (state,): (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&follow_up)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "cancelled");
}
