//! Which saved provider account a digest run uses (issue 1795). The digest
//! run must name an account the runner can resolve, including when the owner
//! holds several saved accounts.

use super::audience_tests::conversation;
use super::*;
use crate::cloud_agent_runtime::provider_auth::{
    publish_snapshot, snapshot_available_for_route, NormalizedProviderAuthSnapshotInput,
};

/// An owner whose digest has one unread message to summarize.
async fn digest_owner(pool: &PgPool) -> String {
    let (owner, _) = signed_in_account(pool, "digest_route_owner").await;
    let (author, _) = signed_in_account(pool, "digest_route_author").await;
    crate::digest::store::initialize_preferences(pool, &owner, "en-US", "UTC")
        .await
        .unwrap();
    let group = conversation(pool, "group", &author, &[&owner]).await;
    query(
        "INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,\
         sender_account_id,client_message_id,request_fingerprint,content) \
         SELECT $1, conversation_id, 1, $2, $3, 'test', $4 FROM cloud_chat_conversations \
         WHERE legacy_session_id = $5",
    )
    .bind(Uuid::new_v4())
    .bind(&author)
    .bind(Uuid::new_v4())
    .bind(json!({"blocks":[{"type":"text","text":"Please review the draft by Friday."}]}))
    .bind(&group)
    .execute(pool)
    .await
    .unwrap();
    owner
}

async fn saved_account(
    pool: &PgPool,
    owner: &str,
    provider: &str,
    created_at: &str,
    expires_at_ms: Option<i64>,
) {
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshots(snapshot_id,account_id,device_id,\
         provider,auth_choice,encrypted_payload,encryption_key_id,created_at,expires_at_ms) \
         SELECT $1, $2, device_id, $3, 'api-key', '\\x00', 'test', $4, $5 \
         FROM cloud_devices WHERE account_id = $2 LIMIT 1",
    )
    .bind(format!("snap_{}", Uuid::new_v4().simple()))
    .bind(owner)
    .bind(provider)
    .bind(created_at)
    .bind(expires_at_ms)
    .execute(pool)
    .await
    .unwrap();
}

async fn digest_runs(pool: &PgPool, owner: &str) -> Vec<serde_json::Value> {
    query_as::<_, (serde_json::Value,)>(
        "SELECT runtime_route_json FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 AND run_id LIKE 'digest\\_%'",
    )
    .bind(owner)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(route,)| route)
    .collect()
}

