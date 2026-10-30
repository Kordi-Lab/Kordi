//! Durable request/reply/continuation with three synthetic authenticated Macs.
use super::*;
use sqlx_core::{query::query, query_as::query_as};

struct Fixture {
    pool: sqlx_postgres::PgPool,
    router: axum::Router,
    people: Vec<TestAccount>,
    session: String,
    root: String,
    claim: uuid::Uuid,
}
impl Fixture {
    async fn new() -> Option<Self> {
        Self::kind(true).await
    }
    async fn kind(group: bool) -> Option<Self> {
        let pool = try_pool().await?;
        let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
        let mut people = vec![];
        for name in ["Exchange Alpha", "Exchange Beta", "Exchange Gamma"] {
            let person = signup(&router, "agent-exchanges", name).await;
            query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
                .bind(&person.account_id)
                .execute(&pool)
                .await
                .unwrap();
            let response = router
                .clone()
                .oneshot(post_with_token("/v1/cloud/presence/online", &person.token))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let response = router
                .clone()
                .oneshot(post_json_with_token(
                    "/v1/cloud/agent-runs/desktop/ready",
                    &person.token,
                    json!({"agentIds":[format!("cloud-agent:{}",person.account_id)]}),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            query("UPDATE cloud_agent_desktop_capabilities SET updated_at=now()+interval '10 minutes' WHERE agent_id=$1").bind(format!("cloud-agent:{}",person.account_id)).execute(&pool).await.unwrap();
            query("UPDATE cloud_device_presence SET last_heartbeat_at=(now()+interval '10 minutes')::text WHERE account_id=$1").bind(&person.account_id).execute(&pool).await.unwrap();
            people.push(person);
        }
        accept_contacts(&router, &people[0], &people[1]).await;
        accept_contacts(&router, &people[0], &people[2]).await;
        let session = if group {
            format!("session:group:{}", uuid::Uuid::new_v4())
        } else {
            let mut ids = [people[0].account_id.clone(), people[1].account_id.clone()];
            ids.sort();
            format!("session:direct-person:{}:{}", ids[0], ids[1])
        };
        let owner = &people[0];
        let conversation = create_test_conversation(
            &pool,
            &owner.account_id,
            &session,
            if group {
                ConversationKind::Group
            } else {
                ConversationKind::Direct
            },
            people[1..if group { 3 } else { 2 }]
                .iter()
                .map(|p| p.account_id.clone())
                .collect(),
        )
        .await;
        let logical = uuid::Uuid::new_v4().to_string();
        let participants: Vec<Value> = people
            .iter()
            .map(|p| json!({"accountId":p.account_id,"displayName":"Synthetic participant"}))
            .collect();
        let envelope = json!({"kind":"group-message","groupId":session,"createdByAccountId":owner.account_id,"actor":{"accountId":owner.account_id,"displayName":"Synthetic owner"},"participants":participants,
            "message":{"id":logical,"senderAccountId":owner.account_id,"senderKind":"human","text":"Ask Beta and continue","createdAtMs":chrono::Utc::now().timestamp_millis(),"targetCloudAgentId":format!("cloud-agent:{}",owner.account_id),"targetCloudAgentOwnerAccountId":owner.account_id,"targetCloudAgentName":"Kordi"}});
        let wire = insert_test_message(
            &pool,
            &owner.account_id,
            conversation,
            &if group {
                format!(
                    "kordi-cloud-group:{}",
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(envelope.to_string())
                )
            } else {
                "Ask Beta and continue".into()
            },
        )
        .await;
        let logical = if group { logical } else { wire };
        let claim = uuid::Uuid::new_v4();
        let body = json!({"requestMessageId":logical,"sessionId":session,"ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,"prompt":"Ask Beta and continue","idempotencyKey":logical,"claimId":claim});
        let response = router
            .clone()
            .oneshot(post_json_with_token(
                "/v1/cloud/agent-runs/desktop/claim",
                &owner.token,
                body,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = read_json(response).await;
        assert_eq!(value["acquired"], true);
        Some(Self {
            pool,
            router,
            people,
            session,
            root: value["runId"].as_str().unwrap().into(),
            claim,
        })
    }
    async fn post(&self, person: usize, path: &str, body: Value) -> Value {
        let response = self
            .router
            .clone()
            .oneshot(post_json_with_token(path, &self.people[person].token, body))
            .await
            .unwrap();
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
    async fn send(&self, key: &str, target: usize) -> Value {
        self.post(0,&format!("/v1/cloud/agent-runs/desktop/{}/agent-exchange",self.root),json!({"claimId":self.claim,"toolCallId":key,"arguments":{"target":format!("cloud-agent:{}",self.people[target].account_id),"message":"Return the synthetic status."}})).await
    }
    async fn pending(&self, person: usize) -> Vec<Value> {
        let response = self
            .router
            .clone()
            .oneshot(get_with_token(
                "/v1/cloud/agent-exchanges/desktop/pending",
                &self.people[person].token,
            ))
            .await
            .unwrap();
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body.as_array().unwrap().clone()
    }
    async fn claim(&self, person: usize, run: &Value) -> uuid::Uuid {
        let claim = uuid::Uuid::new_v4();
        let body = json!({"claimId":claim,"requestMessageId":run["requestMessageId"],"sessionId":self.session,"ownerAccountId":self.people[person].account_id,"requesterAccountId":run["requesterAccountId"],"prompt":run["prompt"],"idempotencyKey":run["runId"]});
        let claimed = self
            .post(person, "/v1/cloud/agent-runs/desktop/claim", body)
            .await;
        assert_eq!(claimed["acquired"], true);
        claim
    }
    async fn finish(&self, person: usize, run: &str, claim: uuid::Uuid, text: &str) {
        self.post(
            person,
            &format!("/v1/cloud/agent-exchanges/desktop/{run}/complete"),
            json!({"claimId":claim,"text":text}),
        )
        .await;
    }
    async fn end_parent(&self) {
        // Simulates the ordinary chat publisher finishing the first turn.
        query("UPDATE cloud_agent_fallback_runs SET status='completed',completed_at=now()::text WHERE run_id=$1").bind(&self.root).execute(&self.pool).await.unwrap();
    }
}

#[tokio::test]
async fn exchange_retries_restart_reply_and_continuation_are_durable_and_mac_first() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    let receipt = f.send("call-a", 1).await;
    assert_eq!(
        f.send("call-a", 1).await["exchangeId"],
        receipt["exchangeId"]
    );
    assert_eq!(
        f.send("replayed-call", 1).await["exchangeId"],
        receipt["exchangeId"],
        "a restarted model does not resend identical outreach"
    );
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap();
    assert!(
        f.pending(2).await.is_empty(),
        "another account cannot pick it up"
    );
    assert!(
        !super::hosted_only_admission::runner_can_lease(&f.router, run).await,
        "ready Mac goes first"
    );
    let old_claim = f.claim(1, &target).await;
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1").bind(run).execute(&f.pool).await.unwrap();
    assert_eq!(
        f.pending(1).await.len(),
        1,
        "expired desktop execution is rediscovered"
    );
    let claim = f.claim(1, &target).await;
    let stale = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-exchanges/desktop/{run}/complete"),
            &f.people[1].token,
            json!({"claimId":old_claim,"text":"stale answer"}),
        ))
        .await
        .unwrap();
    assert_ne!(stale.status(), StatusCode::OK);
    f.finish(1, run, claim, "Beta is ready").await;
    f.finish(1, run, claim, "Beta is ready").await;
    assert!(
        f.pending(0).await.is_empty(),
        "wait for initial turn to end"
    );
    f.end_parent().await;
    let resume = f.pending(0).await.remove(0);
    assert!(resume["prompt"].as_str().unwrap().contains("Beta is ready"));
    assert_eq!(
        f.pending(0).await[0]["runId"],
        resume["runId"],
        "polling does not duplicate continuation"
    );
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "I received Beta's reply and continued the task.",
    )
    .await;
    let (status,count):(String,i64)=query_as("SELECT status,(SELECT count(*) FROM cloud_agent_fallback_runs WHERE session_id=$2) FROM cloud_agent_exchanges WHERE exchange_id=$1").bind(uuid::Uuid::parse_str(receipt["exchangeId"].as_str().unwrap()).unwrap()).bind(&f.session).fetch_one(&f.pool).await.unwrap();
    assert_eq!(status, "completed");
    assert_eq!(count, 3);
}

#[tokio::test]
async fn exchange_membership_revocation_cancels_delivery_and_resume() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("call", 1).await;
    query("UPDATE cloud_chat_conversation_members SET membership_state='left' WHERE account_id=$1")
        .bind(&f.people[1].account_id)
        .execute(&f.pool)
        .await
        .unwrap();
    f.end_parent().await;
    assert!(f.pending(0).await.is_empty());
    assert!(f.pending(1).await.is_empty());
    let (status,): (String,) =
        query_as("SELECT status FROM cloud_agent_exchanges WHERE parent_run_id=$1")
            .bind(&f.root)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(status, "cancelled");
}

#[tokio::test]
async fn exchange_timeout_resumes_with_explicit_failure_without_a_fake_reply() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("call", 2).await;
    f.end_parent().await;
    query("UPDATE cloud_agent_exchanges SET deadline_at=now()-interval '1 second' WHERE parent_run_id=$1").bind(&f.root).execute(&f.pool).await.unwrap();
    let resume = f.pending(0).await.remove(0);
    assert!(resume["prompt"]
        .as_str()
        .unwrap()
        .contains("did not reply before the deadline"));
    assert!(f.pending(2).await.is_empty());
}

#[tokio::test]
async fn exchange_direct_chat_and_shared_requester_boundaries() {
    let Some(f) = Fixture::kind(false).await else {
        return;
    };
    f.send("direct", 1).await;
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap();
    let claim = f.claim(1, &target).await;
    let nested = f
        .router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange"),
            &f.people[1].token,
            json!({"claimId":claim,"action":"capabilities"}),
        ))
        .await
        .unwrap();
    assert_ne!(
        nested.status(),
        StatusCode::OK,
        "another participant's request cannot acquire owner authority"
    );
    f.finish(1, run, claim, "Direct answer").await;
    f.end_parent().await;
    let resume = f.pending(0).await.remove(0);
    let claim = f.claim(0, &resume).await;
    f.finish(
        0,
        resume["runId"].as_str().unwrap(),
        claim,
        "Continued after direct answer",
    )
    .await;
    let (count,):(i64,)=query_as("SELECT count(*) FROM cloud_chat_messages m JOIN cloud_chat_conversations c USING(conversation_id) WHERE c.legacy_session_id=$1 AND m.content #>> '{blocks,0,text}' LIKE 'kordi-cloud-agent-response:%'").bind(&f.session).fetch_one(&f.pool).await.unwrap();
    assert_eq!(
        count, 3,
        "request, reply, continuation are visible canonical messages"
    );
}

