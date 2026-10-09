//! A desktop run that ends without a terminal reply gets one from the server,
//! so other devices leave the `processing` state.

use kordi_cloud_server::cloud_agent_runtime::runs::terminal_backfill::{
    backfill_terminal_responses, publish_missing_terminal_response, INTERRUPTED_TEXT,
};

use super::*;

pub(super) fn encode(prefix: &str, value: Value) -> String {
    format!(
        "{prefix}:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string())
    )
}

/// `(deliveryState, text)` of every agent reply to `request` the owner sent.
pub(super) async fn replies(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    session: &str,
    request: &str,
) -> Vec<(String, String)> {
    let rows: Vec<(Option<String>,)> = sqlx_core::query_as::query_as(
        "SELECT m.content #>> '{blocks,0,text}' FROM cloud_chat_messages m \
         JOIN cloud_chat_conversations c USING(conversation_id) \
         WHERE c.legacy_session_id=$1 AND m.sender_account_id=$2 ORDER BY m.conversation_sequence",
    )
    .bind(session)
    .bind(&owner.account_id)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .filter_map(|(body,)| {
            let body = body?;
            let (prefix, encoded) = body.split_once(':')?;
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()?;
            let value: Value = serde_json::from_slice(&bytes).ok()?;
            let reply = if prefix == "kordi-cloud-group" {
                value.get("message")?.clone()
            } else {
                value
            };
            (reply["requestId"] == request).then(|| {
                (
                    reply["deliveryState"].as_str().unwrap_or("").to_string(),
                    reply["text"].as_str().unwrap_or("").to_string(),
                )
            })
        })
        .collect()
}

pub(super) struct Accounts {
    pub(super) owner: TestAccount,
    pub(super) peer: TestAccount,
    pub(super) agent: String,
}

/// An owner whose Mac is ready for its default agent, and a contact.
pub(super) async fn ready_accounts(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
) -> Accounts {
    let owner = signup(router, "terminal-owner", "Owner").await;
    let peer = signup(router, "terminal-peer", "Requester").await;
    accept_contacts(router, &owner, &peer).await;
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(pool)
        .await
        .unwrap();
    let agent = format!("cloud-agent:{}", owner.account_id);
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &owner.token,
            json!({"agentIds":[agent]}),
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
    sqlx_core::query::query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1").bind(&agent).execute(pool).await.unwrap();
    Accounts { owner, peer, agent }
}

pub(super) struct DesktopTurn {
    pub(super) session: String,
    /// The request ID replies carry.
    pub(super) canonical: String,
    pub(super) run: String,
    pub(super) claim_id: uuid::Uuid,
}

/// The owner Mac claims a contact's request and publishes `processing`.
pub(super) async fn processing_desktop_turn(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    accounts: &Accounts,
    group: bool,
) -> DesktopTurn {
    let Accounts { owner, peer, agent } = accounts;
    let session = if group {
        format!("session:group:{}", uuid::Uuid::new_v4())
    } else {
        let mut ids = [owner.account_id.clone(), peer.account_id.clone()];
        ids.sort();
        format!("session:direct-person:{}:{}", ids[0], ids[1])
    };
    let kind = if group {
        ConversationKind::Group
    } else {
        ConversationKind::Direct
    };
    let conversation = create_test_conversation(
        pool,
        &owner.account_id,
        &session,
        kind,
        vec![peer.account_id.clone()],
    )
    .await;
    let logical = uuid::Uuid::new_v4().to_string();
    let request = json!({"schemaVersion":1,"kind":"message","id":logical,"senderAccountId":peer.account_id,"senderKind":"human","text":"@Kordi reply","createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":agent,"targetCloudAgentOwnerAccountId":owner.account_id});
    let group_body = |message: Value| json!({"kind":"group-message","groupId":session,"groupSpaceId":session,"createdByAccountId":owner.account_id,"actor":{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},"participants":[{"accountId":owner.account_id,"displayName":"Owner","role":"admin"},{"accountId":peer.account_id,"displayName":"Requester","role":"person"}],"message":message});
    let body = if group {
        encode("kordi-cloud-group", group_body(request))
    } else {
        encode("kordi-cloud-message", request)
    };
    let wire = insert_test_message(pool, &peer.account_id, conversation, &body).await;
    let claim_id = uuid::Uuid::new_v4();
    let claimed = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            json!({"claimId":claim_id,"requestMessageId":wire,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":peer.account_id,"prompt":"@Kordi reply","idempotencyKey":format!("terminal:{claim_id}")}),
        ))
        .await
        .unwrap();
    let claimed = read_json(claimed).await;
    assert_eq!(claimed["acquired"], true, "{claimed}");
    let run = claimed["runId"].as_str().unwrap().to_string();
    let canonical = if group { logical } else { wire };
    let processing = if group {
        encode(
            "kordi-cloud-group",
            group_body(
                json!({"id":"native-processing","senderAccountId":owner.account_id,"senderAgentId":agent,"senderKind":"agent","text":"Processing","createdAtMs":chrono::Utc::now().timestamp_millis(),"requestId":canonical,"deliveryState":"processing"}),
            ),
        )
    } else {
        encode(
            "kordi-cloud-agent-response",
            json!({"kind":"agent-response","requestId":canonical,"text":"Processing","deliveryState":"processing"}),
        )
    };
    let published = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run}/progress"),
            &owner.token,
            json!({"claimId":claim_id,"clientMessageId":uuid::Uuid::new_v4(),"body":processing}),
        ))
        .await
        .unwrap();
    assert_eq!(published.status(), StatusCode::OK);
    assert_eq!(
        replies(pool, owner, &session, &canonical).await,
        vec![("processing".to_string(), "Processing".to_string())]
    );
    DesktopTurn {
        session,
        canonical,
        run,
        claim_id,
    }
}

