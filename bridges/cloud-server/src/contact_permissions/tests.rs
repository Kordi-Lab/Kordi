//! Database tests for per-person permissions: the routes, and "Use my agent"
//! on every path that admits a request to someone else's agent. They use
//! the Common ground fixture and its skip rule: outside CI they return early
//! without `$DATABASE_URL`.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::runs::{
    claim_run_for_person_message, requester_can_target_owner, ClaimRunRequest, RunError,
};
use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};

fn path(account_id: &str) -> String {
    format!("/v1/cloud/contacts/{account_id}/permissions")
}

async fn befriend(pool: &PgPool, left: &str, right: &str) {
    for (owner, peer) in [(left, right), (right, left)] {
        query("INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3)")
            .bind(owner)
            .bind(peer)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(pool)
            .await
            .unwrap();
    }
}

/// A group conversation with these active members; returns its session id.
async fn group(pool: &PgPool, members: &[&str]) -> String {
    let session = format!("session:group:perm-{}", Uuid::new_v4().simple());
    conversation(pool, "group", &session, members).await;
    session
}

async fn conversation(pool: &PgPool, kind: &str, session: &str, members: &[&str]) {
    let id = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
         client_operation_id, creation_fingerprint, legacy_session_id, group_space_id, group_title) \
         VALUES ($1, $5, $2, $3, 'fixture', $4, $6, $7)",
    )
    .bind(id)
    .bind(members[0])
    .bind(Uuid::new_v4())
    .bind(session)
    .bind(kind)
    .bind((kind == "group").then_some(session))
    .bind((kind == "group").then_some("Group"))
    .execute(pool)
    .await
    .unwrap();
    for member in members {
        query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2)")
            .bind(id)
            .bind(member)
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn shared_agent(app: &axum::Router, token: &str) -> String {
    let body = json!({
        "name": "Scout",
        "role": "Research helper",
        "systemPrompt": "Help with research.",
        "accessScope": "participant_conversations",
    });
    let (status, body) = send(app, "POST", "/v1/cloud/agents", token, Some(body)).await;
    assert!(status == 200 || status == 201, "{status} {body}");
    body["agent"]["agentId"]
        .as_str()
        .or_else(|| body["agentId"].as_str())
        .unwrap()
        .to_string()
}

fn claim(owner: &str, requester: &str, session: &str) -> ClaimRunRequest {
    let id = Uuid::new_v4().to_string();
    ClaimRunRequest {
        request_message_id: id.clone(),
        session_id: session.to_string(),
        owner_account_id: owner.to_string(),
        requester_account_id: requester.to_string(),
        prompt: "Summarize the thread".into(),
        runtime_route: None,
        idempotency_key: id,
    }
}

async fn insert_run(
    pool: &PgPool,
    owner: &str,
    requester: &str,
    status: &str,
    session: &str,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs \
         (run_id, idempotency_key, request_message_id, session_id, owner_account_id, \
          requester_account_id, status, prompt, created_at, updated_at) \
         VALUES ($1, $1, $1, $6, $2, $3, $4, 'hello', $5, $5)",
    )
    .bind(&run_id)
    .bind(owner)
    .bind(requester)
    .bind(status)
    .bind(&now)
    .bind(session)
    .execute(pool)
    .await
    .unwrap();
    run_id
}

