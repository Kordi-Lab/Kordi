//! Proactive runs go to the owner's ready Mac first. An evaluation and an
//! approved run are held for it and announced, the Mac claims them by run id
//! through the generic desktop claim, and the cloud runner takes over
//! exactly once when no Mac does (docs/development/proactive-agent.md).
//! Neither run gets the owner's memories in its prompt; both search them
//! with `search_memory`, which the server answers for the run's holder.

use super::hosted_only_admission::runner_can_lease;
use super::*;
use kordi_cloud_server::proactive::ProactiveConfig;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

const REQUEST: &str = "The deploy keeps failing, can anyone help?";

struct Fixture {
    pool: sqlx_postgres::PgPool,
    router: axum::Router,
    owner: TestAccount,
    member: TestAccount,
    group: uuid::Uuid,
    session_id: String,
    agent_id: String,
}

/// Mina's default agent watches a group she shares with Riya, and her Mac is
/// online and ready for her agent. `proactive` says whether the Mac also
/// reports that it runs proactive runs.
async fn fixture(prefix: &str, proactive: bool) -> Option<Fixture> {
    let pool = try_pool().await?;
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, prefix, "Mina").await;
    let member = signup(&router, &format!("{prefix}-member"), "Riya").await;
    accept_contacts(&router, &member, &owner).await;
    query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let online = post_with_token("/v1/cloud/presence/online", &owner.token);
    assert_eq!(
        router.clone().oneshot(online).await.unwrap().status(),
        StatusCode::OK
    );
    let agent_id = format!("cloud-agent:{}", owner.account_id);
    let ready = post_json_with_token(
        "/v1/cloud/agent-runs/desktop/ready",
        &owner.token,
        json!({"agentIds": [agent_id], "proactive": proactive}),
    );
    assert_eq!(
        router.clone().oneshot(ready).await.unwrap().status(),
        StatusCode::OK
    );
    // Keep the Mac ready regardless of test scheduling delays.
    query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE device_id IN (SELECT device_id FROM cloud_devices WHERE account_id=$1)")
        .bind(&owner.account_id).execute(&pool).await.unwrap();
    query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1")
        .bind(&owner.account_id).execute(&pool).await.unwrap();
    let session_id = format!("session:group:{}", uuid::Uuid::new_v4());
    let group = create_test_conversation(
        &pool,
        &owner.account_id,
        &session_id,
        ConversationKind::Group,
        vec![member.account_id.clone()],
    )
    .await;
    let fx = Fixture {
        pool,
        router,
        owner,
        member,
        group,
        session_id,
        agent_id,
    };
    let (status, body) = fx
        .put(
            &format!("/v1/cloud/agents/{}/proactive", fx.agent_id),
            json!({"enabled": true}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    Some(fx)
}

impl Fixture {
    async fn send(&self, request: Request<Body>) -> (StatusCode, Value) {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (status, read_json(response).await)
    }

    async fn post(&self, uri: &str, body: Value) -> (StatusCode, Value) {
        self.send(post_json_with_token(uri, &self.owner.token, body))
            .await
    }

    async fn put(&self, uri: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("PUT")
            .uri(uri)
            .header("authorization", format!("Bearer {}", self.owner.token))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.send(request).await
    }

    /// Riya asks for help a few minutes ago and the sweep queues one
    /// evaluation for it; returns its run id.
    async fn evaluation(&self) -> String {
        let config = ProactiveConfig::default();
        // The first pass starts watching the group at its newest message.
        kordi_cloud_server::proactive::sweep(&self.pool, &config)
            .await
            .unwrap();
        let message =
            insert_test_message(&self.pool, &self.member.account_id, self.group, REQUEST).await;
        query("UPDATE cloud_chat_messages SET created_at = now() - interval '5 minutes' WHERE message_id::text = $1")
            .bind(&message).execute(&self.pool).await.unwrap();
        for _ in 0..20 {
            // Other tests' rows may wait too; this one goes first.
            query("UPDATE cloud_agent_proactive_state SET checked_at = now() - interval '10 years' WHERE agent_id = $1 AND conversation_id = $2")
                .bind(&self.agent_id).bind(self.group).execute(&self.pool).await.unwrap();
            kordi_cloud_server::proactive::sweep(&self.pool, &config)
                .await
                .unwrap();
            let (active,): (Option<String>,) = query_as(
                "SELECT active_run_id FROM cloud_agent_proactive_state \
                 WHERE agent_id = $1 AND conversation_id = $2",
            )
            .bind(&self.agent_id)
            .bind(self.group)
            .fetch_one(&self.pool)
            .await
            .unwrap();
            if let Some(run_id) = active {
                return run_id;
            }
        }
        panic!("the sweep queued no evaluation");
    }

    fn claim_body(&self, run_id: &str, claim_id: uuid::Uuid) -> Value {
        json!({
            "claimId": claim_id,
            "requestMessageId": run_id,
            "sessionId": self.session_id,
            "ownerAccountId": self.owner.account_id,
            "requesterAccountId": self.owner.account_id,
            "prompt": "proactive",
            "idempotencyKey": run_id,
        })
    }

    async fn mac_claim(&self, run_id: &str, claim_id: uuid::Uuid) -> (StatusCode, Value) {
        self.post(
            "/v1/cloud/agent-runs/desktop/claim",
            self.claim_body(run_id, claim_id),
        )
        .await
    }

    /// The Mac's claim, which this test expects to hold the run.
    async fn mac_takes(&self, run_id: &str, claim_id: uuid::Uuid) -> Value {
        let (status, body) = self.mac_claim(run_id, claim_id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["acquired"], true, "{body}");
        body
    }

    async fn mac_complete(&self, run_id: &str, claim_id: uuid::Uuid, text: &str) -> StatusCode {
        self.post(
            &format!("/v1/cloud/proactive/desktop/{run_id}/complete"),
            json!({"claimId": claim_id, "text": text}),
        )
        .await
        .0
    }

    async fn release(&self, run_id: &str, claim_id: uuid::Uuid) -> Value {
        let (status, body) = self
            .post(
                &format!("/v1/cloud/agent-runs/desktop/{run_id}/release"),
                json!({"claimId": claim_id}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn run_state(&self, run_id: &str) -> (String, String, bool) {
        query_as(
            "SELECT status, execution_backend, COALESCE(desktop_preferred_until > now(), FALSE) \
             FROM cloud_agent_fallback_runs WHERE run_id = $1",
        )
        .bind(run_id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    /// The owner's hints of `event_type`.
    async fn hints(&self, event_type: &str) -> Vec<Value> {
        let batch = chat_store::sync_batch(&self.pool, &self.owner.account_id, 0, Some(1000))
            .await
            .unwrap();
        batch
            .events
            .into_iter()
            .filter(|event| event.event_type == event_type)
            .map(|event| {
                assert!(!event.critical, "older clients can skip the hint");
                event.payload
            })
            .collect()
    }

    /// Runs the evaluation on the Mac with an offer; returns the proposal id
    /// and the message it answers.
    async fn offer(&self) -> (String, String) {
        let run_id = self.evaluation().await;
        let claim_id = uuid::Uuid::new_v4();
        let claimed = self.mac_takes(&run_id, claim_id).await;
        let trigger = trigger_of(&claimed["proactive"]["prompt"]);
        let reply = offer_reply(&trigger);
        assert_eq!(
            self.mac_complete(&run_id, claim_id, &reply).await,
            StatusCode::OK
        );
        let (proposal_id, status): (String, String) = query_as(
            "SELECT proposal_id, status FROM cloud_agent_proactive_proposals \
             WHERE evaluation_run_id = $1",
        )
        .bind(&run_id)
        .fetch_one(&self.pool)
        .await
        .expect("the offer becomes a proposal");
        assert_eq!(status, "pending");
        (proposal_id, trigger)
    }

    /// The owner allows the proposal; returns the approved run id.
    async fn allow(&self, proposal_id: &str) -> String {
        let (status, body) = self
            .post(
                &format!(
                    "/v1/cloud/agents/{}/proactive/proposals/{proposal_id}/decision",
                    self.agent_id
                ),
                json!({"decision": "allow"}),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["proposal"]["runId"].as_str().unwrap().to_string()
    }

    async fn proposal_status(&self, proposal_id: &str) -> String {
        let (status,): (String,) =
            query_as("SELECT status FROM cloud_agent_proactive_proposals WHERE proposal_id = $1")
                .bind(proposal_id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        status
    }

    async fn seed_memory(&self, scope: &str, scope_id: &str, text: &str) {
        let (status, body) = self
            .post(
                "/v1/cloud/memory",
                json!({"scope": scope, "scopeId": scope_id, "source": "manual", "text": text}),
            )
            .await;
        assert!(status.is_success(), "{status} {body}");
    }

    /// The owner turns account memory off.
    async fn memory_off(&self) {
        let (status, body) = self
            .put("/v1/cloud/memory/settings", json!({"memoryEnabled": false}))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["memoryEnabled"], false);
    }

    /// A Mac evaluation's tool call, through the digest observe route its
    /// single-turn command posts to.
    async fn observe(
        &self,
        run_id: &str,
        claim_id: uuid::Uuid,
        tool: &str,
        arguments: Value,
    ) -> (StatusCode, Value) {
        self.post(
            &format!("/v1/cloud/digest/desktop/{run_id}/observe"),
            json!({"claimId": claim_id, "tool": tool, "arguments": arguments}),
        )
        .await
    }

    /// A Mac turn's `search_memory` call through the connector broker, as
    /// the holder of `claim_id`.
    async fn mac_search(
        &self,
        run_id: &str,
        claim_id: uuid::Uuid,
        query: &str,
    ) -> (StatusCode, Value) {
        self.post(
            "/internal/connectors/call",
            json!({"leaseId": run_id, "claimId": claim_id, "connectorId": "kordi-memory",
                "tool": "search_memory", "args": {"query": query}}),
        )
        .await
    }

    /// Ends this owner's runs so no later lease of another test picks them up.
    async fn finish(&self) {
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE owner_account_id=$1 AND status IN ('queued','leased','running')")
            .bind(&self.owner.account_id).execute(&self.pool).await.unwrap();
        query("UPDATE cloud_account_proactive_settings SET enabled = FALSE WHERE account_id = $1")
            .bind(&self.owner.account_id)
            .execute(&self.pool)
            .await
            .unwrap();
    }
}

/// The newest collaborator message in an evaluation snapshot.
fn trigger_of(prompt: &Value) -> String {
    let snapshot: Value = serde_json::from_str(prompt.as_str().unwrap()).unwrap();
    snapshot["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["isNew"] == true && message["fromOwner"] == false)
        .expect("a new collaborator message")["messageId"]
        .as_str()
        .unwrap()
        .to_string()
}

fn offer_reply(trigger: &str) -> String {
    json!({
        "decision": "offer",
        "problem": "The deploy fails on every push",
        "offer": "Riya, I can read the deploy log and point at the failing step.",
        "plan": "Read the latest deploy log\nFind the failing step",
        "evidence": [trigger],
    })
    .to_string()
}

/// The memory texts of a `search_memory` answer.
fn found(answer: &Value) -> Vec<String> {
    answer["memories"]
        .as_array()
        .unwrap_or_else(|| panic!("no memories in {answer}"))
        .iter()
        .map(|memory| memory["text"].as_str().unwrap().to_string())
        .collect()
}

/// The names of the connector tools on a claim or a lease.
fn tool_names(tools: &Value) -> Vec<String> {
    tools
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_string())
        .collect()
}

/// The cloud runner's lease of `run_id`, as the runner reads it.
async fn runner_lease(router: &axum::Router, runner_id: &str, run_id: &str) -> Value {
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": runner_id, "canaryRunId": run_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    read_json(lease).await["run"].clone()
}

/// The cloud runner's `search_memory` call through the connector broker.
async fn runner_search(
    router: &axum::Router,
    runner_id: &str,
    run_id: &str,
    query: &str,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/internal/connectors/call",
            "runner-test-token",
            json!({"leaseId": run_id, "runnerId": runner_id, "connectorId": "kordi-memory",
                "tool": "search_memory", "args": {"query": query}}),
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

#[path = "proactive_mac_first/approved.rs"]
mod approved;
#[path = "proactive_mac_first/evaluation.rs"]
mod evaluation;
