//! Rechecking a run while it is held reads the run as it was claimed, not the
//! chat's history: the agent it executes was resolved at claim, and the
//! requester and the owner must still be allowed to use that agent and be
//! active members of the chat. Only the executor holding a run can make the
//! server recheck it.
use super::consent_admission::{claim, group_request, remove_contact, run_state, shared_agent};
use super::consent_desktop_runs::desktop_call;
use super::*;

const RUNNER: &str = "consent-recheck-runner";

async fn lease(router: &axum::Router, run_id: &str) -> Value {
    let response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({"runnerId": RUNNER, "canaryRunId": run_id}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    read_json(response).await
}

fn revoked() -> (String, Option<String>) {
    (
        "cancelled".to_string(),
        Some("relationship_revoked".to_string()),
    )
}

#[tokio::test]
async fn rechecks_use_the_agent_and_members_the_run_was_claimed_with() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "consent-recheck-owner", "Owner").await;
    let friend = signup(&router, "consent-recheck-friend", "Friend").await;
    let requester = signup(&router, "consent-recheck-requester", "Requester").await;
    accept_contacts(&router, &owner, &friend).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![friend.account_id.clone()],
    )
    .await;
    // The requester joined through an invite link and is not the owner's contact.
    let mut transaction = pool.begin().await.unwrap();
    chat_store::accept_invited_conversation_member(
        &mut transaction,
        &owner.account_id,
        &session,
        &requester.account_id,
    )
    .await
    .unwrap();
    transaction.commit().await.unwrap();
    let helper = shared_agent(&pool, &owner).await;
    let default_agent = format!("cloud-agent:{}", owner.account_id);

    // Two requests for the shared agent, one for the owner's default agent.
    let mut runs = Vec::new();
    let mut wire_ids = Vec::new();
    for (asker, agent) in [
        (&requester, &helper),
        (&requester, &helper),
        (&friend, &default_agent),
    ] {
        let (request, body) = group_request(&session, &owner, asker, agent);
        wire_ids.push(insert_test_message(&pool, &asker.account_id, conversation, &body).await);
        let (status, claimed) = claim(
            &router,
            asker,
            claim_body_with_session(&owner, asker, &request, &session),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{claimed}");
        runs.push(claimed["runId"].as_str().unwrap().to_string());
    }

    // Deleting the request does not change the agent the run was admitted
    // for: the recheck never reads the chat's messages again.
    sqlx_core::query::query(
        "UPDATE cloud_chat_messages SET deleted_at = now() WHERE message_id = $1",
    )
    .bind(uuid::Uuid::parse_str(&wire_ids[0]).unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let leased = lease(&router, &runs[0]).await;
    assert_eq!(leased["run"]["status"], "leased", "{leased}");

    // Unsharing the agent stops work that still waits for it.
    sqlx_core::query::query(
        "UPDATE cloud_agent_definitions SET access_scope = 'private' WHERE agent_id = $1",
    )
    .bind(&helper)
    .execute(&pool)
    .await
    .unwrap();
    let cancelled = lease(&router, &runs[1]).await;
    assert_eq!(cancelled["run"]["status"], "cancelled", "{cancelled}");
    assert_eq!(run_state(&pool, &runs[1]).await, revoked());

    // A contact who left the group no longer has the owner's agent answer
    // there.
    sqlx_core::query::query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left' \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation)
    .bind(&friend.account_id)
    .execute(&pool)
    .await
    .unwrap();
    let cancelled = lease(&router, &runs[2]).await;
    assert_eq!(cancelled["run"]["status"], "cancelled", "{cancelled}");
    assert_eq!(run_state(&pool, &runs[2]).await, revoked());
}

#[tokio::test]
async fn only_the_desktop_holding_a_run_makes_the_server_recheck_it() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let owner = signup(&router, "consent-holder-owner", "Owner").await;
    let requester = signup(&router, "consent-holder-requester", "Requester").await;
    let stranger = signup(&router, "consent-holder-stranger", "Stranger").await;
    accept_contacts(&router, &requester, &owner).await;
    let session = format!("session:group:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        &pool,
        &owner.account_id,
        &session,
        ConversationKind::Group,
        vec![requester.account_id.clone()],
    )
    .await;
    let agent = format!("cloud-agent:{}", owner.account_id);
    sqlx_core::query::query("UPDATE cloud_devices SET device_platform='macos' WHERE account_id=$1")
        .bind(&owner.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = desktop_call(
        &router,
        &owner,
        "ready".into(),
        // A current executor (context contract 2) may answer another member's
        // request in a group that shares only mentions with agents.
        json!({"agentIds": [agent], "contextContract": 2}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (request, body) = group_request(&session, &owner, &requester, &agent);
    let wire_id = insert_test_message(&pool, &requester.account_id, conversation, &body).await;
    let claim_id = uuid::Uuid::new_v4();
    let mut input = claim_body_with_session(&owner, &requester, &request, &session);
    input["claimId"] = json!(claim_id);
    input["contextContract"] = json!(2);
    input["requestMessageId"] = json!(wire_id);
    let (status, claimed) = desktop_call(&router, &owner, "claim".into(), input).await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    let run_id = claimed["runId"].as_str().unwrap().to_string();

    remove_contact(&pool, &owner, &requester).await;

    // Someone who does not hold the run is refused before any recheck, so
    // the run is left as it is for its holder.
    let progress = format!(
        "kordi-cloud-agent-response:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            json!({"kind": "agent-response", "requestId": request,
                   "text": "Not the holder", "deliveryState": "complete"})
            .to_string()
        )
    );
    for (caller, claim) in [
        (&stranger, uuid::Uuid::new_v4()),
        (&owner, uuid::Uuid::new_v4()),
    ] {
        for path in ["renew", "admit"] {
            let (status, body) = desktop_call(
                &router,
                caller,
                format!("{run_id}/{path}"),
                json!({"claimId": claim}),
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{path}: {body}");
            assert_eq!(body["errorCode"], "execution_lease_lost");
        }
        let (status, body) = desktop_call(
            &router,
            caller,
            format!("{run_id}/progress"),
            json!({"claimId": claim, "clientMessageId": uuid::Uuid::new_v4(), "body": progress}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            run_state(&pool, &run_id).await,
            ("leased".to_string(), None)
        );
    }

    // The holder's renewal rechecks the run and cancels it.
    let (status, body) = desktop_call(
        &router,
        &owner,
        format!("{run_id}/renew"),
        json!({"claimId": claim_id}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(run_state(&pool, &run_id).await, revoked());
}
