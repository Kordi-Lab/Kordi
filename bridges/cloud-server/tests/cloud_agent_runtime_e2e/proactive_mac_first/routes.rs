//! A Mac's claim never replaces an evaluation's own route: the Mac's hosted
//! account is held beside it for the claim holder's credentials, and the
//! cloud runs the evaluation with its own route after a hand-back or a
//! takeover.

use super::*;

/// The evaluation's own route, as the sweep stored it.
fn evaluation_route() -> Value {
    json!({"defaultModel": "anthropic/claude-haiku-4-5", "defaultAuthProvider": "anthropic",
        "defaultAuthChoice": "cloud-api-key:eval", "thinking": "low"})
}

/// The Mac's own hosted account route, which its claim sends.
fn mac_route() -> Value {
    json!({"defaultModel": "openai/gpt-4.1-mini", "defaultAuthProvider": "openai",
        "defaultAuthChoice": "cloud-api-key:work"})
}

impl Fixture {
    /// The owner's saved hosted account the Mac's route names.
    async fn save_mac_account(&self) {
        std::env::set_var(
            "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
            "test-provider-auth-key-that-is-long-enough",
        );
        let (status, saved) = self
            .post(
                "/v1/cloud/agent-provider-auth/snapshots?intent=explicit",
                json!({"provider":"openai","authChoice":"cloud-api-key:work",
                    "payload":{"apiKey":"synthetic-hosted-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{saved}");
    }

    /// An evaluation with [`evaluation_route`], claimed by the Mac with
    /// [`mac_route`]; returns its run id and claim id.
    async fn claimed_evaluation(&self) -> (String, uuid::Uuid) {
        self.save_mac_account().await;
        let run_id = self.evaluation().await;
        query("UPDATE cloud_agent_fallback_runs SET runtime_route_json = $2 WHERE run_id = $1")
            .bind(&run_id)
            .bind(evaluation_route())
            .execute(&self.pool)
            .await
            .unwrap();
        let claim_id = uuid::Uuid::new_v4();
        let mut body = self.claim_body(&run_id, claim_id);
        body["runtimeRoute"] = mac_route();
        let (status, claimed) = self.post("/v1/cloud/agent-runs/desktop/claim", body).await;
        assert_eq!(
            (status, &claimed["acquired"]),
            (StatusCode::OK, &json!(true)),
            "{claimed}"
        );
        // The Mac reads the evaluation's own model.
        assert_eq!(claimed["proactive"]["model"], "anthropic/claude-haiku-4-5");
        assert_eq!(claimed["proactive"]["provider"], "anthropic");
        (run_id, claim_id)
    }

    async fn stored_route(&self, run_id: &str) -> Value {
        let (route,): (Value,) =
            query_as("SELECT runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id = $1")
                .bind(run_id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        route
    }
}

#[tokio::test]
async fn a_mac_claim_keeps_the_evaluation_route_for_a_hand_back() {
    let Some(fx) = fixture("proactive-mac-route-handback", true).await else {
        return;
    };
    let (run_id, claim_id) = fx.claimed_evaluation().await;
    let mut held = evaluation_route();
    held["desktopRoute"] = mac_route();
    assert_eq!(fx.stored_route(&run_id).await, held);
    // The claim holder gets the credentials of the Mac's own account.
    let (status, material) = fx
        .post(
            &format!("/v1/cloud/agent-runs/{run_id}/desktop/provider-auth"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{material}");
    assert_eq!(material["providerAuth"]["authChoice"], "cloud-api-key:work");

    assert_eq!(fx.release(&run_id, claim_id).await["released"], true);
    assert_eq!(
        fx.stored_route(&run_id).await,
        evaluation_route(),
        "the hand-back keeps the evaluation's own route"
    );
    let run = runner_lease(&fx.router, "runner-proactive-route", &run_id).await;
    assert_eq!(run["runId"], run_id.as_str());
    assert_eq!(run["runtimeRoute"], evaluation_route());
    fx.finish().await;
}

#[tokio::test]
async fn a_takeover_after_the_mac_lease_lapses_runs_the_evaluation_route() {
    let Some(fx) = fixture("proactive-mac-route-lapse", true).await else {
        return;
    };
    let (run_id, _) = fx.claimed_evaluation().await;
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at = (now() - interval '1 minute')::text WHERE run_id = $1")
        .bind(&run_id)
        .execute(&fx.pool)
        .await
        .unwrap();
    let run = runner_lease(&fx.router, "runner-proactive-lapse", &run_id).await;
    assert_eq!(run["runId"], run_id.as_str(), "the cloud takes it over");
    assert_eq!(run["runtimeRoute"], evaluation_route());
    fx.finish().await;
}