async fn digest_error(pool: &PgPool, owner: &str) -> Option<String> {
    query_as::<_, (Option<String>,)>(
        "SELECT error_code FROM cloud_account_digests WHERE account_id = $1",
    )
    .bind(owner)
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

#[tokio::test]
async fn digest_with_several_saved_accounts_names_the_newest_ready_one() {
    let Some(pool) = pool().await else { return };
    let owner = digest_owner(&pool).await;
    saved_account(&pool, &owner, "anthropic", "2026-10-01T00:00:00Z", None).await;
    saved_account(&pool, &owner, "openai", "2026-10-02T00:00:00Z", None).await;
    // The newest account needs reconnecting, so it is skipped.
    saved_account(&pool, &owner, "google", "2026-10-03T00:00:00Z", Some(0)).await;

    crate::digest::store::refresh(&pool, &owner).await.unwrap();

    let routes = digest_runs(&pool, &owner).await;
    assert_eq!(routes.len(), 1, "{routes:?}");
    assert_eq!(routes[0]["defaultAuthProvider"], "openai");
    assert_eq!(routes[0]["defaultAuthChoice"], "api-key");
    assert!(
        snapshot_available_for_route(&pool, &owner, &routes[0])
            .await
            .unwrap(),
        "the runner must resolve the account the digest named"
    );
}

#[tokio::test]
async fn digest_reuses_the_owners_latest_cloud_route() {
    let Some(pool) = pool().await else { return };
    let owner = digest_owner(&pool).await;
    saved_account(&pool, &owner, "anthropic", "2026-10-01T00:00:00Z", None).await;
    saved_account(&pool, &owner, "openai", "2026-10-02T00:00:00Z", None).await;
    let earlier = format!("earlier_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id,idempotency_key,request_message_id,\
         session_id,owner_account_id,requester_account_id,status,prompt,runtime_route_json,\
         created_at,updated_at) VALUES($1,$1,$1,'chat',$2,$2,'completed','hi',$3,$4,$4)",
    )
    .bind(&earlier)
    .bind(&owner)
    .bind(json!({
        "defaultModel": "claude-sonnet-5-5",
        "defaultAuthProvider": "anthropic",
        "defaultAuthChoice": "api-key",
    }))
    .bind(Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();

    crate::digest::store::refresh(&pool, &owner).await.unwrap();

    let routes = digest_runs(&pool, &owner).await;
    assert_eq!(routes.len(), 1, "{routes:?}");
    assert_eq!(routes[0]["defaultAuthProvider"], "anthropic");
    assert_eq!(routes[0]["defaultModel"], "claude-sonnet-5-5");
}

#[tokio::test]
async fn digest_without_a_usable_account_reports_why() {
    let Some(pool) = pool().await else { return };
    let missing = digest_owner(&pool).await;
    crate::digest::store::refresh(&pool, &missing)
        .await
        .unwrap();
    assert!(digest_runs(&pool, &missing).await.is_empty());
    assert_eq!(
        digest_error(&pool, &missing).await.as_deref(),
        Some("missing_provider_auth")
    );

    let expired = digest_owner(&pool).await;
    saved_account(&pool, &expired, "openai", "2026-10-01T00:00:00Z", Some(0)).await;
    crate::digest::store::refresh(&pool, &expired)
        .await
        .unwrap();
    assert!(digest_runs(&pool, &expired).await.is_empty());
    assert_eq!(
        digest_error(&pool, &expired).await.as_deref(),
        Some("provider_auth_rejected")
    );
}

#[tokio::test]
async fn connecting_an_account_releases_a_waiting_digest() {
    let Some(pool) = pool().await else { return };
    let owner = digest_owner(&pool).await;
    query(
        "UPDATE cloud_account_digests SET error_code = 'missing_provider_auth', \
         failure_count = 4, retry_after = now() + interval '12 hours', dirty_since = NULL \
         WHERE account_id = $1",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let (device_id,): (String,) =
        query_as("SELECT device_id FROM cloud_devices WHERE account_id = $1 LIMIT 1")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();

    publish_snapshot(
        &pool,
        &TestCipher,
        &owner,
        &device_id,
        NormalizedProviderAuthSnapshotInput {
            provider: "openai".into(),
            auth_choice: "api-key".into(),
            label: None,
            payload: json!({"apiKey": "sk-test"}),
        },
    )
    .await
    .unwrap();

    let (failures, due, dirty): (i32, bool, bool) = query_as(
        "SELECT failure_count, retry_after <= now(), dirty_since IS NOT NULL \
         FROM cloud_account_digests WHERE account_id = $1",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((failures, due, dirty), (0, true, true));

    crate::digest::store::refresh(&pool, &owner).await.unwrap();
    assert_eq!(digest_runs(&pool, &owner).await.len(), 1);
}

/// The newest digest run and the snapshot it used, recorded the way the
/// provider-auth handout records it.
async fn lease_newest_digest_run(pool: &PgPool, owner: &str, provider: &str) -> String {
    let (run_id,): (String,) = query_as(
        "SELECT run_id FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 AND run_id LIKE 'digest\\_%' AND status = 'queued' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(owner)
    .fetch_one(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshot_audit \
         (audit_id, snapshot_id, account_id, run_id, action, created_at) \
         SELECT $1, snapshot_id, account_id, $2, 'used', $3 \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $4 AND provider = $5 AND revoked_at IS NULL",
    )
    .bind(format!("audit_{}", Uuid::new_v4().simple()))
    .bind(&run_id)
    .bind(Utc::now().to_rfc3339())
    .bind(owner)
    .bind(provider)
    .execute(pool)
    .await
    .unwrap();
    run_id
}

async fn account_status(pool: &PgPool, owner: &str, provider: &str) -> &'static str {
    let (refreshable, expires_at_ms): (bool, Option<i64>) = query_as(
        "SELECT refreshable, expires_at_ms FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND provider = $2 AND revoked_at IS NULL",
    )
    .bind(owner)
    .bind(provider)
    .fetch_one(pool)
    .await
    .unwrap();
    crate::cloud_agent_runtime::provider_auth::snapshot_status(refreshable, expires_at_ms)
}

#[tokio::test]
async fn a_refused_account_is_skipped_and_the_digest_names_it() {
    let Some(pool) = pool().await else { return };
    let owner = digest_owner(&pool).await;
    saved_account(&pool, &owner, "openai", "2026-10-01T00:00:00Z", None).await;
    saved_account(&pool, &owner, "anthropic", "2026-10-02T00:00:00Z", None).await;
    crate::digest::store::refresh(&pool, &owner).await.unwrap();
    assert_eq!(
        digest_runs(&pool, &owner).await[0]["defaultAuthProvider"],
        "anthropic"
    );

    // The provider refuses the first account: it is marked, and the digest
    // moves on to the next account at once without counting a failure.
    let first = lease_newest_digest_run(&pool, &owner, "anthropic").await;
    crate::digest::fail(&pool, &first, None, "provider_auth_rejected")
        .await
        .unwrap();
    assert_eq!(
        account_status(&pool, &owner, "anthropic").await,
        "needs-reconnect"
    );
    let (events,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'provider-auth.updated'",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(events, 1, "the owner's clients reload their accounts");
    let routes = digest_runs(&pool, &owner).await;
    assert_eq!(routes.len(), 2, "{routes:?}");
    assert!(routes
        .iter()
        .any(|route| route["defaultAuthProvider"] == "openai"));
    let (failures,): (i32,) =
        query_as("SELECT failure_count FROM cloud_account_digests WHERE account_id = $1")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(failures, 0);

    // The last account is refused too: no run is queued and the digest
    // names the newest account to reconnect.
    let second = lease_newest_digest_run(&pool, &owner, "openai").await;
    crate::digest::fail(&pool, &second, None, "provider_auth_rejected")
        .await
        .unwrap();
    assert_eq!(digest_runs(&pool, &owner).await.len(), 2);
    assert_eq!(
        digest_error(&pool, &owner).await.as_deref(),
        Some("provider_auth_rejected")
    );
    assert_eq!(
        crate::cloud_agent_runtime::provider_auth::newest_account_needing_reconnect(&pool, &owner)
            .await
            .unwrap()
            .as_deref(),
        Some("anthropic")
    );

    // A failure that is not a refused sign-in marks nothing and backs off.
    let other = digest_owner(&pool).await;
    saved_account(&pool, &other, "openai", "2026-10-01T00:00:00Z", None).await;
    crate::digest::store::refresh(&pool, &other).await.unwrap();
    let run = lease_newest_digest_run(&pool, &other, "openai").await;
    crate::digest::fail(&pool, &run, None, "provider_unavailable")
        .await
        .unwrap();
    assert_eq!(account_status(&pool, &other, "openai").await, "ready");
    assert_eq!(digest_runs(&pool, &other).await.len(), 1);
}

#[tokio::test]
async fn a_failed_account_hands_the_digest_to_another_available_one() {
    let Some(pool) = pool().await else { return };
    let owner = digest_owner(&pool).await;
    saved_account(&pool, &owner, "openai", "2026-10-01T00:00:00Z", None).await;
    saved_account(&pool, &owner, "anthropic", "2026-10-02T00:00:00Z", None).await;
    crate::digest::store::refresh(&pool, &owner).await.unwrap();
    assert_eq!(
        digest_runs(&pool, &owner).await[0]["defaultAuthProvider"],
        "anthropic"
    );

    // The provider is unavailable: the digest moves to the other account at
    // once, counts no failure, and keeps the first account ready.
    let first = lease_newest_digest_run(&pool, &owner, "anthropic").await;
    crate::digest::fail(&pool, &first, None, "provider_unavailable")
        .await
        .unwrap();
    assert_eq!(account_status(&pool, &owner, "anthropic").await, "ready");
    let routes = digest_runs(&pool, &owner).await;
    assert_eq!(routes.len(), 2, "{routes:?}");
    assert!(routes
        .iter()
        .any(|route| route["defaultAuthProvider"] == "openai"));
    let failures = |pool: PgPool, owner: String| async move {
        query_as::<_, (i32,)>(
            "SELECT failure_count FROM cloud_account_digests WHERE account_id = $1",
        )
        .bind(owner)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0
    };
    assert_eq!(failures(pool.clone(), owner.clone()).await, 0);

    // The second account fails too: no account is left that has not failed,
    // so the digest backs off instead of bouncing between them.
    let second = lease_newest_digest_run(&pool, &owner, "openai").await;
    crate::digest::fail(&pool, &second, None, "digest_generation_failed")
        .await
        .unwrap();
    assert_eq!(digest_runs(&pool, &owner).await.len(), 2);
    assert_eq!(failures(pool.clone(), owner.clone()).await, 1);

    // After the backoff both accounts failed recently, and one is still used.
    query("UPDATE cloud_account_digests SET retry_after = now() WHERE account_id = $1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    crate::digest::store::refresh(&pool, &owner).await.unwrap();
    assert_eq!(digest_runs(&pool, &owner).await.len(), 3);

    // With a single account, a failure keeps it and backs off.
    let single = digest_owner(&pool).await;
    saved_account(&pool, &single, "openai", "2026-10-01T00:00:00Z", None).await;
    crate::digest::store::refresh(&pool, &single).await.unwrap();
    let run = lease_newest_digest_run(&pool, &single, "openai").await;
    crate::digest::fail(&pool, &run, None, "provider_unavailable")
        .await
        .unwrap();
    assert_eq!(digest_runs(&pool, &single).await.len(), 1);
    assert_eq!(failures(pool.clone(), single.clone()).await, 1);
}
