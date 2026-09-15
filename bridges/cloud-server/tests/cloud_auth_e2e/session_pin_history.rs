use super::session_list_fixtures::seed_stale_group;
use super::*;
use kordi_cloud_server::chat_sync::store;
use sqlx_core::{query::query, query_as::query_as};

pub(super) async fn assert_no_pin_history(pool: &sqlx_postgres::PgPool, conversation: uuid::Uuid) {
    let history_count: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_session_pin_history WHERE conversation_id=$1")
            .bind(conversation)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(
        history_count.0, 0,
        "failed sync and state transactions cannot leave a history event"
    );
}

#[tokio::test]
async fn pin_history_survives_reload_and_respects_audience_and_pagination() {
    if std::env::var("DATABASE_URL").is_err() {
        return;
    }
    let pool = try_pool()
        .await
        .expect("configured test database must initialize");
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (owner_token, owner) = signup_account(&router, "pin-history-owner").await;
    let (peer_token, peer) = signup_account(&router, "pin-history-peer").await;
    let (outsider_token, _) = signup_account(&router, "pin-history-outsider").await;
    let session_id = format!("session:group:{}", uuid::Uuid::now_v7());
    let conversation = seed_stale_group(&pool, &owner, Some(&session_id), None, "active").await;
    query("INSERT INTO cloud_chat_conversation_members(conversation_id, account_id, membership_state) VALUES ($1, $2, 'active')")
        .bind(conversation).bind(&peer).execute(&pool).await.unwrap();
    let pin_path = format!("/v1/cloud/sessions/{session_id}/pin");
    for scope in ["private", "shared"] {
        for target in [
            Some("synthetic-message"),
            Some("synthetic-message"),
            None,
            None,
        ] {
            let response = router
                .clone()
                .oneshot(put_json_with_token(
                    &pin_path,
                    &owner_token,
                    json!({"messageId": target, "scope": scope}),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
    }
    // A fresh service instance must load the same durable events.
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let path = format!("/v1/cloud/sessions/{session_id}/pin-history");
    let owner_page = read_json(
        router
            .clone()
            .oneshot(get_with_token(&path, &owner_token))
            .await
            .unwrap(),
    )
    .await;
    let owner_events = owner_page["events"].as_array().unwrap();
    assert_eq!(
        owner_events.len(),
        4,
        "repeated no-op writes must not create history"
    );
    assert_eq!(
        owner_events
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["unpinned", "pinned", "unpinned", "pinned"]
    );
    assert!(owner_events.iter().all(|e| e["updatedAt"]
        .as_str()
        .is_some_and(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok())));
    let peer_page = read_json(
        router
            .clone()
            .oneshot(get_with_token(&path, &peer_token))
            .await
            .unwrap(),
    )
    .await;
    let peer_events = peer_page["events"].as_array().unwrap();
    assert_eq!(peer_events.len(), 2);
    assert_eq!(
        &owner_events[..2],
        peer_events.as_slice(),
        "both devices receive the same shared event identities"
    );
    assert!(peer_events.iter().all(|event| event["scope"] == "shared"));
    let mut before = None;
    let mut paged_ids = Vec::new();
    loop {
        let paged = format!(
            "{path}?limit=1{}",
            before.map(|b| format!("&before={b}")).unwrap_or_default()
        );
        let page = read_json(
            router
                .clone()
                .oneshot(get_with_token(&paged, &owner_token))
                .await
                .unwrap(),
        )
        .await;
        let rows = page["events"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        paged_ids.push(rows[0]["id"].clone());
        before = page["nextBefore"].as_i64();
        if before.is_none() {
            break;
        }
    }
    assert_eq!(
        paged_ids,
        owner_events
            .iter()
            .map(|e| e["id"].clone())
            .collect::<Vec<_>>()
    );
    let live_ids: Vec<(serde_json::Value,)> = query_as("SELECT payload->'pinHistoryEvent'->'id' FROM cloud_chat_user_sync_events WHERE account_id=$1 AND conversation_id=$2 AND event_type='session.pin.updated' ORDER BY stream_seq DESC")
        .bind(&owner).bind(conversation).fetch_all(&pool).await.unwrap();
    assert_eq!(
        live_ids.into_iter().map(|(id,)| id).collect::<Vec<_>>(),
        paged_ids
    );
    assert_eq!(
        router
            .clone()
            .oneshot(get_with_token(&path, &outsider_token))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation).bind(&peer).execute(&pool).await.unwrap();
    assert_eq!(
        router
            .oneshot(get_with_token(&path, &peer_token))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn pin_history_backfill_deduplicates_shared_fanout_and_preserves_original_time() {
    if std::env::var("DATABASE_URL").is_err() {
        return;
    }
    let pool = try_pool()
        .await
        .expect("configured test database must initialize");
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (_, owner) = signup_account(&router, "pin-backfill-owner").await;
    let (_, peer) = signup_account(&router, "pin-backfill-peer").await;
    let session_id = format!("session:group:{}", uuid::Uuid::now_v7());
    let conversation = seed_stale_group(&pool, &owner, Some(&session_id), None, "active").await;
    let mut transaction = pool.begin().await.unwrap();
    for (target, occurred_at) in [
        (Some("target"), "2026-09-14T12:00:00Z"),
        (None, "2026-09-14T12:01:00Z"),
    ] {
        store::append_user_sync_events_in_transaction(&mut transaction, &[owner.clone(), peer.clone()], "fixture.pin.before-migration", Some(conversation),
            &json!({"sessionId": session_id, "scope": "shared", "messageId": target, "updatedByAccountId": owner, "updatedAt": occurred_at})).await.unwrap();
    }
    transaction.commit().await.unwrap();
    query("UPDATE cloud_chat_user_sync_events SET event_type='session.pin.updated' WHERE conversation_id=$1 AND event_type='fixture.pin.before-migration'")
        .bind(conversation).execute(&pool).await.unwrap();
    let backfill = include_str!("../../migrations/0093_backfill_session_pin_history.sql");
    for _ in 0..2 {
        sqlx_core::raw_sql::raw_sql(backfill)
            .execute(&pool)
            .await
            .unwrap();
    }
    let events: Vec<(serde_json::Value,)> = query_as(
        "SELECT payload FROM cloud_session_pin_history WHERE conversation_id=$1 ORDER BY sequence",
    )
    .bind(conversation)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].0["updatedAt"], "2026-09-14T12:00:00Z");
    assert_eq!(events[1].0["updatedAt"], "2026-09-14T12:01:00Z");
    assert_eq!(events[0].0["kind"], "pinned");
    assert_eq!(events[1].0["kind"], "unpinned");
}

#[tokio::test]
async fn pin_history_rechecks_membership_after_waiting_for_the_conversation_lock() {
    if std::env::var("DATABASE_URL").is_err() {
        return;
    }
    let pool = try_pool().await.expect("configured fixture database");
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (token, account) = signup_account(&router, "pin-lock-member").await;
    let session = format!("session:group:{}", uuid::Uuid::now_v7());
    let conversation = seed_stale_group(&pool, &account, Some(&session), None, "active").await;
    let mut blocker = pool.begin().await.unwrap();
    query(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE conversation_id=$1 FOR UPDATE",
    )
    .bind(conversation)
    .execute(&mut *blocker)
    .await
    .unwrap();
    let (blocker_pid,): (i32,) = query_as("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let request = put_json_with_token(
        &format!("/v1/cloud/sessions/{session}/pin"),
        &token,
        json!({"messageId":"target","scope":"private"}),
    );
    let response = tokio::spawn(async move { router.oneshot(request).await.unwrap() });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (waiting,): (bool,) = query_as(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker_pid)
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("request should reach the locked conversation");
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation).bind(&account).execute(&mut *blocker).await.unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(response.await.unwrap().status(), StatusCode::FORBIDDEN);
    assert_no_pin_history(&pool, conversation).await;
    let (pins,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_account_session_pins WHERE account_id=$1 AND session_id=$2",
    )
    .bind(account)
    .bind(session)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pins, 0);
}
