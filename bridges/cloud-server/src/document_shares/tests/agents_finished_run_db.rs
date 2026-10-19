//! Database tests for document tools on a desktop run that already answered
//! (issue 1889): the owner's background task keeps `read_document` on the
//! parent's claim after the parent completes; an edit, anyone else's request,
//! another claim, and an expired window are refused.

use axum::http::StatusCode;
use serde_json::json;
use uuid::Uuid;

use super::agents_create_fixture::*;
use super::agents_fixture::*;
use super::db_fixture::*;
use crate::document_shares::agents::tools;

fn parent_tools() -> Vec<crate::connectors::delivery::LeaseConnectorTool> {
    let mut lease = tools::descriptors(true, true);
    lease.push(tools::create_descriptor());
    lease
}

#[tokio::test]
async fn an_owner_background_task_reads_documents_after_the_parent_completes() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let executor = format!("desktop:{}", Uuid::new_v4());
    let read_args = json!({ "attachmentId": f.attachment_id });

    // The owner's run answered an hour ago; its background task still reads.
    let run = (
        session_id.as_str(),
        request_id.as_str(),
        executor.as_str(),
        Some(1),
    );
    let parent = desktop_run_for(&f, run, &f.owner, parent_tools()).await;
    let (status, read) = desktop_call(
        &f,
        &state,
        &executor,
        &parent,
        "read_document",
        read_args.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    let result = read.result.unwrap();
    assert_eq!(result["attachmentId"], f.attachment_id.as_str());
    assert_eq!(result["title"], "Field notes");

    // An edit needs a live run, even though the parent lease carried it.
    let edit = json!({ "attachmentId": f.attachment_id, "baseRevision": 1,
                       "operations": [{ "op": "delete", "blockId": "b1" }] });
    let (status, refused) =
        desktop_call(&f, &state, &executor, &parent, "edit_document", edit).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("lease_invalid"));

    // Another claim and an expired window are refused.
    let (status, _) = desktop_call(
        &f,
        &state,
        "desktop:other",
        &parent,
        "read_document",
        read_args.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let stale_run = (
        session_id.as_str(),
        "msg_stale",
        executor.as_str(),
        Some(13),
    );
    let stale = desktop_run_for(&f, stale_run, &f.owner, parent_tools()).await;
    let (status, refused) = desktop_call(
        &f,
        &state,
        &executor,
        &stale,
        "read_document",
        read_args.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("lease_invalid"));
}

#[tokio::test]
async fn a_members_finished_run_keeps_create_document_only() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let (conversation, session_id) = group(&f).await;
    let request_id = send_request(&f, conversation, &session_id).await;
    let executor = format!("desktop:{}", Uuid::new_v4());
    let run = (
        session_id.as_str(),
        request_id.as_str(),
        executor.as_str(),
        Some(1),
    );
    let mut lease = tools::descriptors(true, false);
    lease.push(tools::create_descriptor());
    let parent = desktop_run_for(&f, run, &f.member, lease).await;

    let args = json!({ "attachmentId": f.attachment_id });
    let (status, refused) =
        desktop_call(&f, &state, &executor, &parent, "read_document", args).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("lease_invalid"));
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
}
