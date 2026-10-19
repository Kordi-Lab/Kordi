//! Scheduled tasks run on the owner's Mac first. A cloud task falls back to
//! the cloud runner exactly once; a task that needs the Mac waits for one and
//! fails visibly when none comes.

use super::hosted_only_admission::runner_can_lease;
use super::*;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

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

    /// Puts this owner's Mac online and ready to run scheduled tasks.
    async fn mac_ready(&self) {
        let online = post_with_token("/v1/cloud/presence/online", &self.owner.token);
        let online = self.router.clone().oneshot(online).await.unwrap();
        assert_eq!(online.status(), StatusCode::OK);
        let agent = format!("cloud-agent:{}", self.owner.account_id);
        let (status, _) = self
            .post(
                "/v1/cloud/agent-runs/desktop/ready",
                json!({"agentIds": [agent], "scheduled": true}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE device_id IN (SELECT device_id FROM cloud_devices WHERE account_id=$1)")
            .bind(&self.owner.account_id).execute(&self.pool).await.unwrap();
        query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
            .bind(&self.owner.account_id).execute(&self.pool).await.unwrap();
    }

    /// Creates a task and runs it now; returns the scheduled run id and the
    /// agent run id behind it.
    async fn run_now(&self, target_runtime: &str) -> (String, String) {
        let (status, task) = self
            .post(
                "/v1/cloud/scheduled-tasks",
                json!({
                    "title": "Morning check",
                    "prompt": "Summarize what changed overnight.",
                    "schedule": {"kind": "daily", "time": "09:00", "timezone": "UTC"},
                    "targetRuntime": target_runtime,
                    "toolPayload": {"tool": "agent.run"}
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{task}");
        let task_id = task["task"]["taskId"].as_str().unwrap();
        let (status, run) = self
            .post(
                &format!("/v1/cloud/scheduled-tasks/{task_id}/run-now"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{run}");
        let scheduled = run["run"]["runId"].as_str().unwrap().to_string();
        let (agent_run,): (String,) =
            query_as("SELECT run_id FROM cloud_agent_fallback_runs WHERE request_message_id=$1")
                .bind(&scheduled)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        (scheduled, agent_run)
    }

    async fn pending(&self) -> Vec<String> {
        let response = self
            .router
            .clone()
            .oneshot(get_with_token(
                "/v1/cloud/scheduled-task-runs/desktop/pending",
                &self.owner.token,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        read_json(response)
            .await
            .as_array()
            .unwrap()
            .iter()
            .map(|run| run["requestMessageId"].as_str().unwrap().to_string())
            .collect()
    }

    async fn mac_claim(&self, scheduled: &str, claim_id: uuid::Uuid) -> Value {
        let (status, body) = self
            .post(
                "/v1/cloud/agent-runs/desktop/claim",
                json!({
                    "claimId": claim_id,
                    "requestMessageId": scheduled,
                    "sessionId": format!("session:scheduled:{}", self.owner.account_id),
                    "ownerAccountId": self.owner.account_id,
                    "requesterAccountId": self.owner.account_id,
                    "prompt": "Summarize what changed overnight.",
                    "idempotencyKey": format!("scheduled:{scheduled}"),
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn scheduled_status(&self, scheduled: &str) -> (String, Option<String>) {
        query_as("SELECT status, error_code FROM scheduled_tool_task_runs WHERE run_id=$1")
            .bind(scheduled)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn agent_run(&self, run_id: &str) -> (String, String) {
        query_as("SELECT status, execution_backend FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(run_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn finish(&self) {
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE owner_account_id=$1 AND status IN ('queued','leased','running')")
            .bind(&self.owner.account_id).execute(&self.pool).await.unwrap();
    }
}

fn get_with_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn a_ready_mac_runs_a_cloud_task_and_its_answer_is_delivered() {
    let Some(fx) = fixture("scheduled-mac-runs").await else {
        return;
    };
    fx.mac_ready().await;
    let (scheduled, run_id) = fx.run_now("cloud").await;
    assert!(
        !runner_can_lease(&fx.router, &run_id).await,
        "the Mac goes first"
    );
    assert_eq!(fx.pending().await, vec![scheduled.clone()]);
    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_claim(&scheduled, claim_id).await;
    assert_eq!(claimed["acquired"], true);
    assert_eq!(claimed["runId"], run_id.as_str());
    assert_eq!(
        claimed["turnIdentity"]["ownerAccountId"],
        fx.owner.account_id.as_str()
    );
    assert_eq!(fx.scheduled_status(&scheduled).await.0, "running");
    let second = fx.mac_claim(&scheduled, uuid::Uuid::new_v4()).await;
    assert_eq!(second["acquired"], false, "one Mac instance runs it");

    let complete = format!("/v1/cloud/scheduled-task-runs/desktop/{run_id}/complete");
    let (status, _) = fx
        .post(
            &complete,
            json!({"claimId": uuid::Uuid::new_v4(), "text": "Nothing changed."}),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "only the claim holder answers"
    );
    let (status, body) = fx
        .post(
            &complete,
            json!({"claimId": claim_id, "text": "Nothing changed."}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(fx.scheduled_status(&scheduled).await.0, "completed");
    assert_eq!(
        fx.agent_run(&run_id).await,
        ("completed".into(), "desktop".into())
    );
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn the_cloud_runs_a_cloud_task_once_when_no_mac_claims_it() {
    let Some(fx) = fixture("scheduled-mac-silent").await else {
        return;
    };
    fx.mac_ready().await;
    let (scheduled, run_id) = fx.run_now("cloud").await;
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until=now()-interval '1 second' WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(runner_can_lease(&fx.router, &run_id).await);
    assert!(!runner_can_lease(&fx.router, &run_id).await, "leased once");
    let late = fx.mac_claim(&scheduled, uuid::Uuid::new_v4()).await;
    assert_eq!(late["acquired"], false, "a late Mac never runs it again");
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_that_cannot_finish_a_cloud_task_hands_it_to_the_cloud() {
    let Some(fx) = fixture("scheduled-mac-release").await else {
        return;
    };
    fx.mac_ready().await;
    let (scheduled, run_id) = fx.run_now("cloud").await;
    let claim_id = uuid::Uuid::new_v4();
    assert_eq!(fx.mac_claim(&scheduled, claim_id).await["acquired"], true);
    let (status, _) = fx
        .post(
            &format!("/v1/cloud/scheduled-task-runs/desktop/{run_id}/fail"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn a_task_that_needs_the_mac_waits_for_it_and_runs_when_it_comes_online() {
    let Some(fx) = fixture("scheduled-local-wait").await else {
        return;
    };
    let (scheduled, run_id) = fx.run_now("localRequired").await;
    assert_eq!(
        fx.scheduled_status(&scheduled).await.0,
        "waiting_for_desktop"
    );
    query("UPDATE cloud_agent_fallback_runs SET created_at=(now()-interval '1 hour')::text WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(
        !runner_can_lease(&fx.router, &run_id).await,
        "the cloud never runs it"
    );

    fx.mac_ready().await;
    assert_eq!(fx.pending().await, vec![scheduled.clone()]);
    let first = uuid::Uuid::new_v4();
    assert_eq!(fx.mac_claim(&scheduled, first).await["acquired"], true);
    // A Mac that stops renewing loses the run to another Mac, never the cloud.
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    let claim_id = uuid::Uuid::new_v4();
    assert_eq!(fx.mac_claim(&scheduled, claim_id).await["acquired"], true);
    let (status, body) = fx
        .post(
            &format!("/v1/cloud/scheduled-task-runs/desktop/{run_id}/complete"),
            json!({"claimId": claim_id, "text": "Read the local file."}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(fx.scheduled_status(&scheduled).await.0, "completed");
    fx.finish().await;
}

#[tokio::test]
async fn a_task_that_needs_the_mac_fails_visibly_when_no_mac_comes() {
    let Some(fx) = fixture("scheduled-local-expiry").await else {
        return;
    };
    let (scheduled, run_id) = fx.run_now("localRequired").await;
    let stale = (chrono::Utc::now() - chrono::Duration::hours(13)).to_rfc3339();
    query("UPDATE scheduled_tool_task_runs SET created_at=$2 WHERE run_id=$1")
        .bind(&scheduled)
        .bind(stale)
        .execute(&fx.pool)
        .await
        .unwrap();
    kordi_cloud_server::scheduled_tasks::mac::expire_waiting(&fx.pool)
        .await
        .unwrap();
    assert_eq!(
        fx.scheduled_status(&scheduled).await,
        ("failed".into(), Some("desktop_unavailable".into()))
    );
    assert_eq!(fx.agent_run(&run_id).await.0, "failed");
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_with_a_hosted_account_gets_that_accounts_credentials_for_a_task() {
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let Some(fx) = fixture("scheduled-mac-hosted").await else {
        return;
    };
    fx.mac_ready().await;
    // The cloud would use another saved account; the Mac's route names "work".
    let (status, saved) = fx
        .post(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            json!({"provider":"openai","authChoice":"cloud-api-key:personal",
                "payload":{"apiKey":"synthetic-personal-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let (scheduled, run_id) = fx.run_now("cloud").await;
    let (status, saved) = fx
        .post(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            json!({"provider":"openai","authChoice":"cloud-api-key:work",
                "payload":{"apiKey":"synthetic-hosted-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let claim_id = uuid::Uuid::new_v4();
    let (status, claimed) = fx
        .post(
            "/v1/cloud/agent-runs/desktop/claim",
            json!({
                "claimId": claim_id,
                "requestMessageId": scheduled,
                "sessionId": format!("session:scheduled:{}", fx.owner.account_id),
                "ownerAccountId": fx.owner.account_id,
                "requesterAccountId": fx.owner.account_id,
                "prompt": "Summarize what changed overnight.",
                "idempotencyKey": format!("scheduled:{scheduled}"),
                "runtimeRoute": {"defaultModel":"openai/gpt-4.1-mini","defaultAuthProvider":"openai",
                    "defaultAuthChoice":"cloud-api-key:work"},
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["acquired"], true);
    let (status, material) = fx
        .post(
            &format!("/v1/cloud/agent-runs/{run_id}/desktop/provider-auth"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{material}");
    assert_eq!(material["providerAuth"]["authChoice"], "cloud-api-key:work");
    fx.finish().await;
}
