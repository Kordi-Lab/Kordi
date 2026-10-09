//! Polling, refresh after a 401, and the digest input (database tests).

use super::http_stub::HttpStub;
use super::service_fixture::{connect_service, service_runtime, stored_events, unique_number};
use super::*;
use crate::connectors::{digest_input, polling, refresh, ConnectorHooks};

/// Connects GitHub for a new account; the access token is `gh-<label>`.
pub(super) async fn connect_github(
    pool: &PgPool,
    stub: &HttpStub,
    label: &str,
) -> (ConnectorRuntime, String, String) {
    let runtime = service_runtime(stub, ConnectorHooks::default());
    stub.respond(
        "POST",
        "/token",
        json!({ "access_token": format!("gh-{label}"), "refresh_token": "gh-refresh",
                "expires_in": 3600, "scope": "read:user,notifications" }),
    );
    stub.respond("GET", "/user", json!({ "id": unique_number() }));
    let (owner, _) = signed_in_account(pool, label).await;
    let connector_id =
        connect_service(pool, &runtime, &owner, "github", ConnectorToolGroup::Read).await;
    (runtime, owner, connector_id)
}

/// Notification polls made with this connector's token. Connectors other
/// tests create meanwhile may be polled through the same stub.
fn polls_with(stub: &HttpStub, token: &str) -> usize {
    stub.requests_to("GET", "/notifications")
        .into_iter()
        .filter(|call| call.authorization == format!("Bearer {token}"))
        .count()
}