async fn run_state(pool: &PgPool, run_id: &str) -> (String, bool) {
    query_as(
        "SELECT status, cancel_requested_at IS NOT NULL FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn permissions_default_on_persist_and_stay_private() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "perm_mina").await;
    let (riya, riya_token) = signed_in(&pool, "perm_riya").await;
    let (stranger, _) = signed_in(&pool, "perm_stranger").await;
    befriend(&pool, &mina, &riya).await;

    let (status, body) = send(&app, "GET", &path(&riya), &mina_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agentAccess"], true);
    assert_eq!(body["cardAccess"], true);
    assert_eq!(body["updatedAt"], Value::Null);

    let off = json!({"agentAccess": false});
    let (status, body) = send(&app, "PUT", &path(&riya), &mina_token, Some(off)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agentAccess"], false);
    assert_eq!(body["cardAccess"], true, "a missing key keeps its value");
    assert!(body["updatedAt"].is_string());

    // The owner's contact profile carries the values; Riya's view of Mina
    // carries only Riya's own (default) choices.
    let profile = format!("/v1/cloud/contacts/{riya}/profile");
    let (_, body) = send(&app, "GET", &profile, &mina_token, None).await;
    assert_eq!(
        body["permissions"],
        json!({"agentAccess": false, "cardAccess": true})
    );
    let profile = format!("/v1/cloud/contacts/{mina}/profile");
    let (_, body) = send(&app, "GET", &profile, &riya_token, None).await;
    assert_eq!(
        body["permissions"],
        json!({"agentAccess": true, "cardAccess": true})
    );
    let (_, body) = send(&app, "GET", &path(&mina), &riya_token, None).await;
    assert_eq!(body["agentAccess"], true);

    // Strangers, unknown accounts and yourself are not found.
    for other in [stranger.as_str(), "acct_missing", mina.as_str()] {
        let (status, _) = send(&app, "GET", &path(other), &mina_token, None).await;
        assert_eq!(status, 404, "{other}");
        let (status, _) = send(
            &app,
            "PUT",
            &path(other),
            &mina_token,
            Some(json!({"cardAccess": false})),
        )
        .await;
        assert_eq!(status, 404, "{other}");
    }
    let (status, _) = send(
        &app,
        "PUT",
        &path(&riya),
        &mina_token,
        Some(json!({"agent": false})),
    )
    .await;
    assert_eq!(status, 422);

    // Removing the contact keeps the row, and it can still be read and lifted.
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/v1/cloud/contacts/{riya}"),
        &mina_token,
        None,
    )
    .await;
    assert!(status < 300);
    let (status, body) = send(&app, "GET", &path(&riya), &mina_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["agentAccess"], false);
    assert!(
        !crate::contact_permissions::agent_allowed(&pool, &mina, &riya)
            .await
            .unwrap()
    );
    assert!(
        crate::contact_permissions::agent_allowed(&pool, &riya, &mina)
            .await
            .unwrap()
    );
    let on = json!({"agentAccess": true});
    let (_, body) = send(&app, "PUT", &path(&riya), &mina_token, Some(on)).await;
    assert_eq!(body["agentAccess"], true);
}

#[tokio::test]
async fn agent_off_refuses_every_claim_path_for_that_person_only() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "perm_owner").await;
    let (riya, riya_token) = signed_in(&pool, "perm_asker").await;
    let (sam, sam_token) = signed_in(&pool, "perm_other").await;
    befriend(&pool, &mina, &riya).await;
    befriend(&pool, &mina, &sam).await;
    let session = group(&pool, &[&mina, &riya, &sam]).await;
    let agent = shared_agent(&app, &mina_token).await;
    let shared = format!("/v1/cloud/agents/shared?ownerAccountIds={mina}");
    let listed = |body: &Value| -> Vec<String> {
        body["agents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["agentId"].as_str().unwrap().to_string())
            .collect()
    };
    let (_, body) = send(&app, "GET", &shared, &riya_token, None).await;
    assert_eq!(listed(&body), vec![agent.clone()]);
    let candidates =
        crate::document_shares::agents::mentions::candidates_for_account(&pool, &riya, &session)
            .await
            .unwrap();
    assert!(candidates.iter().any(|c| c.agent_id == agent));
    assert!(requester_can_target_owner(&pool, &riya, &mina)
        .await
        .unwrap());

    let off = json!({"agentAccess": false});
    assert_eq!(
        send(&app, "PUT", &path(&riya), &mina_token, Some(off))
            .await
            .0,
        200
    );

    // The shared list and the document mention list leave Mina's agents out.
    let (_, body) = send(&app, "GET", &shared, &riya_token, None).await;
    assert!(listed(&body).is_empty(), "{body}");
    let candidates =
        crate::document_shares::agents::mentions::candidates_for_account(&pool, &riya, &session)
            .await
            .unwrap();
    assert!(!candidates.iter().any(|c| c.owner_account_id == mina));
    // Direct, group and shared-agent claims are refused with the generic 403.
    assert!(!requester_can_target_owner(&pool, &riya, &mina)
        .await
        .unwrap());
    let input = claim(&mina, &riya, &session);
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &riya_token,
        Some(
            serde_json::to_value(json!({
                "requestMessageId": input.request_message_id,
                "sessionId": input.session_id,
                "ownerAccountId": input.owner_account_id,
                "requesterAccountId": input.requester_account_id,
                "prompt": input.prompt,
                "idempotencyKey": input.idempotency_key,
            }))
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(
        body["errorCode"],
        crate::contact_permissions::AGENT_REFUSAL_CODE
    );
    assert_eq!(
        body["message"],
        crate::contact_permissions::AGENT_REFUSAL_MESSAGE
    );
    assert!(matches!(
        claim_run_for_person_message(&pool, &input, None).await,
        Err(RunError::AgentUnavailable)
    ));
    assert!(
        !crate::cloud_agent_runtime::runs::validate_group_agent_claim(&pool, &input)
            .await
            .unwrap()
    );
    assert!(
        !crate::cloud_agent_runtime::runs::validate_shared_cloud_agent_claim(&pool, &input)
            .await
            .unwrap()
    );

    // Sam is unaffected, and Mina still uses Riya's agent (one-directional).
    let (_, body) = send(&app, "GET", &shared, &sam_token, None).await;
    assert_eq!(listed(&body), vec![agent.clone()]);
    assert!(requester_can_target_owner(&pool, &sam, &mina)
        .await
        .unwrap());
    assert!(requester_can_target_owner(&pool, &mina, &riya)
        .await
        .unwrap());
}

#[tokio::test]
async fn agent_off_ends_waiting_and_running_requests_with_the_generic_reply() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "perm_stop_owner").await;
    let (riya, _) = signed_in(&pool, "perm_stop_asker").await;
    let (sam, _) = signed_in(&pool, "perm_stop_other").await;
    befriend(&pool, &mina, &riya).await;
    let direct = crate::auth::routes::direct_person_session_id(&mina, &riya);
    conversation(&pool, "direct", &direct, &[&mina, &riya]).await;
    let queued = insert_run(&pool, &mina, &riya, "queued", &direct).await;
    let running = insert_run(&pool, &mina, &riya, "running", "session:perm").await;
    let others = insert_run(&pool, &mina, &sam, "queued", "session:perm").await;
    let card_only = json!({"cardAccess": false});
    let (status, _) = send(&app, "PUT", &path(&riya), &mina_token, Some(card_only)).await;
    assert_eq!(status, 200);
    assert_eq!(run_state(&pool, &queued).await, ("queued".into(), false));

    let off = json!({"agentAccess": false});
    let (status, _) = send(&app, "PUT", &path(&riya), &mina_token, Some(off)).await;
    assert_eq!(status, 200);
    assert_eq!(run_state(&pool, &queued).await, ("cancelled".into(), true));
    assert_eq!(run_state(&pool, &running).await, ("cancelled".into(), true));
    assert_eq!(run_state(&pool, &others).await, ("queued".into(), false));
    // The waiting request is answered, so it does not stay processing.
    let (reply,): (Option<String>,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&queued)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(reply.is_some(), "the refusal reply is published");

    // The owner's Mac reads the same rules.
    let (status, body) = send(
        &app,
        "GET",
        "/v1/cloud/contacts/permissions",
        &mina_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["people"],
        json!([{"accountId": riya, "agentAccess": false, "cardAccess": false, "updatedAt": body["people"][0]["updatedAt"]}])
    );
}