fn interrupted() -> (String, String) {
    ("cancelled".to_string(), INTERRUPTED_TEXT.to_string())
}

#[tokio::test]
async fn a_cancelled_desktop_turn_publishes_its_terminal_reply_once() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let owner = &accounts.owner;
    for group in [true, false] {
        let turn = processing_desktop_turn(&router, &pool, &accounts, group).await;
        // The desktop reloads mid-turn and cancels its lease.
        let cancelled = router
            .clone()
            .oneshot(post_json_with_token(
                &format!("/v1/cloud/agent-runs/desktop/{}/cancel", turn.run),
                &owner.token,
                json!({"claimId":turn.claim_id}),
            ))
            .await
            .unwrap();
        assert_eq!(cancelled.status(), StatusCode::OK);
        let after = replies(&pool, owner, &turn.session, &turn.canonical).await;
        assert!(after.contains(&interrupted()), "group={group}: {after:?}");
        // A second pass finds the terminal reply and publishes nothing.
        assert_eq!(
            publish_missing_terminal_response(&pool, &turn.run)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            replies(&pool, owner, &turn.session, &turn.canonical).await,
            after
        );
    }
}

#[tokio::test]
async fn a_restarted_desktop_releases_the_request_it_lost() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let turn = processing_desktop_turn(&router, &pool, &accounts, true).await;
    let release = |token: String| {
        router.clone().oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/interrupted",
            &token,
            json!({"sessionId":turn.session,"requestMessageId":turn.canonical}),
        ))
    };
    // Another account cannot release the owner's run.
    let foreign = read_json(release(accounts.peer.token.clone()).await.unwrap()).await;
    assert_eq!(foreign["released"], false);
    let released = read_json(release(accounts.owner.token.clone()).await.unwrap()).await;
    assert_eq!(
        released,
        json!({"released":true,"closed":true,"published":true})
    );
    let (status,): (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(&turn.run)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "cancelled");
    let after = replies(&pool, &accounts.owner, &turn.session, &turn.canonical).await;
    assert!(after.contains(&interrupted()), "{after:?}");
    let again = read_json(release(accounts.owner.token.clone()).await.unwrap()).await;
    assert_eq!(again["published"], false);
}

#[tokio::test]
async fn the_sweep_releases_a_desktop_run_whose_executor_is_gone() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let turn = processing_desktop_turn(&router, &pool, &accounts, true).await;
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '11 minutes')::text WHERE run_id=$1")
        .bind(&turn.run)
        .execute(&pool)
        .await
        .unwrap();
    backfill_terminal_responses(&pool, 1).await.unwrap();
    let after = replies(&pool, &accounts.owner, &turn.session, &turn.canonical).await;
    assert!(after.contains(&interrupted()), "{after:?}");
}

#[tokio::test]
async fn the_sweep_ends_failed_desktop_runs_that_never_replied() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, "terminal-sweep-owner", "Owner").await;
    let peer = signup(&router, "terminal-sweep-peer", "Peer").await;
    accept_contacts(&router, &owner, &peer).await;
    let mut ids = [owner.account_id.clone(), peer.account_id.clone()];
    ids.sort();
    let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
    create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Direct,
        vec![peer.account_id.clone()],
    )
    .await;
    let request = format!("msg_sweep_{}", uuid::Uuid::new_v4().simple());
    let run = format!("car_sweep_{}", uuid::Uuid::new_v4().simple());
    sqlx_core::query::query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, completed_at, execution_backend, execution_agent_id) \
         VALUES ($1, $1, $2, $3, $4, $5, 'failed', 'reply', now()::text, now()::text, \
         now()::text, 'desktop', $6)",
    )
    .bind(&run)
    .bind(&request)
    .bind(&session)
    .bind(&owner.account_id)
    .bind(&peer.account_id)
    .bind(format!("cloud-agent:{}", owner.account_id))
    .execute(&pool)
    .await
    .unwrap();
    backfill_terminal_responses(&pool, 1).await.unwrap();
    let after = replies(&pool, &owner, &session, &request).await;
    assert_eq!(after.len(), 1, "{after:?}");
    assert_eq!(after[0].0, "failed");
    backfill_terminal_responses(&pool, 1).await.unwrap();
    assert_eq!(replies(&pool, &owner, &session, &request).await, after);
}

