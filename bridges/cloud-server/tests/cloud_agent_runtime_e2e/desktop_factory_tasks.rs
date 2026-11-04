//! Factory tests use only the requesting owner's account and live Mac lease.
use super::hosted_only_admission::runner_can_lease;
use super::*;
use kordi_cloud_server::cloud_agent_runtime::runs::terminal_backfill::backfill_terminal_responses;
use sqlx_core::{query::query, query_as::query_as};

const TASKS: &str = "/v1/cloud/agent-runs/desktop/tasks";

struct Fixture {
    pool: sqlx_postgres::PgPool,
    router: axum::Router,
    owner: TestAccount,
}

async fn fixture(prefix: &str) -> Option<Fixture> {
    let pool = try_pool().await?;
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, prefix, "Owner").await;
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    Some(Fixture {
        pool,
        router,
        owner,
    })
}

fn route() -> Value {
    json!({"defaultModel":"openai/gpt-6-luna", "defaultAuthProvider":"openai",
        "defaultAuthChoice":"cloud-api-key:factory", "thinking":"low"})
}

impl Fixture {
    async fn post_as(&self, token: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(path, token, body))
            .await
            .unwrap();
        (response.status(), read_json(response).await)
    }
    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.post_as(&self.owner.token, path, body).await
    }
    async fn start(&self, claim: uuid::Uuid) -> String {
        let (status, value) = self
            .post(
                TASKS,
                json!({"kind":"factory_test", "claimId":claim, "runtimeRoute":route()}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(value["acquired"], true, "{value}");
        assert_eq!(value["leaseSeconds"], 45);
        let run = value["runId"].as_str().unwrap().to_string();
        assert!(run.starts_with("factory_"));
        run
    }
    async fn state(&self, run: &str) -> (String, Option<String>) {
        query_as("SELECT status,error_code FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(run)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn factory_task_preserves_selected_route_and_owner_lease_credentials() {
    let Some(fx) = fixture("factory-auth").await else {
        return;
    };
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let peer = signup(&fx.router, "factory-peer", "Peer").await;
    for choice in ["factory", "other"] {
        let (status, _) = fx.post("/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            json!({"provider":"openai", "authChoice":format!("cloud-api-key:{choice}"),
                "payload":{"apiKey":format!("synthetic-{choice}-key"),"baseUrl":"https://api.openai.com/v1"}})).await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let claim = uuid::Uuid::new_v4();
    let run = fx.start(claim).await;
    let (stored, requester, session): (Value, String, String) = query_as(
        "SELECT runtime_route_json,requester_account_id,session_id FROM cloud_agent_fallback_runs WHERE run_id=$1")
        .bind(&run).fetch_one(&fx.pool).await.unwrap();
    assert_eq!(
        stored,
        route(),
        "the draft's model and thinking must not become digest defaults"
    );
    assert_eq!(requester, fx.owner.account_id);
    assert_eq!(session, format!("factory:{}", fx.owner.account_id));
    let auth = format!("/v1/cloud/agent-runs/{run}/desktop/provider-auth");
    let (status, value) = fx.post(&auth, json!({"claimId":claim})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["providerAuth"]["authChoice"], "cloud-api-key:factory");
    assert_eq!(
        value["providerAuth"]["payload"]["apiKey"],
        "synthetic-factory-key"
    );
    assert_eq!(
        fx.post(&auth, json!({"claimId":uuid::Uuid::new_v4()}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fx.post_as(&peer.token, &auth, json!({"claimId":claim}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let complete = format!("/v1/cloud/agent-runs/desktop/{run}/complete");
    assert_eq!(
        fx.post_as(&peer.token, &complete, json!({"claimId":claim}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fx.post(&complete, json!({"claimId":claim})).await.0,
        StatusCode::OK
    );
    assert_eq!(fx.state(&run).await, ("completed".into(), None));
    assert_eq!(
        fx.post(&auth, json!({"claimId":claim})).await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn factory_tasks_require_mac_and_route_and_allow_one_live_test() {
    let Some(fx) = fixture("factory-admission").await else {
        return;
    };
    let claim = uuid::Uuid::new_v4();
    let (status, missing) = fx
        .post(TASKS, json!({"kind":"factory_test","claimId":claim}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(missing["errorCode"], "missing_runtime_route");
    let run = fx.start(claim).await;
    let (_, busy) = fx
        .post(
            TASKS,
            json!({"kind":"factory_test","claimId":uuid::Uuid::new_v4(),"runtimeRoute":route()}),
        )
        .await;
    assert_eq!(busy["acquired"], false);
    assert_eq!(busy["errorCode"], "factory_test_in_progress");
    let phone = signup(&fx.router, "factory-phone", "Phone").await;
    query("UPDATE cloud_devices SET device_platform='ios' WHERE account_id=$1")
        .bind(&phone.account_id)
        .execute(&fx.pool)
        .await
        .unwrap();
    assert_eq!(
        fx.post_as(
            &phone.token,
            TASKS,
            json!({"kind":"factory_test","claimId":claim,"runtimeRoute":route()})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let renew = format!("/v1/cloud/agent-runs/desktop/{run}/renew");
    assert_eq!(
        fx.post(&renew, json!({"claimId":claim})).await.0,
        StatusCode::OK
    );
    let release = format!("/v1/cloud/agent-runs/desktop/{run}/release");
    assert_eq!(
        fx.post(&release, json!({"claimId":uuid::Uuid::new_v4()}))
            .await
            .1["released"],
        false
    );
    assert_eq!(
        fx.post(&release, json!({"claimId":claim})).await.1["released"],
        true
    );
    assert_eq!(
        fx.state(&run).await,
        ("failed".into(), Some("desktop_released".into()))
    );
    assert!(!runner_can_lease(&fx.router, &run).await);
    assert_eq!(
        fx.post(&renew, json!({"claimId":claim})).await.0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn factory_tests_never_handoff_and_expire_without_chat_responses() {
    let Some(fx) = fixture("factory-expiry").await else {
        return;
    };
    let (before,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE sender_account_id=$1")
            .bind(&fx.owner.account_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    let run = fx.start(uuid::Uuid::new_v4()).await;
    query("UPDATE cloud_agent_fallback_runs SET status='queued',claimed_by=NULL,execution_backend='cloud' WHERE run_id=$1")
        .bind(&run).execute(&fx.pool).await.unwrap();
    assert!(!runner_can_lease(&fx.router, &run).await);
    query("UPDATE cloud_agent_fallback_runs SET status='failed' WHERE run_id=$1")
        .bind(&run)
        .execute(&fx.pool)
        .await
        .unwrap();
    for age in [true, false] {
        let run = fx.start(uuid::Uuid::new_v4()).await;
        if age {
            query("UPDATE cloud_agent_fallback_runs SET created_at=(now()-interval '11 minutes')::text WHERE run_id=$1")
                .bind(&run).execute(&fx.pool).await.unwrap();
        } else {
            query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
                .bind(&run).execute(&fx.pool).await.unwrap();
        }
        assert!(!runner_can_lease(&fx.router, &run).await);
        backfill_terminal_responses(&fx.pool, 15).await.unwrap();
        assert_eq!(
            fx.state(&run).await,
            ("failed".into(), Some("factory_timeout".into()))
        );
    }
    // Renewal itself enforces maximum age even before a runner sweep.
    let claim = uuid::Uuid::new_v4();
    let aged = fx.start(claim).await;
    query("UPDATE cloud_agent_fallback_runs SET created_at=(now()-interval '11 minutes')::text WHERE run_id=$1")
        .bind(&aged).execute(&fx.pool).await.unwrap();
    let renew = format!("/v1/cloud/agent-runs/desktop/{aged}/renew");
    assert_eq!(
        fx.post(&renew, json!({"claimId":claim})).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fx.state(&aged).await,
        ("failed".into(), Some("factory_timeout".into()))
    );
    let (messages,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE sender_account_id=$1")
            .bind(&fx.owner.account_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(
        messages, before,
        "a Factory test must not emit terminal chat replies"
    );
}