#[tokio::test]
async fn a_restriction_saved_while_admitting_either_refuses_or_ends_the_run() {
    let Some(pool) = pool().await else { return };
    let (mina, _) = signed_in(&pool, "perm_race_owner").await;
    let (riya, _) = signed_in(&pool, "perm_race_asker").await;
    befriend(&pool, &mina, &riya).await;
    let session = group(&pool, &[&mina, &riya]).await;
    // Hold the pair's lock as a concurrent save would: admission waits for
    // it, then sees the restriction.
    let mut tx = pool.begin().await.unwrap();
    super::lock_pair(&mut tx, &mina, &riya).await.unwrap();
    query("INSERT INTO cloud_contact_permissions (owner_account_id, subject_account_id, agent_access) VALUES ($1, $2, false)")
        .bind(&mina)
        .bind(&riya)
        .execute(&mut *tx)
        .await
        .unwrap();
    let mut admit = Box::pin(async {
        let mut tx = pool.begin().await.unwrap();
        super::lock_and_check_agent(&mut tx, &mina, &riya)
            .await
            .unwrap()
    });
    let waited = tokio::time::timeout(std::time::Duration::from_millis(300), admit.as_mut()).await;
    assert!(waited.is_err(), "admission waits for the lock");
    tx.commit().await.unwrap();
    assert!(!admit.await, "and then sees the restriction");
    assert!(matches!(
        claim_run_for_person_message(&pool, &claim(&mina, &riya, &session), None).await,
        Err(RunError::AgentUnavailable)
    ));
}

#[tokio::test]
async fn a_run_leased_after_a_restriction_ends_with_the_generic_reply() {
    let Some(pool) = pool().await else { return };
    let (mina, _) = signed_in(&pool, "perm_lease_owner").await;
    let (riya, _) = signed_in(&pool, "perm_lease_asker").await;
    befriend(&pool, &mina, &riya).await;
    let direct = crate::auth::routes::direct_person_session_id(&mina, &riya);
    conversation(&pool, "direct", &direct, &[&mina, &riya]).await;
    let run = insert_run(&pool, &mina, &riya, "queued", &direct).await;
    // Written directly, as if the save had missed this run.
    query("INSERT INTO cloud_contact_permissions (owner_account_id, subject_account_id, agent_access) VALUES ($1, $2, false)")
        .bind(&mina)
        .bind(&riya)
        .execute(&pool)
        .await
        .unwrap();
    let leased = crate::cloud_agent_runtime::runs::lease_canary_run(&pool, "perm-runner", &run)
        .await
        .unwrap()
        .expect("the run is offered once");
    assert_eq!(leased.status, "cancelled");
    assert!(leased.prompt.is_empty(), "the runner gets nothing to run");
    let (status, reply): (String, Option<String>) = query_as(
        "SELECT status, response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "cancelled");
    assert!(reply.is_some(), "the refusal reply is published");
}
