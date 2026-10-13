//! Database tests for the routing of comment runs: the agent owner's ready
//! Mac first, the cloud runner otherwise, and never both.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::agents_fixture::*;
use super::db_fixture::*;
use crate::cloud_agent_runtime::runs::lease_canary_run;

const CLAIM: &str = "/v1/cloud/agent-runs/desktop/claim";

/// Marks the account's device as an online Mac that is ready for `agent`.
async fn ready_mac(f: &Fixture, account: &str, agent: &str) -> String {
    let (device,): (String,) =
        query_as("SELECT device_id FROM cloud_devices WHERE account_id = $1")
            .bind(account)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    query("UPDATE cloud_devices SET device_platform = 'macos' WHERE device_id = $1")
        .bind(&device)
        .execute(&f.pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_agent_desktop_capabilities (device_id, agent_id) VALUES ($1, $2)")
        .bind(&device)
        .bind(agent)
        .execute(&f.pool)
        .await
        .unwrap();
    query(
        "INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, \
         updated_at) VALUES ($1, $2, 'online', $3, $3)",
    )
    .bind(&device)
    .bind(account)
    .bind(Utc::now().to_rfc3339())
    .execute(&f.pool)
    .await
    .unwrap();
    device
}

async fn agent_requests(f: &Fixture, account: &str) -> Vec<Value> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'document.agent_request' ORDER BY stream_seq",
    )
    .bind(account)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    rows.into_iter().map(|(payload,)| payload).collect()
}

