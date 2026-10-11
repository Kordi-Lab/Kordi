//! The server sweep that ends desktop runs whose executor is gone and
//! backfills the terminal replies they never published.

use super::*;
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
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    let after = replies(&pool, &accounts.owner, &turn.session, &turn.canonical).await;
    assert!(after.contains(&interrupted()), "{after:?}");
}
#[tokio::test]
async fn the_sweep_ends_failed_desktop_runs_that_never_replied() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (owner, session) = direct_session(&router, &pool, "terminal-sweep").await;
    let request = ended_desktop_run(&pool, &owner, &session, "0 seconds").await;
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    let after = replies(&pool, &owner, &session, &request).await;
    assert_eq!(after.len(), 1, "{after:?}");
    assert_eq!(after[0].0, "failed");
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    assert_eq!(replies(&pool, &owner, &session, &request).await, after);
}
#[tokio::test]
async fn the_sweep_backfills_only_recently_ended_runs() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let (owner, session) = direct_session(&router, &pool, "terminal-window").await;
    let old = ended_desktop_run(&pool, &owner, &session, "2 days").await;
    let recent = ended_desktop_run(&pool, &owner, &session, "2 minutes").await;
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    assert_eq!(replies(&pool, &owner, &session, &old).await, vec![]);
    let recent = replies(&pool, &owner, &session, &recent).await;
    assert_eq!(recent.len(), 1, "{recent:?}");
    assert_eq!(recent[0].0, "failed");
}
#[tokio::test]
async fn the_sweep_closes_a_desktop_run_lost_long_ago_without_a_reply() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let turn = processing_desktop_turn(&router, &pool, &accounts, true).await;
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '2 days')::text WHERE run_id=$1")
        .bind(&turn.run)
        .execute(&pool)
        .await
        .unwrap();
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    assert_eq!(run_status(&pool, &turn.run).await, "cancelled");
    assert_eq!(
        replies(&pool, &accounts.owner, &turn.session, &turn.canonical).await,
        vec![("processing".to_string(), "Processing".to_string())]
    );
}
#[tokio::test]
async fn the_sweep_finds_the_terminal_reply_among_many_later_replies() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let accounts = ready_accounts(&router, &pool).await;
    let owner = &accounts.owner;
    let turn = processing_desktop_turn(&router, &pool, &accounts, false).await;
    let (conversation,): (uuid::Uuid,) = sqlx_core::query_as::query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id=$1",
    )
    .bind(&turn.session)
    .fetch_one(&pool)
    .await
    .unwrap();
    let reply = |request: &str, text: &str, state: &str| {
        encode(
            "kordi-cloud-agent-response",
            json!({"kind":"agent-response","requestId":request,"text":text,"deliveryState":state}),
        )
    };
    let stopped = reply(&turn.canonical, "Half an answer", "cancelled");
    insert_test_message(&pool, &owner.account_id, conversation, &stopped).await;
    // More replies to other requests than one scan reads.
    for _ in 0..60 {
        let other = reply(&uuid::Uuid::new_v4().to_string(), "Done", "complete");
        insert_test_message(&pool, &owner.account_id, conversation, &other).await;
    }
    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(&turn.run)
        .execute(&pool)
        .await
        .unwrap();
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    assert_eq!(run_status(&pool, &turn.run).await, "cancelled");
    let after = replies(&pool, owner, &turn.session, &turn.canonical).await;
    assert!(!after.contains(&interrupted()), "{after:?}");
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
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
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
    backfill_terminal_responses(&pool, BACKFILL_WINDOW_MINUTES)
        .await
        .unwrap();
    assert_ne!(run_status(&pool, &live.run).await, "cancelled");
}
