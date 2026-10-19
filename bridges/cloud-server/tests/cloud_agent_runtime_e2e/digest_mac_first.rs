//! A digest run waits for a ready owner Mac that can run digests, and the
//! cloud runner runs it exactly once when no Mac claims it in time.

use super::hosted_only_admission::runner_can_lease;
use super::*;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

struct Fixture {
    pool: sqlx_postgres::PgPool,
    router: axum::Router,
    owner: TestAccount,
}

/// An owner whose Mac is online, with one group message to digest and a
/// provider account the cloud could use. `digest` says whether the Mac
/// reports that it runs digests.
async fn fixture(prefix: &str, digest: bool) -> Option<Fixture> {
    let pool = try_pool().await?;
    let router = test_router(Arc::new(signup_email_fixture::state(pool.clone())));
    let owner = signup(&router, prefix, "Owner").await;
    let author = signup(&router, &format!("{prefix}-author"), "Author").await;
    accept_contacts(&router, &author, &owner).await;
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
    let ready = post_json_with_token(
        "/v1/cloud/agent-runs/desktop/ready",
        &owner.token,
        json!({"agentIds": [format!("cloud-agent:{}", owner.account_id)], "digest": digest}),
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
    let group = create_test_conversation(
        &pool,
        &author.account_id,
        &format!("session:group:{}", uuid::Uuid::new_v4()),
        ConversationKind::Group,
        vec![owner.account_id.clone()],
    )
    .await;
    insert_test_message(
        &pool,
        &author.account_id,
        group,
        "Please review the draft by Friday.",
    )
    .await;
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshots(snapshot_id,account_id,device_id,\
         provider,auth_choice,encrypted_payload,encryption_key_id,created_at) \
         SELECT $1, $2, device_id, 'openai', 'api-key', '\\x00', 'test', $3 \
         FROM cloud_devices WHERE account_id = $2 LIMIT 1",
    )
    .bind(format!("snap_{}", uuid::Uuid::new_v4().simple()))
    .bind(&owner.account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    query("INSERT INTO cloud_account_digests(account_id,locale,timezone) VALUES($1,'en-US','UTC')")
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

    /// Starts a digest run and returns its id.
    async fn refresh(&self) -> String {
        let (status, _) = self.post("/v1/cloud/digest/refresh", json!({})).await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let (run_id,): (String,) =
            query_as("SELECT active_run_id FROM cloud_account_digests WHERE account_id=$1")
                .bind(&self.owner.account_id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        run_id
    }

    async fn mac_claim(&self, run_id: &str, claim_id: uuid::Uuid) -> Value {
        self.mac_claim_with_route(run_id, claim_id, Value::Null)
            .await
    }

    /// The Mac's claim, naming its route when that is a hosted account.
    async fn mac_claim_with_route(
        &self,
        run_id: &str,
        claim_id: uuid::Uuid,
        route: Value,
    ) -> Value {
        let (status, body) = self
            .post(
                "/v1/cloud/agent-runs/desktop/claim",
                json!({
                    "claimId": claim_id,
                    "requestMessageId": run_id,
                    "sessionId": format!("digest:{}", self.owner.account_id),
                    "ownerAccountId": self.owner.account_id,
                    "requesterAccountId": self.owner.account_id,
                    "prompt": "digest",
                    "idempotencyKey": run_id,
                    "runtimeRoute": route,
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn run_state(&self, run_id: &str) -> (String, String) {
        query_as("SELECT status, execution_backend FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(run_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// Ends the runs of this owner so that no later lease of another test
    /// picks them up.
    async fn finish(&self) {
        query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE owner_account_id=$1 AND status IN ('queued','leased','running')")
            .bind(&self.owner.account_id).execute(&self.pool).await.unwrap();
    }
}

#[tokio::test]
async fn a_ready_mac_runs_the_digest_and_its_reply_gets_the_cloud_checks() {
    let Some(fx) = fixture("digest-mac-runs", true).await else {
        return;
    };
    let run_id = fx.refresh().await;
    assert!(
        !runner_can_lease(&fx.router, &run_id).await,
        "the Mac goes first"
    );
    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_claim(&run_id, claim_id).await;
    assert_eq!(claimed["acquired"], true);
    assert!(claimed["digest"]["prompt"]
        .as_str()
        .unwrap()
        .contains("Snapshot: {"));
    assert!(claimed["digest"]["systemPrompt"]
        .as_str()
        .unwrap()
        .contains("rolling workspace digest"));
    assert_eq!(
        claimed["digest"]["tools"][0]["name"],
        "digest_search_sessions"
    );
    assert!(claimed["digest"]["systemPrompt"]
        .as_str()
        .unwrap()
        .contains("digest_read_session"));
    let second = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(second["acquired"], false, "one Mac instance runs it");

    let (status, sessions) = fx
        .post(
            &format!("/v1/cloud/digest/desktop/{run_id}/observe"),
            json!({"claimId": claim_id, "tool": "digest_search_sessions", "arguments": {"query": ""}}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!sessions["sessions"].as_array().unwrap().is_empty());
    let (status, _) = fx
        .post(
            &format!("/v1/cloud/digest/desktop/{run_id}/observe"),
            json!({"claimId": uuid::Uuid::new_v4(), "tool": "search_sessions"}),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "only the claim holder reads the input"
    );

    // A reply wrapped in prose with an extra key is cleaned up on the server.
    let reply = "Here is the digest:\n{\"claims\":[],\"commitments\":[],\"suggestions\":[],\"calendarCandidates\":[],\"note\":1}";
    let (status, body) = fx
        .post(
            &format!("/v1/cloud/digest/desktop/{run_id}/complete"),
            json!({"claimId": claim_id, "text": reply}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        fx.run_state(&run_id).await,
        ("completed".into(), "desktop".into())
    );
    let (active, published): (Option<String>, bool) = query_as(
        "SELECT active_run_id, snapshot_json IS NOT NULL FROM cloud_account_digests WHERE account_id=$1",
    )
    .bind(&fx.owner.account_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!((active, published), (None, true));
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn the_cloud_runs_the_digest_once_when_no_mac_claims_it() {
    let Some(fx) = fixture("digest-mac-silent", true).await else {
        return;
    };
    let run_id = fx.refresh().await;
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until=now()-interval '1 second' WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(runner_can_lease(&fx.router, &run_id).await);
    assert!(!runner_can_lease(&fx.router, &run_id).await, "leased once");
    let late = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(late["acquired"], false, "a late Mac never runs it again");
    assert_eq!(
        fx.run_state(&run_id).await,
        ("leased".into(), "cloud".into())
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_that_cannot_run_digests_does_not_delay_the_cloud() {
    let Some(fx) = fixture("digest-mac-older", false).await else {
        return;
    };
    let run_id = fx.refresh().await;
    assert!(runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_that_cannot_finish_hands_the_digest_to_the_cloud_at_once() {
    let Some(fx) = fixture("digest-mac-release", true).await else {
        return;
    };
    let run_id = fx.refresh().await;
    let claim_id = uuid::Uuid::new_v4();
    assert_eq!(fx.mac_claim(&run_id, claim_id).await["acquired"], true);
    let release = format!("/v1/cloud/digest/desktop/{run_id}/release");
    let (status, _) = fx
        .post(&release, json!({"claimId": uuid::Uuid::new_v4()}))
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "only the claim holder releases"
    );
    let (status, _) = fx.post(&release, json!({"claimId": claim_id})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(runner_can_lease(&fx.router, &run_id).await);
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_with_a_hosted_account_gets_that_accounts_credentials_for_the_digest() {
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let Some(fx) = fixture("digest-mac-hosted", true).await else {
        return;
    };
    let run_id = fx.refresh().await;
    // The owner's default route on the Mac is a hosted account.
    let (status, saved) = fx
        .post(
            "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
            json!({"provider":"openai","authChoice":"cloud-api-key:work",
                "payload":{"apiKey":"synthetic-hosted-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{saved}");
    let claim_id = uuid::Uuid::new_v4();
    let route = json!({"defaultModel":"openai/gpt-4.1-mini","defaultAuthProvider":"openai",
        "defaultAuthChoice":"cloud-api-key:work"});
    let claimed = fx.mac_claim_with_route(&run_id, claim_id, route).await;
    assert_eq!(claimed["acquired"], true);
    let (status, material) = fx
        .post(
            &format!("/v1/cloud/agent-runs/{run_id}/desktop/provider-auth"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{material}");
    assert_eq!(material["providerAuth"]["authChoice"], "cloud-api-key:work");
    assert_eq!(
        material["providerAuth"]["payload"]["apiKey"],
        "synthetic-hosted-key"
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_claim_with_a_hosted_account_keeps_the_digest_model_choice() {
    let Some(fx) = fixture("digest-mac-model", true).await else {
        return;
    };
    let run_id = fx.refresh().await;
    // The Mac's chat runs a large model at high effort.
    let route = json!({"defaultModel":"openai/gpt-5.6","defaultAuthProvider":"openai",
        "defaultAuthChoice":"cloud-api-key:work","thinking":"xhigh"});
    let claimed = fx
        .mac_claim_with_route(&run_id, uuid::Uuid::new_v4(), route)
        .await;
    assert_eq!(claimed["acquired"], true);
    let digest = &claimed["digest"];
    assert_eq!(digest["model"], "openai/gpt-5.6-luna");
    assert_eq!(digest["thinking"], "low");
    assert_eq!(digest["provider"], "openai");
    assert_eq!(digest["modelChoice"], "fast");
    assert_eq!(digest["triage"], false);
    assert_eq!(digest["fastModels"]["anthropic"], "claude-haiku-4-5");
    let (stored,): (Value,) =
        query_as("SELECT runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id=$1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(stored["defaultAuthChoice"], "cloud-api-key:work");
    assert_eq!(stored["defaultModel"], "openai/gpt-5.6-luna");
    assert_eq!(
        stored["thinking"], "low",
        "the Mac's chat effort is not saved"
    );
    let (model, thinking): (Option<String>, Option<String>) =
        query_as("SELECT model, thinking FROM cloud_digest_runs WHERE run_id=$1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(
        (model.as_deref(), thinking.as_deref()),
        (Some("openai/gpt-5.6-luna"), Some("low"))
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_runs_the_quick_check_without_tools_or_thinking() {
    let Some(fx) = fixture("digest-mac-triage", true).await else {
        return;
    };
    let run_id = fx.refresh().await;
    query("UPDATE cloud_digest_runs SET run_trigger='triage' WHERE run_id=$1")
        .bind(&run_id)
        .execute(&fx.pool)
        .await
        .unwrap();
    query("UPDATE cloud_agent_fallback_runs SET prompt=jsonb_set(prompt::jsonb,'{triage}','true')::text WHERE run_id=$1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    let route = json!({"defaultModel":"anthropic/claude-opus-4-8","defaultAuthProvider":"anthropic",
        "defaultAuthChoice":"cloud-login:work","thinking":"high"});
    let claimed = fx
        .mac_claim_with_route(&run_id, uuid::Uuid::new_v4(), route)
        .await;
    assert_eq!(claimed["acquired"], true);
    let digest = &claimed["digest"];
    assert_eq!(digest["triage"], true);
    assert_eq!(digest["tools"], json!([]));
    assert_eq!(digest["thinking"], "off");
    assert_eq!(digest["model"], "anthropic/claude-haiku-4-5");
    assert!(digest["prompt"]
        .as_str()
        .unwrap()
        .contains("need the viewer's attention soon"));
    fx.finish().await;
}