#[tokio::test]
async fn polling_records_each_event_once() {
    let Some(pool) = pool().await else { return };
    let _turn = super::sweep_tests::POLL_LOCK.lock().await;
    let stub = HttpStub::start().await;
    let (runtime, owner, connector_id) = connect_github(&pool, &stub, "poll").await;
    // Only this connector is due; other tests' connectors wait.
    query("UPDATE cloud_connectors SET last_polled_at = now() WHERE connector_id <> $1")
        .bind(&connector_id)
        .execute(&pool)
        .await
        .unwrap();
    stub.respond(
        "GET",
        "/notifications",
        json!([
            { "id": "n1", "reason": "mention", "unread": true, "updated_at": "2026-10-07T10:00:00Z",
              "subject": { "title": "Ping", "type": "Issue" }, "repository": { "full_name": "kordi/app" } },
            { "id": "n2", "reason": "review_requested", "unread": true, "updated_at": "2026-10-07T11:00:00Z",
              "subject": { "title": "Review", "type": "PullRequest" }, "repository": { "full_name": "kordi/app" } }
        ]),
    );
    let first = polling::poll_due_connectors(&pool, &runtime, Utc::now())
        .await
        .unwrap();
    assert!(first.recorded >= 2, "{first:?}");
    // Due again: the same notifications are not stored twice.
    query("UPDATE cloud_connectors SET last_polled_at = now() - interval '1 hour' WHERE connector_id = $1")
        .bind(&connector_id)
        .execute(&pool)
        .await
        .unwrap();
    polling::poll_due_connectors(&pool, &runtime, Utc::now())
        .await
        .unwrap();
    assert_eq!(
        stored_events(&pool, &connector_id, "notification:").await,
        [
            (
                "notification".to_string(),
                "notification:n1:2026-10-07T10:00:00Z".to_string()
            ),
            (
                "notification".to_string(),
                "notification:n2:2026-10-07T11:00:00Z".to_string()
            ),
        ]
    );
    assert_eq!(polls_with(&stub, "gh-poll"), 2);
    assert!(stub
        .requests_to("GET", "/notifications")
        .iter()
        .all(|call| call.query.contains("since=")));
    // Not due yet: nothing is polled.
    polling::poll_due_connectors(&pool, &runtime, Utc::now())
        .await
        .unwrap();
    assert_eq!(polls_with(&stub, "gh-poll"), 2);

    // A configured webhook does not stop polling: it only reaches the
    // accounts its payload names.
    let hooks = ConnectorHooks {
        github_webhook_secret: Some("hook".into()),
        ..Default::default()
    };
    let live = service_runtime(&stub, hooks);
    query("UPDATE cloud_connectors SET last_polled_at = NULL, subscribed_at = now() WHERE connector_id = $1")
        .bind(&connector_id)
        .execute(&pool)
        .await
        .unwrap();
    polling::poll_due_connectors(&pool, &live, Utc::now())
        .await
        .unwrap();
    assert_eq!(polls_with(&stub, "gh-poll"), 3);
    // The cursor is the newest stored notification, and the next poll asks
    // for changes since then.
    let (cursor,): (Option<chrono::DateTime<Utc>>,) =
        query_as("SELECT poll_cursor FROM cloud_connectors WHERE connector_id = $1")
            .bind(&connector_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(cursor.unwrap().to_rfc3339(), "2026-10-07T11:00:00+00:00");
    let last_poll = stub
        .requests_to("GET", "/notifications")
        .into_iter()
        .rfind(|call| call.authorization == "Bearer gh-poll")
        .unwrap();
    assert!(
        last_poll
            .query
            .contains("since=2026-10-07T11%3A00%3A00%2B00%3A00"),
        "{}",
        last_poll.query
    );

    let summaries = store::connector_summaries(&pool, &owner).await.unwrap();
    assert!(summaries[0].last_event_at.is_some());
}

#[tokio::test]
async fn a_401_refreshes_once_and_retries() {
    let Some(pool) = pool().await else { return };
    let stub = HttpStub::start().await;
    let (runtime, owner, connector_id) = connect_github(&pool, &stub, "refresh401").await;
    let record = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    let provider = runtime.providers.get("github").unwrap();
    let secret = broker::load_secret(&pool, &TestCipher, &connector_id)
        .await
        .unwrap();
    assert_eq!(secret.access_token, "gh-refresh401");
    stub.reject_token("gh-refresh401");
    stub.respond(
        "POST",
        "/token",
        json!({ "access_token": "gh-access-2", "expires_in": 3600 }),
    );
    stub.respond("GET", "/notifications", json!([]));
    let result = refresh::execute_with_retry(
        &pool,
        &TestCipher,
        provider.as_ref(),
        &record,
        "github_notifications",
        &json!({}),
        secret,
    )
    .await
    .unwrap();
    assert_eq!(result, json!({ "notifications": [] }));
    let refresh_calls = stub
        .requests_to("POST", "/token")
        .into_iter()
        .filter(|call| call.body.contains("grant_type=refresh_token"))
        .count();
    assert_eq!(refresh_calls, 1);
    let stored = broker::load_secret(&pool, &TestCipher, &connector_id)
        .await
        .unwrap();
    assert_eq!(stored.access_token, "gh-access-2");
    assert_eq!(stored.refresh_token.as_deref(), Some("gh-refresh"));

    // When the refreshed token is rejected too, the 401 stands.
    stub.reject_token("gh-access-2");
    let again = refresh::execute_with_retry(
        &pool,
        &TestCipher,
        provider.as_ref(),
        &record,
        "github_notifications",
        &json!({}),
        stored,
    )
    .await;
    assert!(matches!(again, Err(providers::ProviderError::Unauthorized)));
}

#[tokio::test]
async fn digest_input_skips_revoked_connectors_and_caps_events() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "digest_input").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    for index in 0..105 {
        events::record_event(
            &pool,
            NewConnectorEvent {
                connector_id: &connector_id,
                provider: STUB.id,
                kind: "item.created",
                external_id: Some(&format!("item-{index}")),
                occurred_at: Utc::now() - ChronoDuration::minutes(index),
                payload: &json!({ "title": format!("Item {index}") }),
            },
        )
        .await
        .unwrap();
    }
    let since = Utc::now() - ChronoDuration::days(7);
    let recent = digest_input::recent_events(&pool, &owner, since)
        .await
        .unwrap();
    assert_eq!(recent.len(), 100);
    assert_eq!(recent[0].summary, json!({ "title": "Item 0" }));
    assert_no_secret_keys("digest input", serde_json::to_value(&recent).unwrap());

    // The digest is built for the default agent: a connector granted only to
    // another agent contributes nothing.
    store::replace_agent_grants(&pool, &connector_id, &["agent_other".to_string()])
        .await
        .unwrap();
    assert!(digest_input::recent_events(&pool, &owner, since)
        .await
        .unwrap()
        .is_empty());
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    assert_eq!(
        digest_input::recent_events(&pool, &owner, since)
            .await
            .unwrap()
            .len(),
        100
    );

    query(
        "UPDATE cloud_connectors SET status = 'revoked', revoked_at = now() \
         WHERE connector_id = $1",
    )
    .bind(&connector_id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(digest_input::recent_events(&pool, &owner, since)
        .await
        .unwrap()
        .is_empty());
}
