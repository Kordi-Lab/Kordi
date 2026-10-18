//! Database tests for `create_document` (issue 1808): the document is
//! recorded against the run, carried by the agent's reply from cloud
//! completion, shown with the agent as its author, and refused without a
//! real title and content.

use axum::http::StatusCode;
use serde_json::json;
use sqlx_core::query::query;
use uuid::Uuid;

use super::agents_create_fixture::*;
use super::agents_fixture::*;
use super::db_fixture::*;

#[tokio::test]
async fn cloud_completion_attaches_the_document_to_the_agents_reply() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let run_id = chat_run(&f, &session_id, &f.member, &request_id).await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document", "create_document"]);

    let (status, created) =
        call_tool(&state, &runner, &run_id, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::OK, "{created:?}");
    let attachment_id = attachment_of(&created);
    assert_eq!(
        created.result.as_ref().unwrap()["fileName"],
        "launch-plan.md"
    );

    // Recorded, uploaded under the owner, and not posted on its own.
    assert!(messages_with(&f, &attachment_id).await.is_empty());
    assert!(!attached(&f, &attachment_id).await);
    // Until the reply carries it, only the owner can open it.
    let uri = format!("/v1/cloud/documents/{attachment_id}");
    let (status, _) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A retry finds the first document.
    let (_, again) = call_tool(&state, &runner, &run_id, "create_document", plan_args()).await;
    assert_eq!(attachment_of(&again), attachment_id);

    // The reply carries it: one agent message, the document inside.
    crate::cloud_agent_runtime::runs::complete_run(&f.pool, &run_id, &runner, "Here is the plan.")
        .await
        .unwrap();
    let envelope = assert_carried_by_agent(&f, &attachment_id).await;
    assert_eq!(envelope["message"]["text"], "Here is the plan.");
    assert_eq!(envelope["message"]["requestId"], request_id.as_str());

    // Members open it, with the agent as its author; outsiders do not.
    let (status, document) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    assert_eq!(document["fileName"], "launch-plan.md");
    assert!(document["agent"]["displayName"].is_string(), "{document}");
    assert_eq!(document["author"]["accountId"], f.owner.as_str());
    let (status, _) = send(&f.app, "GET", &uri, Some(&f.outsider_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Listed in the session's Artifacts.
    let uri = format!("/v1/cloud/session-activity?sessionId={session_id}");
    let (_, activity) = send(&f.app, "GET", &uri, Some(&f.member_token), None).await;
    assert!(activity["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|artifact| artifact["attachmentId"] == attachment_id.as_str()));
}

#[tokio::test]
async fn a_failed_cloud_run_does_not_attach_its_document_to_the_failure() {
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
    assert!(messages_with(&f, &attachment_id).await.is_empty());
    assert!(!attached(&f, &attachment_id).await);
}

#[tokio::test]
async fn untitled_and_empty_documents_are_refused_so_the_model_retries() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let run_id = chat_run(&f, &session_id, &f.owner, &request_id).await;
    let (runner, _) = lease(&f, &state, &run_id).await;
    // The reported case: a placeholder name and a one-byte body.
    for args in [
        json!({ "title": "Untitled", "content": "\n" }),
        json!({ "title": "Untitled.md", "content": "# Plan" }),
        json!({ "title": "  ", "content": "# Plan" }),
        json!({ "title": "Plan", "content": "\n" }),
        json!({}),
    ] {
        let (status, refused) =
            call_tool(&state, &runner, &run_id, "create_document", args.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{args}");
        let message = refused.error.as_ref().unwrap().message.clone();
        assert!(message.contains("call create_document once"), "{message}");
    }
    let (count,): (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*) FROM cloud_agent_run_documents WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn create_document_follows_the_gate_and_group_membership() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;

    let private_session = format!("session:self-agent:{}", Uuid::new_v4().simple());
    let private = chat_run(&f, &private_session, &f.owner, "msg_private").await;
    let (runner, tools) = lease(&f, &state, &private).await;
    assert!(tools.is_empty(), "{tools:?}");
    let (status, _) = call_tool(&state, &runner, &private, "create_document", plan_args()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let mention = post_comment(&f, &f.owner_token, "b1", "@Kordi summarize").await;
    let (comment_run, ..) = only_run(&f, &mention).await;
    let (_, tools) = lease(&f, &state, &comment_run).await;
    assert!(!tool_names(&tools).contains(&"create_document"));

    let member_run = chat_run(&f, &session_id, &f.member, &request_id).await;
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
