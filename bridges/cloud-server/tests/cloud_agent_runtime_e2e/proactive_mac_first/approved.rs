//! Approved runs: held for the ready Mac, claimed by run id, delivered in
//! the group as the agent, and run by the cloud when no Mac does.

use super::*;

#[tokio::test]
async fn an_allowed_offer_runs_on_the_ready_mac_and_answers_as_the_agent() {
    let Some(fx) = fixture("proactive-mac-allow", true).await else {
        return;
    };
    let (proposal_id, trigger) = fx.offer().await;
    let run_id = fx.allow(&proposal_id).await;
    let (status, backend, held) = fx.run_state(&run_id).await;
    assert_eq!(
        (status.as_str(), backend.as_str(), held),
        ("queued", "cloud", true)
    );
    assert_eq!(
        fx.hints("proactive.run_requested").await,
        vec![json!({
            "runId": run_id,
            "sessionId": fx.session_id,
            "agentId": fx.agent_id,
            "proposalId": proposal_id,
        })]
    );
    assert!(
        !runner_can_lease(&fx.router, &run_id).await,
        "the Mac goes first"
    );

    // A generic group claim for the collaborator's message is no way in.
    let generic = json!({
        "claimId": uuid::Uuid::new_v4(),
        "requestMessageId": trigger,
        "sessionId": fx.session_id,
        "ownerAccountId": fx.owner.account_id,
        "requesterAccountId": fx.member.account_id,
        "prompt": REQUEST,
        "idempotencyKey": format!("{}:{trigger}:{}", fx.session_id, fx.owner.account_id),
    });
    let (_, body) = fx.post("/v1/cloud/agent-runs/desktop/claim", generic).await;
    assert_ne!(body["acquired"], true, "{body}");
    let (others,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs \
         WHERE request_message_id = $1 AND starts_with(run_id, 'car_')",
    )
    .bind(&trigger)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(others, 0, "no second run answers the same message");
    assert_eq!(fx.run_state(&run_id).await.0, "queued");

    // The owner left the group: the Mac may not run it.
    query("UPDATE cloud_chat_conversation_members SET membership_state = 'left' WHERE conversation_id = $1 AND account_id = $2")
        .bind(fx.group).bind(&fx.owner.account_id).execute(&fx.pool).await.unwrap();
    let (status, _) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    query("UPDATE cloud_chat_conversation_members SET membership_state = 'active' WHERE conversation_id = $1 AND account_id = $2")
        .bind(fx.group).bind(&fx.owner.account_id).execute(&fx.pool).await.unwrap();
    // A claim that names another session is refused too.
    let mut elsewhere = fx.claim_body(&run_id, uuid::Uuid::new_v4());
    elsewhere["sessionId"] = json!("session:group:elsewhere");
    let (status, _) = fx
        .post("/v1/cloud/agent-runs/desktop/claim", elsewhere)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let claim_id = uuid::Uuid::new_v4();
    let claimed = fx.mac_takes(&run_id, claim_id).await;
    assert_eq!(claimed["leaseSeconds"], 45);
    assert_eq!(claimed["proactive"], json!({"kind": "approved"}));
    let identity = &claimed["turnIdentity"];
    assert_eq!(identity["ownerAccountId"], fx.owner.account_id.as_str());
    assert_eq!(identity["requesterAccountId"], fx.owner.account_id.as_str());
    assert_eq!(identity["agentId"], fx.agent_id.as_str());
    assert_eq!(identity["requestId"], trigger.as_str());
    assert_eq!(claimed["contextSessionId"], fx.session_id.as_str());
    assert_eq!(claimed["trigger"], "person_started");
    // The same descriptors as a cloud lease of this run: a shared run gets
    // only the group's own document tool, never the owner's connectors.
    let tools: Vec<&str> = claimed["connectorTools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["connectorId"].as_str().unwrap())
        .collect();
    assert!(tools.iter().all(|id| *id == "kordi-documents"), "{tools:?}");
    assert!(claimed["prompt"]
        .as_str()
        .unwrap()
        .contains("Mina asked you to help Riya"));
    let (system_prompt,): (String,) =
        query_as("SELECT system_prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
    assert_eq!(claimed["systemPrompt"], system_prompt.as_str());
    assert!(!system_prompt.is_empty());
    let (status, second) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(
        (status, &second["acquired"]),
        (StatusCode::OK, &json!(false))
    );
    let (status, renewed) = fx
        .post(
            &format!("/v1/cloud/agent-runs/desktop/{run_id}/renew"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{renewed}");

    // The Mac admits the run before its turn starts, as for scheduled runs.
    let (status, admitted) = fx
        .post(
            &format!("/v1/cloud/agent-runs/desktop/{run_id}/admit"),
            json!({"claimId": claim_id}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{admitted}");
    assert_eq!(admitted["admitted"], true);
    assert_eq!(fx.run_state(&run_id).await.0, "running");

    let reply = "Riya, the deploy fails at the migration step.";
    assert_eq!(
        fx.mac_complete(&run_id, uuid::Uuid::new_v4(), reply).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, reply).await,
        StatusCode::OK
    );
    assert_eq!(fx.run_state(&run_id).await.0, "completed");
    let (conversation, content): (uuid::Uuid, Value) = query_as(
        "SELECT m.conversation_id, m.content FROM cloud_agent_fallback_runs run \
         JOIN cloud_chat_messages m ON m.message_id::text = run.response_message_id \
         WHERE run.run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(conversation, fx.group, "the reply lands in the group");
    let envelope = decode_test_cloud_group_envelope(content["blocks"][0]["text"].as_str().unwrap());
    let message = &envelope["message"];
    assert_eq!(message["senderKind"], "agent");
    assert_eq!(message["senderAgentId"], fx.agent_id.as_str());
    assert_eq!(
        message["senderOwnerAccountId"],
        fx.owner.account_id.as_str()
    );
    assert_eq!(message["replyToMessageId"], trigger.as_str());
    assert_eq!(message["text"], reply);
    assert_eq!(fx.proposal_status(&proposal_id).await, "done");
    fx.finish().await;
}

#[tokio::test]
async fn an_approved_run_no_mac_claims_goes_to_the_cloud_after_the_hold() {
    let Some(fx) = fixture("proactive-mac-silent", true).await else {
        return;
    };
    let (proposal_id, _) = fx.offer().await;
    let run_id = fx.allow(&proposal_id).await;
    assert!(!runner_can_lease(&fx.router, &run_id).await);
    query("UPDATE cloud_agent_fallback_runs SET desktop_preferred_until = now() - interval '1 second' WHERE run_id = $1")
        .bind(&run_id).execute(&fx.pool).await.unwrap();
    assert!(runner_can_lease(&fx.router, &run_id).await);
    assert!(!runner_can_lease(&fx.router, &run_id).await, "leased once");
    let (status, late) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(late["acquired"], false, "a late Mac never runs it again");
    assert_eq!(
        fx.run_state(&run_id).await,
        ("leased".into(), "cloud".into(), false)
    );
    fx.finish().await;
}

#[tokio::test]
async fn a_released_approved_run_goes_to_the_cloud_once() {
    let Some(fx) = fixture("proactive-mac-handback", true).await else {
        return;
    };
    let (proposal_id, _) = fx.offer().await;
    let run_id = fx.allow(&proposal_id).await;
    let claim_id = uuid::Uuid::new_v4();
    fx.mac_takes(&run_id, claim_id).await;
    assert_eq!(fx.release(&run_id, claim_id).await["released"], true);
    assert_eq!(
        fx.release(&run_id, claim_id).await["released"],
        false,
        "once"
    );
    assert!(runner_can_lease(&fx.router, &run_id).await);
    assert!(!runner_can_lease(&fx.router, &run_id).await, "leased once");
    let (status, late) = fx.mac_claim(&run_id, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(late["acquired"], false);
    fx.finish().await;
}

/// The group is a session of a project on another Mac of the owner. An
/// evaluation has no tools, so it ignores the project; the approved run
/// keeps the project rule and waits for a Mac with the project.
#[tokio::test]
async fn an_evaluation_needs_no_project_folder_but_the_approved_run_does() {
    let Some(fx) = fixture("proactive-mac-project", true).await else {
        return;
    };
    let other_mac = format!("dev_proactive_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at, device_platform) VALUES ($1, $2, 'Studio Mac', $3, $4, $4, 'macos')",
    )
    .bind(&other_mac)
    .bind(&fx.owner.account_id)
    .bind(format!("legacy:{other_mac}"))
    .bind(&now)
    .execute(&fx.pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_project_devices (device_id, account_id, projects, updated_at) \
         VALUES ($1, $2, $3, now())",
    )
    .bind(&other_mac)
    .bind(&fx.owner.account_id)
    .bind(json!([{"id": "e".repeat(64), "name": "Launch", "sessions": [fx.session_id]}]))
    .execute(&fx.pool)
    .await
    .unwrap();

    let run_id = fx.evaluation().await;
    let claim_id = uuid::Uuid::new_v4();
    fx.mac_takes(&run_id, claim_id).await;
    assert_eq!(fx.release(&run_id, claim_id).await["released"], true);
    assert!(
        runner_can_lease(&fx.router, &run_id).await,
        "the cloud can answer it"
    );
    query("UPDATE cloud_agent_fallback_runs SET status='cancelled' WHERE run_id=$1")
        .bind(&run_id)
        .execute(&fx.pool)
        .await
        .unwrap();
    query("UPDATE cloud_agent_proactive_state SET active_run_id = NULL WHERE active_run_id = $1")
        .bind(&run_id)
        .execute(&fx.pool)
        .await
        .unwrap();

    let (proposal_id, _) = fx.offer().await;
    let approved = fx.allow(&proposal_id).await;
    let (status, body) = fx.mac_claim(&approved, uuid::Uuid::new_v4()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"acquired": false}), "the project Mac runs it");
    assert_eq!(fx.run_state(&approved).await.0, "queued");
    query("DELETE FROM cloud_project_devices WHERE device_id = $1")
        .bind(&other_mac)
        .execute(&fx.pool)
        .await
        .unwrap();
    fx.finish().await;
}

#[tokio::test]
async fn a_mac_with_a_hosted_account_gets_its_credentials_for_both_run_kinds() {
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let Some(fx) = fixture("proactive-mac-hosted", true).await else {
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
    let route = json!({"defaultModel":"openai/gpt-4.1-mini","defaultAuthProvider":"openai",
        "defaultAuthChoice":"cloud-api-key:work"});
    let hosted_claim = |run_id: &str, claim_id: uuid::Uuid| {
        let mut body = fx.claim_body(run_id, claim_id);
        body["runtimeRoute"] = route.clone();
        body
    };
    let credentials = |run_id: String, claim_id: uuid::Uuid| {
        let fx = &fx;
        async move {
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
            let (stored,): (Value,) = query_as(
                "SELECT runtime_route_json FROM cloud_agent_fallback_runs WHERE run_id = $1",
            )
            .bind(&run_id)
            .fetch_one(&fx.pool)
            .await
            .unwrap();
            assert_eq!(stored["defaultAuthChoice"], "cloud-api-key:work");
        }
    };

    let run_id = fx.evaluation().await;
    let claim_id = uuid::Uuid::new_v4();
    let (status, claimed) = fx
        .post(
            "/v1/cloud/agent-runs/desktop/claim",
            hosted_claim(&run_id, claim_id),
        )
        .await;
    assert_eq!(
        (status, &claimed["acquired"]),
        (StatusCode::OK, &json!(true)),
        "{claimed}"
    );
    credentials(run_id.clone(), claim_id).await;
    let trigger = trigger_of(&claimed["proactive"]["prompt"]);
    assert_eq!(
        fx.mac_complete(&run_id, claim_id, &offer_reply(&trigger))
            .await,
        StatusCode::OK
    );
    let (proposal_id,): (String,) = query_as(
        "SELECT proposal_id FROM cloud_agent_proactive_proposals WHERE evaluation_run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();

    let approved = fx.allow(&proposal_id).await;
    let claim_id = uuid::Uuid::new_v4();
    let (status, claimed) = fx
        .post(
            "/v1/cloud/agent-runs/desktop/claim",
            hosted_claim(&approved, claim_id),
        )
        .await;
    assert_eq!(
        (status, &claimed["acquired"]),
        (StatusCode::OK, &json!(true)),
        "{claimed}"
    );
    credentials(approved, claim_id).await;
    fx.finish().await;
}
