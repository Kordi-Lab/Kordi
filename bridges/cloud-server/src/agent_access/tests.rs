//! Database tests for agent Access on the owner's default agent and on
//! Factory agents. They use the Common ground fixture and its skip rule:
//! outside CI they return early without `$DATABASE_URL`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::runs::{
    claim_run_for_person_message, requester_may_use_owner_agents, RunError,
};
use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};
use crate::contact_permissions::tests::{
    befriend, claim, conversation, group, insert_run, run_state,
};
use crate::contact_permissions::{AGENT_REFUSAL_CODE, AGENT_REFUSAL_MESSAGE};

fn access_path(agent_id: &str) -> String {
    format!("/v1/cloud/agents/{agent_id}/access")
}

fn default_id(owner: &str) -> String {
    format!("cloud-agent:{owner}")
}

/// Posts a group message from `sender` that targets `owner`'s default
/// agent; returns its request id.
async fn mention(
    pool: &PgPool,
    session: &str,
    sender: &str,
    owner: &str,
    members: &[&str],
) -> String {
    let (conversation,): (Uuid,) = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations WHERE legacy_session_id = $1",
    )
    .bind(session)
    .fetch_one(pool)
    .await
    .unwrap();
    let id = Uuid::new_v4();
    let person =
        |account: &str| json!({"accountId": account, "displayName": account, "avatarUrl": null});
    let envelope = json!({
        "kind": "group-message", "groupId": session, "groupTitle": null,
        "createdByAccountId": sender, "actor": person(sender),
        "participants": members.iter().map(|m| person(m)).collect::<Vec<_>>(),
        "message": {"id": id.to_string(), "senderAccountId": sender, "text": "@Kordi summarize",
                    "createdAtMs": 0, "senderKind": "person",
                    "targetCloudAgentId": default_id(owner), "targetCloudAgentOwnerAccountId": owner},
    });
    let body = format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    );
    // Take the sequence the way the chat store does, so later replies follow it.
    let (sequence,): (i64,) = query_as(
        "UPDATE cloud_chat_conversations SET next_message_sequence = next_message_sequence + 1, \
         latest_message_sequence = next_message_sequence WHERE conversation_id = $1 \
         RETURNING latest_message_sequence",
    )
    .bind(conversation)
    .fetch_one(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_messages (message_id, conversation_id, conversation_sequence, \
         sender_account_id, client_message_id, request_fingerprint, content) \
         VALUES ($1, $2, $3, $4, $5, 'test', $6)",
    )
    .bind(id)
    .bind(conversation)
    .bind(sequence)
    .bind(sender)
    .bind(Uuid::new_v4())
    .bind(json!({"blocks": [{"type": "text", "text": body}]}))
    .execute(pool)
    .await
    .unwrap();
    id.to_string()
}

fn claim_body(owner: &str, requester: &str, session: &str, request: &str) -> Value {
    json!({
        "requestMessageId": request, "sessionId": session, "ownerAccountId": owner,
        "requesterAccountId": requester, "prompt": "Summarize the thread",
        "idempotencyKey": request, "claimId": Uuid::new_v4(),
    })
}

fn refused(status: u16, body: &Value) -> bool {
    status == 403
        && body["errorCode"] == AGENT_REFUSAL_CODE
        && body["message"] == AGENT_REFUSAL_MESSAGE
}

