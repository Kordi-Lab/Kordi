//! Database tests for `create_document` (issue 1808): the document lands in
//! the group's Artifacts for every member, the gate and membership rules
//! hold, and a background task of a finished desktop run still delivers to
//! the run's group.

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::agents_fixture::*;
use super::db_fixture::*;
use crate::chat_sync::models::SendMessageRequest;
use crate::connectors::delivery::LeaseHolder;
use crate::connectors::models::BrokerCallRequest;
use crate::document_shares::agents::{tools, DOCUMENT_CONNECTOR_ID};

const PLAN: &str = "# Launch plan\n\nShip on Friday.\n";

async fn group(f: &Fixture) -> (Uuid, String) {
    query_as(
        "SELECT conversation.conversation_id, conversation.legacy_session_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_messages message ON message.conversation_id = conversation.conversation_id \
         JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
         WHERE link.attachment_id = $1",
    )
    .bind(&f.attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

/// The member's request, a group message like the clients send.
async fn send_request(f: &Fixture, conversation: Uuid, session_id: &str) {
    let envelope = json!({
        "kind": "group-message",
        "groupId": session_id,
        "createdByAccountId": f.owner,
        "actor": { "accountId": f.member, "displayName": "member", "role": "person" },
        "participants": [
            { "accountId": f.owner, "displayName": "owner", "role": "person" },
            { "accountId": f.member, "displayName": "member", "role": "person" }
        ],
        "message": { "id": format!("msg_{}", Uuid::new_v4().simple()), "senderAccountId": f.member,
                     "text": "@Kordi create a launch plan doc", "createdAtMs": 1, "senderKind": "human" }
    });
    let body = format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    );
    crate::chat_sync::store::send_message(
        &f.pool,
        &f.member,
        conversation,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".into(),
            content: json!({ "schema": 1, "blocks": [{ "type": "text", "text": body }] }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap();
}

/// A queued chat run of the owner's agent that `requester` asked for.
async fn chat_run(f: &Fixture, session_id: &str, requester: &str) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let trigger = if requester == f.owner {
        "person_started"
    } else {
        "background"
    };
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, run_trigger) VALUES ($1, $1, $2, $3, $4, $5, 'queued', 'Hello', $6, $6, $7)",
    )
    .bind(&run_id)
    .bind(format!("msg_{run_id}"))
    .bind(session_id)
    .bind(&f.owner)
    .bind(requester)
    .bind(now)
    .bind(trigger)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

fn plan_args() -> Value {
    json!({ "title": "Launch plan", "content": PLAN })
}

/// Messages of the conversation that carry `attachment_id`, with their
/// sender and decoded group envelope.
async fn messages_with(f: &Fixture, attachment_id: &str) -> Vec<(String, Value, Value)> {
    let rows: Vec<(String, Value)> = query_as(
        "SELECT message.sender_account_id, message.content FROM cloud_chat_messages message \
         JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
         WHERE link.attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(sender, content)| {
            let body = content["blocks"][0]["text"].as_str().unwrap().to_string();
            let encoded = body.strip_prefix("kordi-cloud-group:").unwrap();
            let envelope =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
            (sender, content, envelope)
        })
        .collect()
}

#[tokio::test]
async fn a_member_asks_and_the_document_lands_in_the_group_artifacts() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    send_request(&f, conversation, &session_id).await;
    let run_id = chat_run(&f, &session_id, &f.member).await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document", "create_document"]);

    let (status, created) =
        call_tool(&state, &runner, &run_id, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let result = created.result.unwrap();
    let attachment_id = result["attachmentId"].as_str().unwrap().to_string();
    assert_eq!(result["fileName"], "Launch plan.md");
    assert_eq!(result["format"], "markdown");

    // Uploaded under the owner, finalized, Markdown, with its title.
    let (owner, content_type, size, title): (String, String, i64, Option<String>) = query_as(
        "SELECT owner_account_id, content_type, size_bytes, document_title FROM cloud_attachments \
         WHERE attachment_id = $1 AND finalized_at IS NOT NULL",
    )
    .bind(&attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        (
            owner.as_str(),
            content_type.as_str(),
            size,
            title.as_deref()
        ),
        (
            f.owner.as_str(),
            "text/markdown",
            PLAN.len() as i64,
            Some("Launch plan")
        )
    );

    // Posted once in the group as the agent's message, carrying the document.
    let messages = messages_with(&f, &attachment_id).await;
    assert_eq!(messages.len(), 1);
    let (sender, content, envelope) = &messages[0];
    assert_eq!(sender, &f.owner);
    assert_eq!(
        content["legacy_attachments"][0]["attachmentId"],
        attachment_id.as_str()
    );
    assert_eq!(content["legacy_attachments"][0]["name"], "Launch plan.md");
    assert_eq!(envelope["message"]["senderKind"], "agent");
    assert_eq!(
        envelope["message"]["attachments"][0]["mimeType"],
        "text/markdown"
    );
    assert_eq!(envelope["participants"].as_array().unwrap().len(), 2);

    // Listed in the session's Artifacts and readable by the member, not by an outsider.
    let uri = format!("/v1/cloud/session-activity?sessionId={session_id}");
    let (status, activity) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{activity}");
    let listed = activity["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["attachmentId"] == attachment_id.as_str())
        .unwrap_or_else(|| panic!("artifact listed in {activity}"));
    assert_eq!(listed["name"], "Launch plan.md");
    assert!(!listed.to_string().contains("/Users/"));
    let document_uri = format!("/v1/cloud/documents/{attachment_id}");
    let (status, document) = send(&f.app, "GET", &document_uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    assert_eq!(document["viewer"], "member");
    assert_eq!(document["fileName"], "Launch plan.md");
    let (status, _) = send(&f.app, "GET", &document_uri, Some(&f.outsider_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A retry of the same call finds the first document.
    let (status, again) = call_tool(&state, &runner, &run_id, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::OK, "{again:?}");
    assert_eq!(
        again.result.unwrap()["attachmentId"],
        attachment_id.as_str()
    );
    assert_eq!(messages_with(&f, &attachment_id).await.len(), 1);
}

#[tokio::test]
async fn create_document_follows_the_gate_and_group_membership() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    send_request(&f, conversation, &session_id).await;

    // Not a group: no create tool, and a direct call is refused.
    let private = chat_run(
        &f,
        &format!("session:self-agent:{}", Uuid::new_v4().simple()),
        &f.owner,
    )
    .await;
    let (runner, tools) = lease(&f, &state, &private).await;
    assert!(tools.is_empty(), "{tools:?}");
    let (status, refused) =
        call_tool(&state, &runner, &private, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused:?}");

    // A comment run answers in its thread and never creates group documents.
    let mention = post_comment(&f, &f.owner_token, "b1", "@Kordi summarize").await;
    let (comment_run, ..) = only_run(&f, &mention).await;
    let (_, tools) = lease(&f, &state, &comment_run).await;
    assert!(!tool_names(&tools).contains(&"create_document"));

    // The owner's own request gets the tool; bad arguments are refused.
    let run_id = chat_run(&f, &session_id, &f.owner).await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert!(tool_names(&tools).contains(&"create_document"));
    let docx = json!({ "title": "Plan", "content": "x", "format": "docx" });
    let (status, refused) = call_tool(&state, &runner, &run_id, "create_document", docx).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused:?}");

    // A requester who left the group can no longer receive its documents.
    let member_run = chat_run(&f, &session_id, &f.member).await;
    let (runner, _) = lease(&f, &state, &member_run).await;
    query(
        "UPDATE cloud_chat_conversation_members SET membership_state = 'left' \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation)
    .bind(&f.member)
    .execute(&f.pool)
    .await
    .unwrap();
    let (status, refused) =
        call_tool(&state, &runner, &member_run, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{refused:?}");
    assert_eq!(refused.error_code(), Some("document_tool_forbidden"));
}

async fn finished_desktop_run(
    f: &Fixture,
    session_id: &str,
    executor: &str,
    hours_ago: i64,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let completed = (Utc::now() - chrono::Duration::hours(hours_ago)).to_rfc3339();
    let tools = serde_json::to_value(vec![tools::create_descriptor()]).unwrap();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, completed_at, run_trigger, execution_backend, claimed_by, \
         connector_tools_json, connector_tools_delivered_at) \
         VALUES ($1, $1, $2, $3, $4, $4, 'completed', 'Hello', $5, $5, $5, 'person_started', \
                 'desktop', $6, $7, now())",
    )
    .bind(&run_id)
    .bind(format!("msg_{run_id}"))
    .bind(session_id)
    .bind(&f.owner)
    .bind(completed)
    .bind(executor)
    .bind(tools)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

async fn desktop_call(
    f: &Fixture,
    state: &crate::server::ServerState,
    executor: &str,
    run_id: &str,
    tool: &str,
) -> (StatusCode, crate::connectors::models::BrokerCallResponse) {
    let request: BrokerCallRequest = serde_json::from_value(json!({
        "leaseId": run_id,
        "claimId": Uuid::new_v4(),
        "connectorId": DOCUMENT_CONNECTOR_ID,
        "tool": tool,
        "args": plan_args(),
    }))
    .unwrap();
    let holder = LeaseHolder::Desktop {
        account_id: f.owner.clone(),
        executor: executor.to_string(),
    };
    tools::call(state, &holder, &request).await
}

#[tokio::test]
async fn a_background_task_of_a_finished_desktop_run_delivers_to_the_parent_group() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    send_request(&f, conversation, &session_id).await;
    let executor = format!("desktop:{}", Uuid::new_v4());

    // The parent run already answered; its child still holds the claim.
    let parent = finished_desktop_run(&f, &session_id, &executor, 1).await;
    let (status, created) = desktop_call(&f, &state, &executor, &parent, "create_document").await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let attachment_id = created.result.unwrap()["attachmentId"]
        .as_str()
        .unwrap()
        .to_string();
    let messages = messages_with(&f, &attachment_id).await;
    assert_eq!(messages.len(), 1);
    let (session,): (String,) = query_as(
        "SELECT conversation.legacy_session_id FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_messages message ON message.conversation_id = conversation.conversation_id \
         JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
         WHERE link.attachment_id = $1",
    )
    .bind(&attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(session, session_id);

    // Another claim, an expired window, and any other tool are refused.
    let (status, _) = desktop_call(&f, &state, "desktop:other", &parent, "create_document").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let stale = finished_desktop_run(&f, &session_id, &executor, 13).await;
    let (status, refused) = desktop_call(&f, &state, &executor, &stale, "create_document").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("lease_invalid"));
    let (status, _) = desktop_call(&f, &state, &executor, &parent, "read_document").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
