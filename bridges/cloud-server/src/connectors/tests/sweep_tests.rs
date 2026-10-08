//! The polling sweep: the cursor moves only on success, pages are read to
//! the end, and one connector's failure never stops the others.

use std::sync::atomic::AtomicBool;

use super::http_stub::HttpStub;
use super::polling_tests::connect_github;
use super::service_fixture::{connect_service, service_runtime, stored_events};
use super::*;
use crate::connectors::polling::{self, RunningGuard};
use crate::connectors::ConnectorHooks;

type Time = chrono::DateTime<Utc>;

/// A sweep claims every due connector in the shared database, so tests that
/// sweep take turns.
pub(super) static POLL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Leaves only `mine` due, so connectors other tests create wait.
async fn only_due(pool: &PgPool, mine: &[&str]) {
    let mine: Vec<String> = mine.iter().map(|id| id.to_string()).collect();
    query("UPDATE cloud_connectors SET last_polled_at = now() WHERE NOT (connector_id = ANY($1))")
        .bind(&mine)
        .execute(pool)
        .await
        .unwrap();
    query("UPDATE cloud_connectors SET last_polled_at = NULL WHERE connector_id = ANY($1)")
        .bind(&mine)
        .execute(pool)
        .await
        .unwrap();
}

async fn poll_state(pool: &PgPool, connector_id: &str) -> (Option<Time>, Option<Time>) {
    query_as("SELECT poll_cursor, last_polled_at FROM cloud_connectors WHERE connector_id = $1")
        .bind(connector_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn notification(id: &str, updated_at: &str, title: &str) -> Value {
    json!({ "id": id, "reason": "mention", "unread": true, "updated_at": updated_at,
            "subject": { "title": title, "type": "Issue" },
            "repository": { "full_name": "kordi/app" } })
}

#[tokio::test]
async fn a_failed_poll_keeps_the_cursor() {
    let Some(pool) = pool().await else { return };
    let _turn = POLL_LOCK.lock().await;
    let stub = HttpStub::start().await;
    let (runtime, _, connector_id) = connect_github(&pool, &stub, "cursor").await;
    let start: Time = "2026-10-01T00:00:00Z".parse().unwrap();
    query("UPDATE cloud_connectors SET poll_cursor = $2 WHERE connector_id = $1")
        .bind(&connector_id)
        .bind(start)
        .execute(&pool)
        .await
        .unwrap();
    only_due(&pool, &[&connector_id]).await;
    stub.respond_when(
        "GET",
        "/notifications",
        None,
        Some("gh-cursor"),
        502,
        json!({}),
    );
    let failed = polling::poll_due_connectors(&pool, &runtime, Utc::now())
        .await
        .unwrap();
    assert!(failed.failed >= 1, "{failed:?}");
    let (cursor, attempted) = poll_state(&pool, &connector_id).await;
    assert_eq!(
        cursor,
        Some(start),
        "a failed poll does not move the cursor"
    );
    assert!(attempted.is_some(), "the attempt is still recorded");

    stub.respond_when(
        "GET",
        "/notifications",
        None,
        Some("gh-cursor"),
        200,
        json!([notification("c1", "2026-10-02T08:00:00Z", "Ping")]),
    );
    only_due(&pool, &[&connector_id]).await;
    polling::poll_due_connectors(&pool, &runtime, Utc::now())
        .await
        .unwrap();
    let (cursor, _) = poll_state(&pool, &connector_id).await;
    assert_eq!(cursor, Some("2026-10-02T08:00:00Z".parse().unwrap()));
    let since = stub
        .requests_to("GET", "/notifications")
        .into_iter()
        .filter(|call| call.authorization == "Bearer gh-cursor")
        .map(|call| call.query)
        .collect::<Vec<_>>();
    assert_eq!(since.len(), 2);
    assert!(since
        .iter()
        .all(|query| query.contains("since=2026-10-01T00%3A00%3A00%2B00%3A00")));
}

fn slack_page(range: std::ops::Range<u64>, next: Option<&str>) -> Value {
    let messages: Vec<Value> = range
        .rev()
        .map(|i| {
            json!({ "type": "message", "user": "U2", "text": format!("m{i}"),
                         "ts": format!("{}.000100", 1_759_800_000 + i) })
        })
        .collect();
    json!({ "ok": true, "messages": messages, "has_more": next.is_some(),
            "response_metadata": { "next_cursor": next.unwrap_or_default() } })
}

#[tokio::test]
async fn sixty_slack_messages_become_sixty_events_across_two_polls() {
    let Some(pool) = pool().await else { return };
    let _turn = POLL_LOCK.lock().await;
    let stub = HttpStub::start().await;
    let runtime = service_runtime(&stub, ConnectorHooks::default());
    stub.respond(
        "POST",
        "/token",
        json!({ "ok": true, "team": { "id": "T0PAGED" },
                "authed_user": { "id": "U1", "access_token": "xoxp-paged",
                                 "scope": "channels:history,groups:history" } }),
    );
    let (owner, _) = signed_in_account(&pool, "slack_pages").await;
    let connector_id =
        connect_service(&pool, &runtime, &owner, "slack", ConnectorToolGroup::Read).await;
    store::set_settings(&pool, &connector_id, &json!({ "channels": ["C0PAGED"] }))
        .await
        .unwrap();
    let history = "/conversations.history";
    let token = Some("xoxp-paged");
    stub.respond_when(
        "GET",
        history,
        None,
        token,
        200,
        slack_page(10..60, Some("page2")),
    );
    stub.respond_when(
        "GET",
        history,
        Some("cursor=page2"),
        token,
        200,
        slack_page(0..10, None),
    );

    for _ in 0..2 {
        only_due(&pool, &[&connector_id]).await;
        polling::poll_due_connectors(&pool, &runtime, Utc::now())
            .await
            .unwrap();
    }
    assert_eq!(
        stored_events(&pool, &connector_id, "message:C0PAGED:")
            .await
            .len(),
        60
    );
    let (cursor, _) = poll_state(&pool, &connector_id).await;
    assert_eq!(cursor.map(|at| at.timestamp()), Some(1_759_800_059));
    let calls: Vec<_> = stub
        .requests_to("GET", history)
        .into_iter()
        .filter(|call| call.authorization == "Bearer xoxp-paged")
        .collect();
    assert_eq!(calls.len(), 4, "two pages per poll");
    assert!(
        calls[2].query.contains("oldest=1759800059.000100"),
        "{}",
        calls[2].query
    );
}

#[tokio::test]
async fn one_failing_connector_does_not_stop_the_sweep() {
    let Some(pool) = pool().await else { return };
    let _turn = POLL_LOCK.lock().await;
    let stub = HttpStub::start().await;
    let (runtime, _, broken_db) = connect_github(&pool, &stub, "sweep-db").await;
    let (_, _, broken_provider) = connect_github(&pool, &stub, "sweep-401").await;
    let (_, _, healthy) = connect_github(&pool, &stub, "sweep-ok").await;
    // PostgreSQL refuses NUL in JSON text, so storing this event fails.
    let nul = notification("bad", "2026-10-03T08:00:00Z", "a\u{0}b");
    stub.respond_when(
        "GET",
        "/notifications",
        None,
        Some("gh-sweep-db"),
        200,
        json!([nul]),
    );
    stub.reject_token("gh-sweep-401");
    let good = notification("good", "2026-10-03T09:00:00Z", "Fine");
    stub.respond_when(
        "GET",
        "/notifications",
        None,
        Some("gh-sweep-ok"),
        200,
        json!([good]),
    );
    only_due(&pool, &[&broken_db, &broken_provider, &healthy]).await;

    let report = polling::poll_due_connectors(&pool, &runtime, Utc::now())
        .await
        .unwrap();
    assert!(report.failed >= 2, "{report:?}");
    assert_eq!(
        stored_events(&pool, &healthy, "notification:").await,
        [(
            "notification".to_string(),
            "notification:good:2026-10-03T09:00:00Z".to_string()
        )]
    );
    assert!(stored_events(&pool, &broken_db, "notification:")
        .await
        .is_empty());
    assert_eq!(poll_state(&pool, &broken_db).await.0, None);
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_connectors WHERE connector_id = $1")
            .bind(&broken_provider)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "needs_reauth");
}

#[tokio::test]
async fn the_running_flag_resets_after_a_panic() {
    static FLAG: AtomicBool = AtomicBool::new(false);
    let guard = RunningGuard::acquire(&FLAG).unwrap();
    assert!(RunningGuard::acquire(&FLAG).is_none(), "never overlaps");
    let sweep = tokio::spawn(async move {
        let _guard = guard;
        panic!("sweep failed");
    });
    assert!(sweep.await.unwrap_err().is_panic());
    assert!(RunningGuard::acquire(&FLAG).is_some(), "polling resumes");
}