/// A running reply of `owner`'s own agent in the group, as the desktop
/// executor `claimed_by` holds it; returns its run id.
async fn own_running_run(
    pool: &PgPool,
    owner: &str,
    session: &str,
    request: &str,
    claimed_by: &str,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    query(
        "INSERT INTO cloud_agent_fallback_runs \
         (run_id, idempotency_key, request_message_id, session_id, owner_account_id, \
          requester_account_id, status, prompt, created_at, updated_at, execution_backend, \
          claimed_by, lease_expires_at) \
         VALUES ($1, $1, $2, $3, $4, $4, 'running', 'hello', $5, $5, 'desktop', $6, $7)",
    )
    .bind(&run_id)
    .bind(request)
    .bind(session)
    .bind(owner)
    .bind(now.to_rfc3339())
    .bind(claimed_by)
    .bind((now + chrono::Duration::minutes(5)).to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
    run_id
}

#[tokio::test]
async fn the_default_agent_is_open_until_its_owner_makes_it_private() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "access_owner").await;
    let (riya, riya_token) = signed_in(&pool, "access_member").await;
    let (sam, sam_token) = signed_in(&pool, "access_other").await;
    befriend(&pool, &mina, &riya).await;
    befriend(&pool, &mina, &sam).await;
    let members = [mina.as_str(), riya.as_str(), sam.as_str()];
    let session = group(&pool, &members).await;
    let direct = crate::auth::routes::direct_person_session_id(&mina, &riya);
    conversation(&pool, "direct", &direct, &[&mina, &riya]).await;

    // No stored setting: open to people in the owner's chats.
    let (status, body) = send(
        &app,
        "GET",
        &access_path(&default_id(&mina)),
        &mina_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body,
        json!({"agentId": default_id(&mina), "accessScope": "participant_conversations"})
    );
    // Only the owner reads or writes it.
    let (status, _) = send(
        &app,
        "GET",
        &access_path(&default_id(&mina)),
        &riya_token,
        None,
    )
    .await;
    assert_eq!(status, 404);
    let private = json!({"accessScope": "private"});
    let (status, _) = send(
        &app,
        "PUT",
        &access_path(&default_id(&mina)),
        &riya_token,
        Some(private.clone()),
    )
    .await;
    assert_eq!(status, 404);
    let (status, _) = send(
        &app,
        "PUT",
        &access_path(&default_id(&mina)),
        &mina_token,
        Some(json!({"accessScope": "public"})),
    )
    .await;
    assert_eq!(status, 400);

    // Riya's group @mention of Mina's default agent is admitted.
    let request = mention(&pool, &session, &riya, &mina, &members).await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &riya_token,
        Some(claim_body(&mina, &riya, &session, &request)),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let admitted = body["runId"].as_str().expect("a run").to_string();
    let waiting = insert_run(&pool, &mina, &riya, "running", &direct).await;
    let own = insert_run(&pool, &mina, &mina, "queued", &session).await;

    // "Only me" ends Riya's waiting and running requests with the generic reply.
    let (status, body) = send(
        &app,
        "PUT",
        &access_path(&default_id(&mina)),
        &mina_token,
        Some(private),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["accessScope"], "private");
    let (_, body) = send(
        &app,
        "GET",
        &access_path(&default_id(&mina)),
        &mina_token,
        None,
    )
    .await;
    assert_eq!(body["accessScope"], "private");
    assert_eq!(
        run_state(&pool, &admitted).await,
        ("cancelled".into(), true)
    );
    assert_eq!(run_state(&pool, &waiting).await, ("cancelled".into(), true));
    assert_eq!(
        run_state(&pool, &own).await,
        ("queued".into(), false),
        "the owner's own run stays"
    );
    let (reply,): (Option<String>,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&admitted)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(reply.is_some(), "the refusal reply is published");

    // A new group @mention and a direct agent chat are refused with the generic 403.
    let request = mention(&pool, &session, &riya, &mina, &members).await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &riya_token,
        Some(claim_body(&mina, &riya, &session, &request)),
    )
    .await;
    assert!(refused(status, &body), "{status} {body}");
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &riya_token,
        Some(claim_body(
            &mina,
            &riya,
            &direct,
            &Uuid::new_v4().to_string(),
        )),
    )
    .await;
    assert!(refused(status, &body), "{status} {body}");
    // Mina's Mac gets the same refusal for Riya's request and posts nothing.
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/desktop/claim",
        &mina_token,
        Some(claim_body(&mina, &riya, &session, &request)),
    )
    .await;
    assert!(refused(status, &body), "{status} {body}");
    // Every claim path admits runs through one function, which refuses too.
    let input = claim(&mina, &sam, &session);
    assert!(matches!(
        claim_run_for_person_message(&pool, &input, None).await,
        Err(RunError::AgentUnavailable)
    ));
    assert!(!requester_may_use_owner_agents(&pool, &input).await.unwrap());

    // The owner is never refused.
    let own_request = mention(&pool, &session, &mina, &mina, &members).await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &mina_token,
        Some(claim_body(&mina, &mina, &session, &own_request)),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    // Sam's agent stays open to Mina: Access is per agent and per owner.
    let request = mention(&pool, &session, &mina, &sam, &members).await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &mina_token,
        Some(claim_body(&sam, &mina, &session, &request)),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let _ = sam_token;
}

