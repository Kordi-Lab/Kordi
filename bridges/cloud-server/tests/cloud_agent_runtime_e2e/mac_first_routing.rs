//! A request for a ready owner Mac is held for that Mac, and the cloud runner
//! answers it exactly once when no Mac claims it in time.

use super::hosted_only_admission::runner_can_lease;
use super::*;
use sqlx_core::query::query;

struct Fixture {
    pool: sqlx_postgres::PgPool,
    router: axum::Router,
    owner: TestAccount,
    session: String,
    request: String,
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
    for (uri, body) in [
        ("/v1/cloud/presence/online", None),
        (
            "/v1/cloud/agent-runs/desktop/ready",
            Some(json!({ "agentIds": [format!("cloud-agent:{}", owner.account_id)] })),
        ),
    ] {
        let response = match body {
            Some(body) => post_json_with_token(uri, &owner.token, body),
            None => post_with_token(uri, &owner.token),
        };
        let response = router.clone().oneshot(response).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    // Keep the Mac ready regardless of test scheduling delays.
    query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1")
        .bind(format!("cloud-agent:{}", owner.account_id)).execute(&pool).await.unwrap();
    query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&owner.account_id).execute(&pool).await.unwrap();
    let session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let request = insert_test_message(&pool, &owner.account_id, conversation, "Request").await;
    Some(Fixture {
        pool,
        router,
        owner,
        session,
        request,
    })
}

impl Fixture {
    fn body(&self, claim_id: Option<uuid::Uuid>) -> Value {
        let mut body = json!({
            "requestMessageId": self.request,
            "sessionId": self.session,
            "ownerAccountId": self.owner.account_id,
            "requesterAccountId": self.owner.account_id,
            "prompt": "Answer once",
            "idempotencyKey": format!("mac-first:{}", self.request),
        });
        if let Some(claim_id) = claim_id {
            body["claimId"] = json!(claim_id);
        }
        body
    }

    async fn post(&self, uri: &str, body: Value) -> Value {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(uri, &self.owner.token, body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        read_json(response).await
    }

    /// The requester's cloud fallback claim.
    async fn request_claim(&self) -> Value {
        self.post("/v1/cloud/agent-runs/claim", self.body(None))
            .await
    }

    /// The owner Mac's execution claim.
    async fn mac_claim(&self) -> Value {
        let body = self.body(Some(uuid::Uuid::new_v4()));
        self.post("/v1/cloud/agent-runs/desktop/claim", body).await
    }

    async fn end_window(&self, run_id: &str) {
        query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until=now()-interval '1 second' WHERE run_id=$1")
            .bind(run_id).execute(&self.pool).await.unwrap();
    }

    /// The runs of this session, which the test then ends so that no later
    /// lease of another test picks them up.
    async fn runs(&self) -> Vec<(String, String)> {
        let runs = sqlx_core::query_as::query_as(
            "SELECT status, execution_backend FROM cloud_agent_fallback_runs WHERE session_id=$1",
        )
        .bind(&self.session)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE session_id=$1")
            .bind(&self.session)
            .execute(&self.pool)
            .await
            .unwrap();
        runs
    }
}

#[tokio::test]
async fn a_ready_mac_that_never_claims_hands_the_request_to_the_cloud_once() {
    let Some(fx) = fixture("mac-first-silent").await else {
        return;
    };
    let held = fx.request_claim().await;
    assert_eq!(held["status"], "queued");
    assert_eq!(held["executionBackend"], "cloud");
    let run_id = held["runId"].as_str().unwrap();
    assert!(
        !runner_can_lease(&fx.router, run_id).await,
        "the Mac goes first"
    );

    fx.end_window(run_id).await;
    assert!(runner_can_lease(&fx.router, run_id).await);
    assert!(!runner_can_lease(&fx.router, run_id).await, "leased once");
    let late = fx.mac_claim().await;
    assert_eq!(late["runId"], run_id);
    assert_eq!(late["acquired"], false, "a late Mac never runs it again");
    assert_eq!(fx.request_claim().await["runId"], run_id);
    assert_eq!(fx.runs().await, vec![("leased".into(), "cloud".into())]);
}

#[tokio::test]
async fn a_ready_mac_takes_the_request_held_for_it() {
    let Some(fx) = fixture("mac-first-claim").await else {
        return;
    };
    let held = fx.request_claim().await;
    let run_id = held["runId"].as_str().unwrap();
    let claimed = fx.mac_claim().await;
    assert_eq!(claimed["runId"], run_id);
    assert_eq!(claimed["acquired"], true);
    let second = fx.mac_claim().await;
    assert_eq!(second["acquired"], false, "one Mac instance runs it");
    fx.end_window(run_id).await;
    assert!(!runner_can_lease(&fx.router, run_id).await);
    assert_eq!(fx.runs().await, vec![("leased".into(), "desktop".into())]);
}

#[tokio::test]
async fn a_mac_that_stops_being_ready_releases_the_request_at_once() {
    let Some(fx) = fixture("mac-first-quit").await else {
        return;
    };
    let run_id = fx.request_claim().await["runId"]
        .as_str()
        .unwrap()
        .to_string();
    query("UPDATE cloud_device_presence SET state='offline' WHERE account_id=$1")
        .bind(&fx.owner.account_id)
        .execute(&fx.pool)
        .await
        .unwrap();
    assert_eq!(fx.request_claim().await["runId"], run_id.as_str());
    assert!(runner_can_lease(&fx.router, &run_id).await);
    assert_eq!(fx.runs().await, vec![("leased".into(), "cloud".into())]);
}

#[tokio::test]
async fn a_hung_mac_loses_the_request_to_the_cloud_when_its_lease_ends() {
    let Some(fx) = fixture("mac-first-hung").await else {
        return;
    };
    let claimed = fx.mac_claim().await;
    assert_eq!(claimed["acquired"], true);
    let run_id = claimed["runId"].as_str().unwrap();
    assert!(!runner_can_lease(&fx.router, run_id).await);
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(run_id).execute(&fx.pool).await.unwrap();
    assert!(runner_can_lease(&fx.router, run_id).await);
    assert_eq!(fx.runs().await, vec![("leased".into(), "cloud".into())]);
}
