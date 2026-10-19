//! Database tests for how a created document reaches the group (issue 1808):
//! the Mac's completed reply carries it, a background task's follow-up reply
//! carries the task's document, and a document no reply took is posted by the
//! agent as a fallback.

use axum::http::StatusCode;
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::agents_create_fixture::*;
use super::agents_fixture::*;
use super::db_fixture::*;
use crate::document_shares::agents::create::fallback::post_unattached;

async fn owner_device(f: &Fixture) -> String {
    let (device,): (String,) =
        query_as("SELECT device_id FROM cloud_devices WHERE account_id = $1")
            .bind(&f.owner)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    device
}

/// The Mac's reply envelope for `request_id`.
fn mac_reply(f: &Fixture, session_id: &str, request_id: &str, state: &str, text: &str) -> String {
    encode_group(&json!({
        "kind": "group-message",
        "groupId": session_id,
        "createdByAccountId": f.owner,
        "actor": { "accountId": f.owner, "displayName": "owner", "role": "person" },
        "participants": participants(f),
        "message": {
            "id": format!("msg:cloud-agent:{}", Uuid::new_v4()),
            "senderAccountId": f.owner,
            "senderAgentId": format!("cloud-agent:{}", f.owner),
            "senderKind": "agent",
            "text": text,
            "createdAtMs": 2,
            "deliveryState": state,
            "replyToMessageId": request_id,
            "requestId": request_id
        }
    }))
}

#[tokio::test]
async fn the_macs_completed_reply_carries_the_runs_document() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let claim = Uuid::new_v4();
    let executor = format!("desktop:{}:{claim}", owner_device(&f).await);
    let run_id = desktop_run(&f, &session_id, &request_id, &executor, None).await;

    let (status, created) = desktop_call(
        &f,
        &state,
        &executor,
        &run_id,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let attachment_id = attachment_of(&created);
    assert!(messages_with(&f, &attachment_id).await.is_empty());

    // A processing update does not take it; the completed reply does.
    let uri = format!("/v1/cloud/agent-runs/desktop/{run_id}/progress");
    let processing = json!({ "claimId": claim, "clientMessageId": Uuid::new_v4(),
        "body": mac_reply(&f, &session_id, &request_id, "processing", "") });
    let (status, body) = send(&f.app, "POST", &uri, Some(&f.owner_token), Some(processing)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!attached(&f, &attachment_id).await);
    let complete = json!({ "claimId": claim, "clientMessageId": Uuid::new_v4(),
        "body": mac_reply(&f, &session_id, &request_id, "complete", "The plan is ready.") });
    let (status, body) = send(&f.app, "POST", &uri, Some(&f.owner_token), Some(complete)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let envelope = assert_carried_by_agent(&f, &attachment_id).await;
    assert_eq!(envelope["message"]["text"], "The plan is ready.");
    // The Mac is answered with the stored reply, documents included, since
    // it renders the reply from this answer (issue 1906).
    let answered = decode_group(&json!({ "blocks": [{ "text": body["body"] }] }));
    assert_eq!(
        answered["message"]["attachments"][0]["attachmentId"],
        attachment_id
    );
    assert_eq!(body["attachments"][0]["attachmentId"], attachment_id);
}

#[tokio::test]
async fn a_background_tasks_document_rides_the_follow_up_reply() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let executor = format!("desktop:{}", Uuid::new_v4());
    // The parent run already answered; its background task holds the claim.
    let parent = desktop_run(&f, &session_id, &request_id, &executor, Some(1)).await;
    let (status, created) = desktop_call(
        &f,
        &state,
        &executor,
        &parent,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let attachment_id = attachment_of(&created);
    assert!(messages_with(&f, &attachment_id).await.is_empty());

    // An ordinary agent reply does not take it; the follow-up reply does.
    let reply = |request: &str, text: &str| {
        json!({ "id": format!("msg:cloud-agent:{}", Uuid::new_v4()), "senderAccountId": f.owner,
                "senderAgentId": format!("cloud-agent:{}", f.owner), "senderKind": "agent",
                "text": text, "createdAtMs": 3, "deliveryState": "complete",
                "replyToMessageId": request_id, "requestId": request })
    };
    send_group(
        &f,
        conversation,
        &session_id,
        &f.owner,
        reply(&request_id, "Working on it."),
    )
    .await
    .unwrap();
    assert!(!attached(&f, &attachment_id).await);
    let follow_up = "background-result:session-child:completed";
    send_group(
        &f,
        conversation,
        &session_id,
        &f.owner,
        reply(follow_up, "The research is done."),
    )
    .await
    .unwrap();
    let envelope = assert_carried_by_agent(&f, &attachment_id).await;
    assert_eq!(envelope["message"]["requestId"], follow_up);

    // Another claim, an expired window, and any other tool are refused.
    let (status, _) = desktop_call(
        &f,
        &state,
        "desktop:other",
        &parent,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let stale = desktop_run(&f, &session_id, "msg_stale", &executor, Some(13)).await;
    let (status, _) = desktop_call(
        &f,
        &state,
        &executor,
        &stale,
        "create_document",
        plan_args(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) =
        desktop_call(&f, &state, &executor, &parent, "read_document", json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_document_no_reply_took_is_posted_by_the_agent() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let run_id = chat_run(&f, &session_id, &f.owner, &request_id).await;
    let (runner, _) = lease(&f, &state, &run_id).await;
    let (_, created) = call_tool(&state, &runner, &run_id, "create_document", plan_args()).await;
    let attachment_id = attachment_of(&created);
    crate::cloud_agent_runtime::runs::fail_run(
        &f.pool,
        &run_id,
        &runner,
        "provider_error",
        "x",
        None,
    )
    .await
    .unwrap();

    // Within the grace period nothing is posted.
    post_unattached(&f.pool).await.unwrap();
    assert!(messages_with(&f, &attachment_id).await.is_empty());

    query("UPDATE cloud_agent_fallback_runs SET completed_at = $2 WHERE run_id = $1")
        .bind(&run_id)
        .bind((chrono::Utc::now() - chrono::Duration::minutes(5)).to_rfc3339())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(post_unattached(&f.pool).await.unwrap() >= 1);
    let envelope = assert_carried_by_agent(&f, &attachment_id).await;
    // From the agent, answering no request, so no client takes it for a reply.
    assert!(envelope["message"].get("requestId").is_none());
    assert_eq!(envelope["message"]["deliveryState"], "complete");

    // A second sweep posts nothing more.
    post_unattached(&f.pool).await.unwrap();
    assert_eq!(messages_with(&f, &attachment_id).await.len(), 1);
}