#[tokio::test]
async fn a_private_default_agent_leaves_the_reach_out_directory() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "access_dir_owner").await;
    let (riya, riya_token) = signed_in(&pool, "access_dir_member").await;
    befriend(&pool, &mina, &riya).await;
    let members = [mina.as_str(), riya.as_str()];
    let session = group(&pool, &members).await;
    // Riya's own agent is running Riya's request and looks for agents to ask.
    let request = mention(&pool, &session, &riya, &riya, &members).await;
    let claim_id = Uuid::new_v4();
    let executor = format!("desktop:dev_{riya}:{claim_id}");
    let run = own_running_run(&pool, &riya, &session, &request, &executor).await;
    let capabilities = || async {
        let (status, body) = send(
            &app,
            "POST",
            &format!("/v1/cloud/agent-runs/desktop/{run}/agent-exchange"),
            &riya_token,
            Some(json!({"action": "capabilities", "claimId": claim_id})),
        )
        .await;
        assert_eq!(status, 200, "{body}");
        body["targets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|target| target["agentId"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    };
    assert!(capabilities().await.contains(&default_id(&mina)));

    let private = json!({"accessScope": "private"});
    let (status, _) = send(
        &app,
        "PUT",
        &access_path(&default_id(&mina)),
        &mina_token,
        Some(private),
    )
    .await;
    assert_eq!(status, 200);
    assert!(!capabilities().await.contains(&default_id(&mina)));
    // An exchange run already sent to Mina's agent is no longer authorized.
    assert!(
        !crate::agent_access::agent_usable(&pool, &mina, &riya, &default_id(&mina))
            .await
            .unwrap()
    );
    assert!(
        crate::agent_access::agent_usable(&pool, &mina, &mina, &default_id(&mina))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn the_per_person_switch_still_refuses_with_access_open() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "access_switch_owner").await;
    let (riya, riya_token) = signed_in(&pool, "access_switch_member").await;
    let (sam, sam_token) = signed_in(&pool, "access_switch_other").await;
    befriend(&pool, &mina, &riya).await;
    befriend(&pool, &mina, &sam).await;
    let members = [mina.as_str(), riya.as_str(), sam.as_str()];
    let session = group(&pool, &members).await;
    let open = json!({"accessScope": "participant_conversations"});
    let (status, _) = send(
        &app,
        "PUT",
        &access_path(&default_id(&mina)),
        &mina_token,
        Some(open),
    )
    .await;
    assert_eq!(status, 200);
    let off = json!({"agentAccess": false});
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/v1/cloud/contacts/{riya}/permissions"),
        &mina_token,
        Some(off),
    )
    .await;
    assert_eq!(status, 200);

    let request = mention(&pool, &session, &riya, &mina, &members).await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &riya_token,
        Some(claim_body(&mina, &riya, &session, &request)),
    )
    .await;
    assert!(refused(status, &body), "{status} {body}");
    let request = mention(&pool, &session, &sam, &mina, &members).await;
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agent-runs/claim",
        &sam_token,
        Some(claim_body(&mina, &sam, &session, &request)),
    )
    .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn making_a_factory_agent_private_ends_other_peoples_requests() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (mina, mina_token) = signed_in(&pool, "access_factory_owner").await;
    let (riya, _) = signed_in(&pool, "access_factory_member").await;
    befriend(&pool, &mina, &riya).await;
    let session = group(&pool, &[&mina, &riya]).await;
    let body = json!({
        "name": "Scout", "role": "Research helper", "systemPrompt": "Help with research.",
        "accessScope": "participant_conversations",
    });
    let (status, body) = send(&app, "POST", "/v1/cloud/agents", &mina_token, Some(body)).await;
    assert!(status == 200 || status == 201, "{status} {body}");
    let agent = body["agent"]["agentId"].as_str().unwrap().to_string();
    let (_, body) = send(&app, "GET", &access_path(&agent), &mina_token, None).await;
    assert_eq!(body["accessScope"], "participant_conversations");

    let theirs = insert_run(&pool, &mina, &riya, "queued", &session).await;
    query("UPDATE cloud_agent_fallback_runs SET execution_agent_id = $2 WHERE run_id = $1")
        .bind(&theirs)
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    let default_run = insert_run(&pool, &mina, &riya, "queued", "session:access").await;
    assert!(
        crate::agent_access::agent_usable(&pool, &mina, &riya, &agent)
            .await
            .unwrap()
    );

    let private = json!({"accessScope": "private"});
    let (status, body) = send(
        &app,
        "PUT",
        &access_path(&agent),
        &mina_token,
        Some(private),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["accessScope"], "private");
    assert_eq!(run_state(&pool, &theirs).await, ("cancelled".into(), true));
    assert_eq!(
        run_state(&pool, &default_run).await,
        ("queued".into(), false),
        "the default agent keeps its own Access"
    );
    assert!(
        !crate::agent_access::agent_usable(&pool, &mina, &riya, &agent)
            .await
            .unwrap()
    );
    assert!(
        crate::agent_access::agent_usable(&pool, &mina, &riya, &default_id(&mina))
            .await
            .unwrap()
    );
}