#[tokio::test]
async fn exchange_cloud_fallback_and_root_cancellation_use_the_same_run() {
    let Some(f) = Fixture::new().await else {
        return;
    };
    f.send("fallback", 1).await;
    let target = f.pending(1).await.remove(0);
    let run = target["runId"].as_str().unwrap();
    assert!(!super::hosted_only_admission::runner_can_lease(&f.router, run).await);
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until=now()-interval '1 second' WHERE run_id=$1").bind(run).execute(&f.pool).await.unwrap();
    assert!(super::hosted_only_admission::runner_can_lease(&f.router, run).await);
    assert!(f.pending(1).await.is_empty());
    let response = f
        .router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run}/complete"),
            "runner-test-token",
            json!({"runnerId":"runner-mac-first","responseText":"Cloud fallback answer"}),
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        read_json(response).await
    );
    query("UPDATE cloud_agent_fallback_runs SET cancel_requested_at=now(),status='cancelled' WHERE run_id=$1").bind(&f.root).execute(&f.pool).await.unwrap();
    assert!(f.pending(0).await.is_empty());
    let (state,): (String,) =
        query_as("SELECT status FROM cloud_agent_exchanges WHERE parent_run_id=$1")
            .bind(&f.root)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state, "cancelled");
}

#[path = "agent_exchange_quiet.rs"]
mod quiet;
