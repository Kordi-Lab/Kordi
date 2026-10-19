//! Ownership transitions lock one conversation, not every account (#1896).
use super::*;
use kordi_cloud_server::cloud_agent_runtime::{run_locks, runs};
use sqlx_core::query::query;

struct DesktopRun {
    run_id: String,
    claim_id: uuid::Uuid,
}

struct Owner {
    router: axum::Router,
    account: TestAccount,
    session: String,
}

/// An owner whose ready Mac claimed one desktop run per request in a fresh
/// direct agent session.
async fn owner_with_desktop_runs(
    pool: &sqlx_postgres::PgPool,
    prefix: &str,
    requests: usize,
) -> (Owner, Vec<DesktopRun>) {
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let account = signup(&router, prefix, "Lock Owner").await;
    let agent = format!("cloud-agent:{}", account.account_id);
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&account.account_id)
        .execute(pool)
        .await
        .unwrap();
    let online = post_with_token("/v1/cloud/presence/online", &account.token);
    assert_eq!(
        router.clone().oneshot(online).await.unwrap().status(),
        StatusCode::OK
    );
    let ready = post_json_with_token(
        "/v1/cloud/agent-runs/desktop/ready",
        &account.token,
        json!({"agentIds":[agent]}),
    );
    assert_eq!(
        router.clone().oneshot(ready).await.unwrap().status(),
        StatusCode::OK
    );
    query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(&agent).execute(pool).await.unwrap();
    query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&account.account_id).execute(pool).await.unwrap();
    let session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        pool,
        &account.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let mut runs = Vec::new();
    for index in 0..requests {
        let request = insert_test_message(
            pool,
            &account.account_id,
            conversation,
            &format!("Request {index}"),
        )
        .await;
        let claim_id = uuid::Uuid::new_v4();
        let body = json!({"requestMessageId":request,"sessionId":session,"ownerAccountId":account.account_id,"requesterAccountId":account.account_id,"prompt":"Test execution","idempotencyKey":format!("attempt:{claim_id}"),"claimId":claim_id});
        let claim =
            post_json_with_token("/v1/cloud/agent-runs/desktop/claim", &account.token, body);
        let claim = read_json(router.clone().oneshot(claim).await.unwrap()).await;
        assert_eq!(claim["acquired"], true, "{claim}");
        let run_id = claim["runId"].as_str().unwrap().to_string();
        // Keep the lease valid on a slow test database and order runs strictly.
        query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()+interval '10 minutes')::text, created_at=$2 WHERE run_id=$1")
            .bind(&run_id)
            .bind((chrono::Utc::now() + chrono::Duration::milliseconds(index as i64)).to_rfc3339())
            .execute(pool)
            .await
            .unwrap();
        runs.push(DesktopRun { run_id, claim_id });
    }
    (
        Owner {
            router,
            account,
            session,
        },
        runs,
    )
}

async fn admit(owner: &Owner, run: &DesktopRun) -> Value {
    let request = post_json_with_token(
        &format!("/v1/cloud/agent-runs/desktop/{}/admit", run.run_id),
        &owner.account.token,
        json!({"claimId":run.claim_id}),
    );
    read_json(owner.router.clone().oneshot(request).await.unwrap()).await
}

/// Hand a desktop-claimed run back to the cloud queue.
async fn requeue_for_cloud(pool: &sqlx_postgres::PgPool, run_id: &str) {
    query("UPDATE cloud_agent_fallback_runs SET status='queued', execution_backend='cloud', claimed_by=NULL, lease_expires_at=NULL, desktop_preferred_until=NULL WHERE run_id=$1")
        .bind(run_id).execute(pool).await.unwrap();
}

#[tokio::test]
async fn a_busy_conversation_does_not_block_other_accounts() {
    let Some(pool) = try_pool().await else { return };
    let (busy, busy_runs) = owner_with_desktop_runs(&pool, "lock-busy", 1).await;
    let (other, other_runs) = owner_with_desktop_runs(&pool, "lock-other", 2).await;
    requeue_for_cloud(&pool, &other_runs[1].run_id).await;

    // Hold the busy conversation's lock as a slow transition would.
    let mut holder = pool.begin().await.unwrap();
    run_locks::lock_session(&mut holder, &busy.session)
        .await
        .unwrap();

    let limit = Duration::from_secs(5);
    let admitted = tokio::time::timeout(limit, admit(&other, &other_runs[0])).await;
    assert_eq!(
        admitted.expect("other account admit must not wait")["admitted"],
        true
    );
    // A runner leases another conversation's queued run while this one is busy.
    // (A canary lease targets that run only, so parallel tests keep their runs.)
    query("UPDATE cloud_agent_fallback_runs SET status='completed' WHERE run_id=$1")
        .bind(&other_runs[0].run_id)
        .execute(&pool)
        .await
        .unwrap();
    let lease = runs::lease_canary_run(&pool, "lock-test-runner", &other_runs[1].run_id);
    let leased = tokio::time::timeout(limit, lease).await;
    let leased = leased.expect("runner lease must not wait").unwrap();
    assert_eq!(
        leased.map(|run| run.run_id),
        Some(other_runs[1].run_id.clone())
    );

    // The busy conversation itself waits for its lock.
    let mut blocked = Box::pin(admit(&busy, &busy_runs[0]));
    let early = tokio::time::timeout(Duration::from_millis(300), &mut blocked).await;
    assert!(
        early.is_err(),
        "same-conversation admit must wait for the lock"
    );
    holder.rollback().await.unwrap();
    let admitted = tokio::time::timeout(limit, blocked).await.unwrap();
    assert_eq!(admitted["admitted"], true);
}

#[tokio::test]
async fn concurrent_desktop_admit_and_cloud_lease_keep_one_turn_per_conversation() {
    let Some(pool) = try_pool().await else { return };
    for round in 0..4 {
        let (owner, runs) = owner_with_desktop_runs(&pool, "lock-race", 2).await;
        // Round parity decides which run is the older one in the queue.
        let (desktop, cloud) = if round % 2 == 0 {
            (&runs[0], &runs[1])
        } else {
            (&runs[1], &runs[0])
        };
        requeue_for_cloud(&pool, &cloud.run_id).await;
        let (admitted, leased) = tokio::join!(
            admit(&owner, desktop),
            runs::lease_canary_run(&pool, "lock-race-runner", &cloud.run_id),
        );
        let desktop_runs = admitted["admitted"] == true;
        let cloud_runs = leased.unwrap().is_some();
        assert!(
            !(desktop_runs && cloud_runs),
            "round {round}: desktop and cloud both own a turn in one conversation"
        );
        assert!(
            desktop_runs || cloud_runs,
            "round {round}: the older run must start"
        );
        let active: (i64,) = sqlx_core::query_as::query_as(
            "SELECT count(*) FROM cloud_agent_fallback_runs WHERE session_id=$1 AND (status='running' OR (status='leased' AND execution_backend='cloud'))",
        )
        .bind(&owner.session)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(active.0, 1, "round {round}");
    }
}
