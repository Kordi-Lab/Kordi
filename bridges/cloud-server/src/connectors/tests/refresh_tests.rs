//! Serialized refresh, disconnect during refresh, and refresh error mapping.

use super::broker_tests::{call, leased_run, runner};
use super::*;

/// Connects the stub, grants the default agent, and stores an expired
/// credential so the next broker call must refresh. Returns the owner, the
/// connector, and a background lease for the owner's default agent.
async fn expired_connector(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    label: &str,
) -> (String, String, String) {
    let (owner, _) = signed_in_account(pool, label).await;
    let connector_id = connect_stub(pool, runtime, &owner, ConnectorToolGroup::Read).await;
    store::replace_agent_grants(pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    let sealed = broker::seal_secret(
        &TestCipher,
        &ConnectorSecret {
            access_token: "expired-access".into(),
            refresh_token: Some("stub-refresh".into()),
            expires_at: Some(Utc::now() - ChronoDuration::minutes(5)),
        },
    )
    .unwrap();
    store::write_secret(pool, &connector_id, &sealed)
        .await
        .unwrap();
    let (lease, _) = leased_run(pool, runtime, &owner, RunTrigger::Background).await;
    (owner, connector_id, lease)
}

fn spawn_read(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    lease: &str,
    connector_id: &str,
) -> tokio::task::JoinHandle<BrokerCallResponse> {
    let (pool, runtime) = (pool.clone(), runtime.clone());
    let request = call(lease, connector_id, STUB_READ_TOOL);
    tokio::spawn(
        async move { broker::call_connector_tool(&pool, &runtime, &runner(), &request).await },
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_calls_refresh_once() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (_, connector_id, lease) = expired_connector(&pool, &runtime, "refresh_once").await;
    let gate = stub.pause_next_refresh();

    let first = spawn_read(&pool, &runtime, &lease, &connector_id);
    gate.entered.notified().await;
    // The second call loads the same expired secret and then waits on the
    // per-connector lock the first call holds.
    let second = spawn_read(&pool, &runtime, &lease, &connector_id);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    gate.release.notify_one();

    let (first, second) = (first.await.unwrap(), second.await.unwrap());
    assert!(first.ok, "{first:?}");
    assert!(second.ok, "{second:?}");
    assert_eq!(stub.refresh_count(), 1, "{:?}", stub.calls());
    let executed = stub
        .calls()
        .into_iter()
        .filter(|call| call == &format!("execute:{STUB_READ_TOOL}:expired-access-refreshed"))
        .count();
    assert_eq!(executed, 2, "both calls use the one refreshed token");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_during_refresh_leaves_no_secret() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, connector_id, lease) =
        expired_connector(&pool, &runtime, "refresh_disconnect").await;
    let gate = stub.pause_next_refresh();

    let pending = spawn_read(&pool, &runtime, &lease, &connector_id);
    gate.entered.notified().await;
    let record = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    store::disconnect(&pool, &record).await.unwrap();
    gate.release.notify_one();

    let response = pending.await.unwrap();
    assert!(!response.ok);
    assert_eq!(response.error_code(), Some(codes::NOT_FOUND));
    assert_eq!(
        count_rows(
            &pool,
            "SELECT COUNT(*) FROM cloud_connector_secrets WHERE connector_id = $1",
            &connector_id,
        )
        .await,
        0,
        "a refresh that finishes after disconnect must not write the secret back"
    );
    let (summary,): (String,) = query_as(
        "SELECT summary FROM cloud_connector_audit \
         WHERE connector_id = $1 AND outcome = 'failed' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&connector_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(summary, "Failed: The connector was disconnected.");
}

#[test]
fn only_invalid_grant_needs_a_new_sign_in() {
    use providers::ProviderError;
    let now = Utc::now();
    let invalid = providers::token_grant_from_json(&json!({"error":"invalid_grant"}), None, now);
    assert!(matches!(invalid, Err(ProviderError::Unauthorized)));
    for code in [
        "invalid_client",
        "invalid_request",
        "temporarily_unavailable",
    ] {
        let other = providers::token_grant_from_json(&json!({ "error": code }), None, now);
        assert!(
            matches!(other, Err(ProviderError::Rejected(_))),
            "{code} is retryable"
        );
    }
    let slack = providers::token_grant_from_json(&json!({"ok":false}), None, now);
    assert!(matches!(slack, Err(ProviderError::Rejected(_))));
}

#[test]
fn audit_phrases_never_carry_provider_text() {
    use providers::ProviderError;
    let raw = "raw provider detail with stub-access-token";
    let cases = [
        (
            ProviderError::Unauthorized,
            "The connector needs a new sign-in.",
        ),
        (
            ProviderError::Request(raw.into()),
            "The service was unreachable.",
        ),
        (
            ProviderError::NotConfigured(raw.into()),
            "The service was unreachable.",
        ),
        (
            ProviderError::Rejected(raw.into()),
            "The service rejected the request.",
        ),
        (
            ProviderError::InvalidResponse,
            "The service rejected the request.",
        ),
    ];
    for (error, phrase) in cases {
        assert_eq!(error.audit_phrase(), phrase);
    }
}
