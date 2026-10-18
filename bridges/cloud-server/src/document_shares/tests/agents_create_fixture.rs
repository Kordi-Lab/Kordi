//! Helpers for the `create_document` database tests (issue 1808).

use axum::http::StatusCode;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::*;
use crate::chat_sync::models::SendMessageRequest;
use crate::connectors::delivery::LeaseHolder;
use crate::connectors::models::{BrokerCallRequest, BrokerCallResponse};
use crate::document_shares::agents::{tools, DOCUMENT_CONNECTOR_ID};
use crate::server::ServerState;

pub(super) const PLAN: &str = "# Launch plan\n\nShip on Friday.\n";

pub(super) fn plan_args() -> Value {
    json!({ "title": "Launch plan", "content": PLAN })
}

/// The fixture's group, under a real group session id.
pub(super) async fn group(f: &Fixture) -> (Uuid, String) {
    query(
        "UPDATE cloud_chat_conversations SET legacy_session_id = 'session:group:' || conversation_id \
         WHERE conversation_id = (SELECT message.conversation_id FROM cloud_chat_messages message \
           JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
           WHERE link.attachment_id = $1)",
    )
    .bind(&f.attachment_id)
    .execute(&f.pool)
    .await
    .unwrap();
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

pub(super) fn participants(f: &Fixture) -> Value {
    json!([
        { "accountId": f.owner, "displayName": "owner", "role": "person" },
        { "accountId": f.member, "displayName": "member", "role": "person" }
    ])
}

pub(super) fn encode_group(envelope: &Value) -> String {
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(envelope).unwrap())
    )
}

pub(super) fn decode_group(content: &Value) -> Value {
    let body = content["blocks"][0]["text"].as_str().unwrap();
    let encoded = body.strip_prefix("kordi-cloud-group:").unwrap();
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}

/// Sends a group message as `sender`; `message` is the envelope's message.
pub(super) async fn send_group(
    f: &Fixture,
    conversation: Uuid,
    session_id: &str,
    sender: &str,
    message: Value,
) -> Result<(), crate::chat_sync::store::StoreError> {
    let envelope = json!({
        "kind": "group-message",
        "groupId": session_id,
        "createdByAccountId": f.owner,
        "actor": { "accountId": sender, "displayName": "sender", "role": "person" },
        "participants": participants(f),
        "message": message,
    });
    crate::chat_sync::store::send_message(
        &f.pool,
        sender,
        conversation,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".into(),
            content: json!({ "schema": 1, "blocks": [{ "type": "text", "text": encode_group(&envelope) }] }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .map(|_| ())
}

/// The member's request, a group message like the clients send; returns its id.
pub(super) async fn send_request(f: &Fixture, conversation: Uuid, session_id: &str) -> String {
    let id = format!("msg_{}", Uuid::new_v4().simple());
    let message = json!({ "id": id, "senderAccountId": f.member, "senderKind": "human",
                          "text": "@Kordi create a launch plan doc", "createdAtMs": 1 });
    send_group(f, conversation, session_id, &f.member, message)
        .await
        .unwrap();
    id
}

/// A run of the owner's agent that `requester` asked for with `request_id`.
pub(super) async fn chat_run(
    f: &Fixture,
    session_id: &str,
    requester: &str,
    request_id: &str,
) -> String {
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
    .bind(request_id)
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

/// A run the owner's Mac holds under `claim`, running, or answered `hours_ago`.
pub(super) async fn desktop_run(
    f: &Fixture,
    session_id: &str,
    request_id: &str,
    executor: &str,
    answered_hours_ago: Option<i64>,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now();
    let tools = serde_json::to_value(vec![tools::create_descriptor()]).unwrap();
    let (status, completed) = match answered_hours_ago {
        Some(hours) => (
            "completed",
            Some((now - chrono::Duration::hours(hours)).to_rfc3339()),
        ),
        None => ("running", None),
    };
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, completed_at, run_trigger, execution_backend, claimed_by, lease_expires_at, \
         connector_tools_json, connector_tools_delivered_at) \
         VALUES ($1, $1, $2, $3, $4, $4, $5, 'Hello', $6, $6, $7, 'person_started', 'desktop', \
                 $8, $9, $10, now())",
    )
    .bind(&run_id)
    .bind(request_id)
    .bind(session_id)
    .bind(&f.owner)
    .bind(status)
    .bind(now.to_rfc3339())
    .bind(completed)
    .bind(executor)
    .bind((now + chrono::Duration::minutes(5)).to_rfc3339())
    .bind(tools)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

pub(super) async fn desktop_call(
    f: &Fixture,
    state: &ServerState,
    executor: &str,
    run_id: &str,
    tool: &str,
    args: Value,
) -> (StatusCode, BrokerCallResponse) {
    let request: BrokerCallRequest = serde_json::from_value(json!({
        "leaseId": run_id,
        "claimId": Uuid::new_v4(),
        "connectorId": DOCUMENT_CONNECTOR_ID,
        "tool": tool,
        "args": args,
    }))
    .unwrap();
    let holder = LeaseHolder::Desktop {
        account_id: f.owner.clone(),
        executor: executor.to_string(),
    };
    tools::call(state, &holder, &request).await
}

/// `(sender, content)` of every message that carries `attachment_id`.
pub(super) async fn messages_with(f: &Fixture, attachment_id: &str) -> Vec<(String, Value)> {
    query_as(
        "SELECT message.sender_account_id, message.content FROM cloud_chat_messages message \
         JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
         WHERE link.attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_all(&f.pool)
    .await
    .unwrap()
}

/// Whether a reply has taken the document.
pub(super) async fn attached(f: &Fixture, attachment_id: &str) -> bool {
    let (attached,): (bool,) = query_as(
        "SELECT attached_at IS NOT NULL FROM cloud_agent_run_documents WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    attached
}

/// Asserts the one message carrying `attachment_id` is the agent's, with the
/// document in its envelope and canonical attachments; returns its envelope.
pub(super) async fn assert_carried_by_agent(f: &Fixture, attachment_id: &str) -> Value {
    let messages = messages_with(f, attachment_id).await;
    assert_eq!(messages.len(), 1, "{messages:?}");
    let (sender, content) = &messages[0];
    assert_eq!(sender, &f.owner);
    let envelope = decode_group(content);
    assert_eq!(envelope["message"]["senderKind"], "agent", "{envelope}");
    assert_eq!(
        envelope["message"]["senderAgentId"],
        format!("cloud-agent:{}", f.owner)
    );
    let in_envelope = envelope["message"]["attachments"].as_array().unwrap();
    assert!(in_envelope
        .iter()
        .any(|item| item["attachmentId"] == attachment_id));
    let legacy = content["legacy_attachments"].as_array().unwrap();
    assert!(legacy
        .iter()
        .any(|item| item["attachmentId"] == attachment_id && item["name"] == "launch-plan.md"));
    assert!(attached(f, attachment_id).await);
    envelope
}

pub(super) fn attachment_of(response: &BrokerCallResponse) -> String {
    response.result.as_ref().unwrap()["attachmentId"]
        .as_str()
        .unwrap()
        .to_string()
}