/// `(status, execution_backend, waits for a desktop)` of a run.
async fn run_state(f: &Fixture, run_id: &str) -> (String, String, bool) {
    query_as(
        "SELECT status, execution_backend, COALESCE(desktop_preferred_until > now(), FALSE) \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

fn claim_body(request: &Value, owner: &str, claim_id: Uuid) -> Value {
    json!({
        "requestMessageId": request["runRequestId"],
        "sessionId": request["sessionId"],
        "ownerAccountId": owner,
        "requesterAccountId": request["requesterAccountId"],
        "prompt": request["prompt"],
        "idempotencyKey": format!("{}:{}", request["runRequestId"], request["agentId"]),
        "claimId": claim_id,
    })
}

fn response_body(request_id: &str, text: &str, state: &str) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let envelope = json!({
        "kind": "agent-response", "requestId": request_id, "text": text, "deliveryState": state,
    });
    format!(
        "kordi-cloud-agent-response:{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

async fn progress(
    f: &Fixture,
    token: &str,
    run_id: &str,
    claim_id: Uuid,
    body: String,
) -> (StatusCode, Value) {
    let uri = format!("/v1/cloud/agent-runs/desktop/{run_id}/progress");
    let input = json!({ "claimId": claim_id, "body": body, "clientMessageId": Uuid::new_v4() });
    send(&f.app, "POST", &uri, Some(token), Some(input)).await
}

async fn chat_messages(f: &Fixture) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_chat_messages WHERE sender_account_id = ANY($1)",
    )
    .bind(vec![f.owner.clone(), f.member.clone()])
    .fetch_one(&f.pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn a_ready_mac_gets_the_run_and_the_cloud_waits_for_the_timeout() {
    let Some(f) = fixture().await else { return };
    let agent = format!("cloud-agent:{}", f.member);
    ready_mac(&f, &f.member, &agent).await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Kordi can you tighten this?").await;
    assert_eq!(mention["agentRun"]["status"], "queued", "{mention}");
    let comment_id = mention["commentId"].as_str().unwrap();
    let (run_id, ..) = only_run(&f, &mention).await;
    assert_eq!(
        run_state(&f, &run_id).await,
        ("queued".into(), "cloud".into(), true)
    );

    // The owner's devices are told; nobody else is.
    let requests = agent_requests(&f, &f.member).await;
    assert_eq!(requests.len(), 1, "{requests:?}");
    let request = &requests[0];
    assert_eq!(request["runRequestId"], format!("doccmt:{comment_id}"));
    assert_eq!(request["commentId"], comment_id);
    assert_eq!(request["attachmentId"], f.attachment_id.as_str());
    assert_eq!(request["requesterAccountId"], f.member.as_str());
    assert_eq!(request["agentId"], agent.as_str());
    let prompt = request["prompt"].as_str().unwrap();
    assert!(prompt.contains("answering a comment thread"), "{prompt}");
    assert!(prompt.ends_with("@Kordi can you tighten this?"), "{prompt}");
    assert!(agent_requests(&f, &f.owner).await.is_empty());

    // While the preference holds, the cloud runner does not get the run.
    let runner = format!("runner-doc-{}", Uuid::new_v4().simple());
    assert!(lease_canary_run(&f.pool, &runner, &run_id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(run_state(&f, &run_id).await.0, "queued");

    // Nobody claimed within the presence timeout: the cloud takes it.
    query(
        "UPDATE cloud_agent_fallback_runs \
         SET desktop_preferred_until = now() - interval '1 second' WHERE run_id = $1",
    )
    .bind(&run_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let leased = lease_canary_run(&f.pool, &runner, &run_id)
        .await
        .unwrap()
        .expect("the cloud leases the unclaimed run");
    assert_eq!(leased.run_id, run_id);
    assert_eq!(
        run_state(&f, &run_id).await,
        ("leased".into(), "cloud".into(), false)
    );

    // A run executes once: the Mac is too late now.
    let claim = claim_body(request, &f.member, Uuid::new_v4());
    let (status, late) = send(&f.app, "POST", CLAIM, Some(&f.member_token), Some(claim)).await;
    assert_eq!(status, StatusCode::OK, "{late}");
    assert_eq!(late["acquired"], false, "{late}");
    assert_eq!(late["runId"], run_id.as_str());
    assert_eq!(run_state(&f, &run_id).await.1, "cloud");
}

#[tokio::test]
async fn without_a_ready_mac_the_run_goes_to_the_cloud_at_once() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Kordi summarize").await;
    let (run_id, ..) = only_run(&f, &mention).await;
    assert_eq!(
        run_state(&f, &run_id).await,
        ("queued".into(), "cloud".into(), false)
    );
    assert!(agent_requests(&f, &f.member).await.is_empty());
    let (_, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document", "edit_document"]);

    // A public reader's run stays in the cloud even when the owner's Mac is
    // ready: on the Mac its requester would read as the owner.
    ready_mac(&f, &f.owner, &format!("cloud-agent:{}", f.owner)).await;
    let share = create_share(&f).await;
    let uri = format!("/v1/cloud/public/documents/{}/comments", token_of(&share));
    let body = json!({ "blockId": "b1", "body": "@Kordi what is this?",
        "readerKey": READER_KEY, "readerName": "Priya" });
    let (status, reader) = send(&f.app, "POST", &uri, None, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{reader}");
    let (reader_run, ..) = only_run(&f, &reader).await;
    assert!(!run_state(&f, &reader_run).await.2);
    assert!(agent_requests(&f, &f.owner).await.is_empty());
    let claim = json!({
        "requestMessageId": format!("doccmt:{}", reader["commentId"].as_str().unwrap()),
        "sessionId": mention_session(&f, &reader_run).await,
        "ownerAccountId": f.owner, "requesterAccountId": f.owner, "prompt": "x",
        "idempotencyKey": "reader", "claimId": Uuid::new_v4(),
    });
    let (status, refused) = send(&f.app, "POST", CLAIM, Some(&f.owner_token), Some(claim)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
}

async fn mention_session(f: &Fixture, run_id: &str) -> String {
    let (session,): (String,) =
        query_as("SELECT session_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    session
}

#[tokio::test]
async fn the_owners_mac_claims_runs_and_completes_in_the_thread() {
    let Some(f) = fixture().await else { return };
    let agent = format!("cloud-agent:{}", f.member);
    ready_mac(&f, &f.member, &agent).await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Kordi please check").await;
    let mention_id = mention["commentId"].as_str().unwrap();
    let (run_id, ..) = only_run(&f, &mention).await;
    let request = agent_requests(&f, &f.member).await.remove(0);
    let request_id = request["runRequestId"].as_str().unwrap();

    // Another account cannot claim the run, as itself or as the owner.
    let claim_id = Uuid::new_v4();
    let honest = claim_body(&request, &f.owner, claim_id);
    let (status, _) = send(&f.app, "POST", CLAIM, Some(&f.owner_token), Some(honest)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let forged = claim_body(&request, &f.member, claim_id);
    let (status, _) = send(&f.app, "POST", CLAIM, Some(&f.owner_token), Some(forged)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(run_state(&f, &run_id).await.0, "queued");
    // A comment that started no run cannot be claimed either.
    let plain = post_comment(&f, &f.member_token, "b2", "Plain note").await;
    let mut missing = claim_body(&request, &f.member, claim_id);
    missing["requestMessageId"] = json!(format!("doccmt:{}", plain["commentId"].as_str().unwrap()));
    let (status, _) = send(&f.app, "POST", CLAIM, Some(&f.member_token), Some(missing)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // The owner's Mac claims it, with the same tools a cloud lease carries.
    let claim = claim_body(&request, &f.member, claim_id);
    let (status, claimed) = send(
        &f.app,
        "POST",
        CLAIM,
        Some(&f.member_token),
        Some(claim.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["acquired"], true, "{claimed}");
    assert_eq!(claimed["runId"], run_id.as_str());
    assert_eq!(claimed["turnIdentity"]["ownerAccountId"], f.member.as_str());
    assert_eq!(
        claimed["turnIdentity"]["requesterAccountId"],
        f.member.as_str()
    );
    assert_eq!(claimed["trigger"], "person_started");
    let names: Vec<&str> = claimed["connectorTools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["read_document", "edit_document"]);
    assert_eq!(
        run_state(&f, &run_id).await,
        ("leased".into(), "desktop".into(), false)
    );
    let working = document(&f, &f.owner_token).await;
    assert_eq!(
        comment_in(&working, mention_id)["agentRun"]["status"],
        "running"
    );

    // The same claim again still holds; a second window and the cloud do not.
    let (_, again) = send(&f.app, "POST", CLAIM, Some(&f.member_token), Some(claim)).await;
    assert_eq!(again["acquired"], true, "{again}");
    let second = claim_body(&request, &f.member, Uuid::new_v4());
    let (_, second) = send(&f.app, "POST", CLAIM, Some(&f.member_token), Some(second)).await;
    assert_eq!(second["acquired"], false, "{second}");
    let runner = format!("runner-doc-{}", Uuid::new_v4().simple());
    assert!(lease_canary_run(&f.pool, &runner, &run_id)
        .await
        .unwrap()
        .is_none());

    // Progress keeps the run running and writes nothing.
    let chat_before = chat_messages(&f).await;
    let body = response_body(request_id, "", "processing");
    let (status, running) = progress(&f, &f.member_token, &run_id, claim_id, body).await;
    assert_eq!(status, StatusCode::OK, "{running}");
    assert_eq!(running["status"], "running");
    // A report from a claim that does not hold the run is refused.
    let body = response_body(request_id, "Stolen.", "complete");
    let (status, _) = progress(&f, &f.member_token, &run_id, Uuid::new_v4(), body).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let body = response_body(request_id, "  It is right.  ", "complete");
    let (status, done) = progress(&f, &f.member_token, &run_id, claim_id, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["status"], "completed");
    assert_eq!(chat_messages(&f).await, chat_before, "no chat message");
    let after = document(&f, &f.owner_token).await;
    assert_eq!(
        comment_in(&after, mention_id)["agentRun"]["status"],
        "completed"
    );
    let replies = replies_to(&after, mention_id);
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["kind"], "agent");
    assert_eq!(replies[0]["body"], "It is right.");
    assert_eq!(replies[0]["author"]["agentId"], agent.as_str());
    assert_eq!(done["commentId"], replies[0]["commentId"]);
    // A finished run takes no second answer.
    let (status, _) = progress(&f, &f.member_token, &run_id, claim_id, body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        replies_to(&document(&f, &f.owner_token).await, mention_id).len(),
        1
    );
}

#[tokio::test]
async fn a_desktop_failure_posts_the_system_reply() {
    let Some(f) = fixture().await else { return };
    let agent = format!("cloud-agent:{}", f.member);
    ready_mac(&f, &f.member, &agent).await;
    for (block, lost_lease) in [("b1", false), ("b2", true)] {
        let mention = post_comment(&f, &f.member_token, block, "@Kordi summarize").await;
        let mention_id = mention["commentId"].as_str().unwrap();
        let (run_id, ..) = only_run(&f, &mention).await;
        let request = agent_requests(&f, &f.member).await.pop().unwrap();
        let request_id = request["runRequestId"].as_str().unwrap();
        let claim_id = Uuid::new_v4();
        let claim = claim_body(&request, &f.member, claim_id);
        let (_, claimed) = send(&f.app, "POST", CLAIM, Some(&f.member_token), Some(claim)).await;
        assert_eq!(claimed["acquired"], true, "{claimed}");
        if lost_lease {
            // The turn ended after its lease lapsed: the Mac releases the run.
            query(
                "UPDATE cloud_agent_fallback_runs \
                 SET lease_expires_at = (now() - interval '1 minute')::text WHERE run_id = $1",
            )
            .bind(&run_id)
            .execute(&f.pool)
            .await
            .unwrap();
            let input = json!({ "sessionId": request["sessionId"],
                "requestMessageId": request_id, "state": "failed" });
            let uri = "/v1/cloud/agent-runs/desktop/interrupted";
            let (status, released) =
                send(&f.app, "POST", uri, Some(&f.member_token), Some(input)).await;
            assert_eq!(status, StatusCode::OK, "{released}");
            assert_eq!(released["closed"], true, "{released}");
        } else {
            let body = response_body(request_id, "Failed: boom", "failed");
            let (status, failed) = progress(&f, &f.member_token, &run_id, claim_id, body).await;
            assert_eq!(status, StatusCode::OK, "{failed}");
            assert_eq!(failed["status"], "failed");
        }
        let after = document(&f, &f.member_token).await;
        assert_eq!(
            comment_in(&after, mention_id)["agentRun"]["status"],
            "failed"
        );
        let replies = replies_to(&after, mention_id);
        assert_eq!(replies.len(), 1, "{after}");
        assert_eq!(replies[0]["kind"], "system");
        assert_eq!(replies[0]["body"], "Kordi could not answer.");
    }
}

#[tokio::test]
async fn a_shared_turn_on_the_owners_mac_reads_the_document_and_never_edits() {
    let Some(f) = fixture().await else { return };
    // The owner shares a named agent with the conversations they are in.
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_definitions (agent_id, owner_account_id, access_scope, status, \
         name, role, system_prompt, created_at, updated_at, avatar_source, avatar_style, \
         avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, 'participant_conversations', 'active', 'Copy Editor', 'editor', \
                 'Keep a formal tone.', $3, $3, 'generated', 'thumbs', $1, 'fixture', 1, $3)",
    )
    .bind(&agent_id)
    .bind(&f.owner)
    .bind(Utc::now().to_rfc3339())
    .execute(&f.pool)
    .await
    .unwrap();
    ready_mac(&f, &f.owner, &agent_id).await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Copy Editor fix the tone").await;
    let (run_id, owner, requester, ..) = only_run(&f, &mention).await;
    assert_eq!(
        (owner.as_str(), requester.as_str()),
        (f.owner.as_str(), f.member.as_str())
    );
    assert!(
        run_state(&f, &run_id).await.2,
        "the owner's Mac is preferred"
    );
    assert!(agent_requests(&f, &f.member).await.is_empty());
    let request = agent_requests(&f, &f.owner).await.remove(0);
    assert_eq!(request["requesterAccountId"], f.member.as_str());
    assert!(!request["prompt"]
        .as_str()
        .unwrap()
        .contains("Call edit_document"));

    // The requester cannot claim the run for their own Mac.
    let theirs = claim_body(&request, &f.member, Uuid::new_v4());
    let (status, _) = send(&f.app, "POST", CLAIM, Some(&f.member_token), Some(theirs)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let claim = claim_body(&request, &f.owner, Uuid::new_v4());
    let (status, claimed) = send(&f.app, "POST", CLAIM, Some(&f.owner_token), Some(claim)).await;
    assert_eq!(status, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["acquired"], true, "{claimed}");
    assert_eq!(claimed["trigger"], "background");
    assert_eq!(
        claimed["turnIdentity"]["requesterAccountId"],
        f.member.as_str()
    );
    let tools = claimed["connectorTools"].as_array().unwrap();
    assert_eq!(tools.len(), 1, "{claimed}");
    assert_eq!(tools[0]["name"], "read_document");
    assert_eq!(tools[0]["provider"], "kordi_documents");
    assert_eq!(tools[0]["group"], "read");
}