async fn run_status(pool: &sqlx_postgres::PgPool, run: &str) -> String {
    let (status,): (String,) = sqlx_core::query_as::query_as(
        "SELECT status FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(run)
    .fetch_one(pool)
    .await
    .unwrap();
    status
}

#[tokio::test]
async fn a_desktop_closes_its_run_with_the_partial_reply_after_losing_its_lease() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let owner = &accounts.owner;
    let turn = processing_desktop_turn(&router, &pool, &accounts, false).await;
    // The lease lapsed, so the progress route refuses this Mac.
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '5 seconds')::text WHERE run_id=$1")
        .bind(&turn.run)
        .execute(&pool)
        .await
        .unwrap();
    let closed = read_json(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/interrupted",
                &owner.token,
                json!({"sessionId":turn.session,"requestMessageId":turn.canonical,"state":"failed","text":"Half an answer","ending":"interrupted"}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        closed,
        json!({"released":true,"closed":true,"published":true})
    );
    assert_eq!(run_status(&pool, &turn.run).await, "failed");
    let after = replies(&pool, owner, &turn.session, &turn.canonical).await;
    assert_eq!(
        after.last(),
        Some(&("failed".to_string(), "Half an answer".to_string())),
        "{after:?}"
    );
    let rows: Vec<(Option<String>,)> = sqlx_core::query_as::query_as(
        "SELECT m.content #>> '{blocks,0,text}' FROM cloud_chat_messages m \
         JOIN cloud_chat_conversations c USING(conversation_id) WHERE c.legacy_session_id=$1",
    )
    .bind(&turn.session)
    .fetch_all(&pool)
    .await
    .unwrap();
    let endings: Vec<Value> = rows
        .into_iter()
        .filter_map(|(body,)| {
            let encoded = body?
                .strip_prefix("kordi-cloud-agent-response:")?
                .to_string();
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()?;
            serde_json::from_slice::<Value>(&bytes).ok()
        })
        .filter_map(|reply| reply.get("ending").cloned())
        .collect();
    assert_eq!(endings, vec![json!("interrupted")]);
    // A second report finds the run ended and the reply published.
    let again = read_json(
        router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/interrupted",
                &owner.token,
                json!({"sessionId":turn.session,"requestMessageId":turn.canonical,"state":"failed","text":"Half an answer","ending":"interrupted"}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        again,
        json!({"released":true,"closed":false,"published":false})
    );
}

#[tokio::test]
async fn the_sweep_closes_a_lapsed_desktop_run_whose_reply_is_terminal_at_once() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let owner = &accounts.owner;
    let turn = processing_desktop_turn(&router, &pool, &accounts, false).await;
    // The terminal reply reached the chat, but the run was never ended.
    let (conversation,): (uuid::Uuid,) = sqlx_core::query_as::query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id=$1",
    )
    .bind(&turn.session)
    .fetch_one(&pool)
    .await
    .unwrap();
    let stopped = encode(
        "kordi-cloud-agent-response",
        json!({"kind":"agent-response","requestId":turn.canonical,"text":"Half an answer","deliveryState":"cancelled","ending":"stopped"}),
    );
    insert_test_message(&pool, &owner.account_id, conversation, &stopped).await;
    // Seconds after the lease lapsed: far inside the lost-executor grace.
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(&turn.run)
        .execute(&pool)
        .await
        .unwrap();
    backfill_terminal_responses(&pool, 1).await.unwrap();
    assert_eq!(run_status(&pool, &turn.run).await, "cancelled");
    // The reply stays as published; the sweep adds none.
    let after = replies(&pool, owner, &turn.session, &turn.canonical).await;
    assert_eq!(
        after.last(),
        Some(&("cancelled".to_string(), "Half an answer".to_string())),
        "{after:?}"
    );
    assert!(!after.contains(&interrupted()), "{after:?}");

    // A run whose lease is still live is left alone.
    let live = processing_desktop_turn(&router, &pool, &accounts, true).await;
    backfill_terminal_responses(&pool, 1).await.unwrap();
    assert_ne!(run_status(&pool, &live.run).await, "cancelled");
}
