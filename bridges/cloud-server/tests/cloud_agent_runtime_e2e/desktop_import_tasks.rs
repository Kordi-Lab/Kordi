//! A Mac starts a memory import run for its own account and gets hosted
//! credentials for it; the run lives only on that Mac.

use super::hosted_only_admission::runner_can_lease;
use super::*;
use kordi_cloud_server::cloud_agent_runtime::runs::terminal_backfill::backfill_terminal_responses;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

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

fn hosted_route() -> Value {
    json!({"defaultModel":"openai/gpt-5.6","defaultAuthProvider":"openai",
        "defaultAuthChoice":"cloud-api-key:work","thinking":"xhigh"})
}

impl Fixture {
    async fn post(&self, uri: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(uri, &self.owner.token, body))
            .await
            .unwrap();
        let status = response.status();
        (status, read_json(response).await)
    }

    async fn start(&self, claim_id: uuid::Uuid, route: Value) -> Value {
        let body = json!({"kind": "memory_import", "claimId": claim_id, "runtimeRoute": route});
        let (status, body) = self.post(TASKS, body).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn run_state(&self, run_id: &str) -> (String, Option<String>) {
        query_as("SELECT status, error_code FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(run_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn audit_count(&self, event: &str, run_id: &str) -> i64 {
        let (count,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_audit_events WHERE account_id=$1 AND event_type=$2 \
             AND metadata_json::jsonb->>'runId'=$3",
        )
        .bind(&self.owner.account_id)
        .bind(event)
        .bind(run_id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        count
    }

    async fn age(&self, run_id: &str) {
        query("UPDATE cloud_agent_fallback_runs SET created_at=(now()-interval '11 minutes')::text WHERE run_id=$1")
            .bind(run_id).execute(&self.pool).await.unwrap();
    }

    async fn finish(&self) {
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE owner_account_id=$1 AND status IN ('queued','leased','running')")
            .bind(&self.owner.account_id).execute(&self.pool).await.unwrap();
    }
}

#[tokio::test]
async fn a_mac_starts_an_import_and_gets_its_hosted_credentials() {
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let Some(fx) = fixture("import-start").await else {
        return;
    };
    let (status, saved) = fx
        .post(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            json!({"provider":"openai","authChoice":"cloud-api-key:work",
                "payload":{"apiKey":"synthetic-hosted-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let claim_id = uuid::Uuid::new_v4();
    let started = fx.start(claim_id, hosted_route()).await;
    assert_eq!(started["acquired"], true);
    assert_eq!(started["leaseSeconds"], 45);
    let run_id = started["runId"].as_str().unwrap().to_string();
    assert!(run_id.starts_with("import_"));
    let import = &started["import"];
    assert_eq!(import["model"], "openai/gpt-5.6-luna");
    assert_eq!(import["thinking"], "low");
    assert_eq!(import["provider"], "openai");
    assert_eq!(import["modelChoice"], "fast");
    assert_eq!(import["triage"], false);
    assert_eq!(import["fastModels"]["anthropic"], "claude-haiku-4-5");

    let row: (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Value,
    ) = query_as(
        "SELECT session_id, requester_account_id, status, execution_backend, run_trigger, \
           connector_audience, prompt, claimed_by, runtime_route_json \
         FROM cloud_agent_fallback_runs WHERE run_id=$1",
    )
    .bind(&run_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(row.0, format!("import:{}", fx.owner.account_id));
    assert_eq!(row.1, fx.owner.account_id);
    assert_eq!(
        (&*row.2, &*row.3, &*row.4, &*row.5, &*row.6),
        ("leased", "desktop", "background", "owner_private", "{}")
    );
    assert!(row.7.ends_with(&format!(":{claim_id}")));
    assert_eq!(row.8["defaultAuthChoice"], "cloud-api-key:work");
    assert_eq!(fx.audit_count("memory_import_started", &run_id).await, 1);

    let provider_auth = format!("/v1/cloud/agent-runs/{run_id}/desktop/provider-auth");
    let (status, material) = fx.post(&provider_auth, json!({"claimId": claim_id})).await;
    assert_eq!(status, StatusCode::OK, "{material}");
    assert_eq!(material["providerAuth"]["provider"], "openai");
    assert_eq!(material["providerAuth"]["authChoice"], "cloud-api-key:work");
    assert_eq!(
        material["providerAuth"]["payload"]["apiKey"],
        "synthetic-hosted-key"
    );
    let (status, _) = fx
        .post(&provider_auth, json!({"claimId": uuid::Uuid::new_v4()}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "only the claim holder");
    fx.finish().await;
}

#[tokio::test]
async fn one_import_runs_at_a_time_and_only_known_tasks_start() {
    let Some(fx) = fixture("import-once").await else {
        return;
    };
    let first = fx.start(uuid::Uuid::new_v4(), Value::Null).await;
    assert_eq!(first["acquired"], true);
    let second = fx.start(uuid::Uuid::new_v4(), hosted_route()).await;
    assert_eq!(
        second,
        json!({"acquired": false, "errorCode": "import_in_progress",
            "message": "An import is already running."})
    );
    let (status, body) = fx
        .post(
            TASKS,
            json!({"kind": "photo_import", "claimId": uuid::Uuid::new_v4()}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "unsupported_task");
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_renews_completes_and_releases_its_import() {
    let Some(fx) = fixture("import-lifecycle").await else {
        return;
    };
    let claim_id = uuid::Uuid::new_v4();
    let run_id = fx.start(claim_id, Value::Null).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let renew = format!("/v1/cloud/agent-runs/desktop/{run_id}/renew");
    let (status, body) = fx.post(&renew, json!({"claimId": claim_id})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let complete = format!("/v1/cloud/agent-runs/desktop/{run_id}/complete");
    let (status, _) = fx
        .post(&complete, json!({"claimId": uuid::Uuid::new_v4()}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "only the claim holder");
    let (status, body) = fx.post(&complete, json!({"claimId": claim_id})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"ok": true})));
    assert_eq!(fx.run_state(&run_id).await, ("completed".into(), None));
    assert_eq!(fx.audit_count("memory_import_completed", &run_id).await, 1);
    let (status, _) = fx.post(&renew, json!({"claimId": claim_id})).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "an ended import is not renewed"
    );

    // The next import may start, and a release ends it without the cloud.
    let claim_id = uuid::Uuid::new_v4();
    let run_id = fx.start(claim_id, Value::Null).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    let release = format!("/v1/cloud/agent-runs/desktop/{run_id}/release");
    let (_, body) = fx
        .post(&release, json!({"claimId": uuid::Uuid::new_v4()}))
        .await;
    assert_eq!(body["released"], false, "only the claim holder");
    let (status, body) = fx.post(&release, json!({"claimId": claim_id})).await;
    assert_eq!((status, body), (StatusCode::OK, json!({"released": true})));
    assert_eq!(
        fx.run_state(&run_id).await,
        ("failed".into(), Some("desktop_released".into()))
    );
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    let (status, _) = fx
        .post(
            "/v1/cloud/agent-runs/desktop/chat_run/complete",
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "complete ends imports only");
    fx.finish().await;
}

#[tokio::test]
async fn the_runner_never_leases_an_import() {
    let Some(fx) = fixture("import-runner").await else {
        return;
    };
    let run_id = fx.start(uuid::Uuid::new_v4(), hosted_route()).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    // A lapsed desktop lease is not handed to the cloud either.
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 minute')::text WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    query("UPDATE cloud_agent_fallback_runs SET status='queued', execution_backend='cloud', claimed_by=NULL, lease_expires_at=NULL WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn an_import_open_for_ten_minutes_times_out() {
    let Some(fx) = fixture("import-expiry").await else {
        return;
    };
    let claim_id = uuid::Uuid::new_v4();
    let swept = fx.start(claim_id, Value::Null).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    fx.age(&swept).await;
    backfill_terminal_responses(&fx.pool, 15).await.unwrap();
    assert_eq!(
        fx.run_state(&swept).await,
        ("failed".into(), Some("import_timeout".into()))
    );
    let renew = format!("/v1/cloud/agent-runs/desktop/{swept}/renew");
    let (status, _) = fx.post(&renew, json!({"claimId": claim_id})).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // The next tasks call expires an old import before it checks for one.
    let lazy = fx.start(uuid::Uuid::new_v4(), Value::Null).await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    fx.age(&lazy).await;
    let next = fx.start(uuid::Uuid::new_v4(), Value::Null).await;
    assert_eq!(next["acquired"], true, "{next}");
    assert_eq!(
        fx.run_state(&lazy).await,
        ("failed".into(), Some("import_timeout".into()))
    );
    fx.finish().await;
}
