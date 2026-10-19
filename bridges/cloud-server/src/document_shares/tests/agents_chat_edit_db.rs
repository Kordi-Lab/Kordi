//! Database tests for `edit_document` in the owner's own chat run: offered
//! on the Mac and on the cloud runner, limited to documents of the run's
//! session, and never offered for another member's request.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::agents_fixture::*;
use super::db_fixture::*;
use crate::connectors::delivery::deliver_to_run;
use crate::document_shares::agents::tools::execute;

async fn session_of(f: &Fixture) -> String {
    let (session_id,): (String,) = query_as(
        "SELECT conversation.legacy_session_id FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_messages message ON message.conversation_id = conversation.conversation_id \
         JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
         WHERE link.attachment_id = $1",
    )
    .bind(&f.attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    session_id
}

/// A chat run of the owner's agent that `requester` asked for: queued for
/// the cloud runner, or held by the owner's Mac.
async fn chat_run(f: &Fixture, session_id: &str, requester: &str, on_mac: bool) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let (status, backend, claimed_by) = if on_mac {
        ("leased", Some("desktop"), Some("desktop:test-mac"))
    } else {
        ("queued", None, None)
    };
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, run_trigger, execution_backend, claimed_by) \
         VALUES ($1, $1, $2, $3, $4, $5, $6, 'Add a paragraph', $7, $7, 'person_started', \
                 COALESCE($8, 'cloud'), $9)",
    )
    .bind(&run_id)
    .bind(format!("msg_{run_id}"))
    .bind(session_id)
    .bind(&f.owner)
    .bind(requester)
    .bind(status)
    .bind(now)
    .bind(backend)
    .bind(claimed_by)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

fn insert_paragraph(attachment_id: Option<&str>, base: i64, text: &str) -> Value {
    let mut args = json!({
        "baseRevision": base,
        "operations": [{ "op": "insert_after", "blockId": "b2", "markdown": text }]
    });
    if let Some(id) = attachment_id {
        args["attachmentId"] = json!(id);
    }
    args
}

fn outside_document() -> Value {
    json!({
        "attachmentId": format!("att_doc_{}", Uuid::new_v4().simple()),
        "baseRevision": 1,
        "operations": [{ "op": "delete", "blockId": "b1" }]
    })
}

async fn stored_source(f: &Fixture) -> (String, Option<String>) {
    query_as(
        "SELECT source, updated_by_account_id FROM cloud_document_contents \
         WHERE attachment_id = $1",
    )
    .bind(&f.attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn the_owners_chat_run_on_the_cloud_runner_edits_a_session_document() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let session_id = session_of(&f).await;
    let run_id = chat_run(&f, &session_id, &f.owner, false).await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(
        tool_names(&tools),
        ["read_document", "edit_document", "create_document"]
    );

    // A document outside the session is not reachable.
    let (status, refused) = call_tool(
        &state,
        &runner,
        &run_id,
        "edit_document",
        outside_document(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{refused:?}");

    let args = insert_paragraph(None, 1, "Added by the cloud run.");
    let (status, edited) = call_tool(&state, &runner, &run_id, "edit_document", args).await;
    assert_eq!(status, StatusCode::OK, "{edited:?}");
    let edited = edited.result.unwrap();
    assert_eq!(edited["applied"], true, "{edited}");
    assert_eq!(edited["revision"], 2);
    let (source, by_account) = stored_source(&f).await;
    assert!(source.contains("Added by the cloud run."), "{source}");
    assert_eq!(by_account.as_deref(), Some(f.owner.as_str()));
}

#[tokio::test]
async fn the_owners_chat_run_keeps_edit_after_a_handback_within_its_session() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let session_id = session_of(&f).await;
    let run_id = chat_run(&f, &session_id, &f.owner, true).await;
    let tools = deliver_to_run(&f.pool, &state.connectors().providers, &run_id).await;
    assert_eq!(
        tool_names(&tools),
        ["read_document", "edit_document", "create_document"]
    );
    let args = insert_paragraph(Some(&f.attachment_id), 1, "Added on the Mac.");
    let edited = execute(&state, &run_id, "edit_document", &args)
        .await
        .expect("the owner's edit applies");
    assert_eq!(edited["applied"], true, "{edited}");
    assert_eq!(edited["revision"], 2);

    // Handed back to the cloud runner, the owner's run still edits, and
    // still only documents of its session.
    query(
        "UPDATE cloud_agent_fallback_runs SET execution_backend = 'cloud', \
         claimed_by = 'runner-test' WHERE run_id = $1",
    )
    .bind(&run_id)
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(
        execute(&state, &run_id, "edit_document", &outside_document())
            .await
            .is_err()
    );
    let args = insert_paragraph(None, 2, "Added after the handback.");
    let edited = execute(&state, &run_id, "edit_document", &args)
        .await
        .expect("the handed-back edit applies");
    assert_eq!(edited["revision"], 3);
    let (source, _) = stored_source(&f).await;
    assert!(source.contains("Added on the Mac."), "{source}");
    assert!(source.contains("Added after the handback."), "{source}");
}

#[tokio::test]
async fn a_members_chat_run_never_edits_on_the_mac_or_the_cloud() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let session_id = session_of(&f).await;
    for on_mac in [true, false] {
        let run_id = chat_run(&f, &session_id, &f.member, on_mac).await;
        let tools = deliver_to_run(&f.pool, &state.connectors().providers, &run_id).await;
        assert_eq!(
            tool_names(&tools),
            ["read_document", "create_document"],
            "on_mac={on_mac}"
        );
        let args = insert_paragraph(None, 1, "Not allowed.");
        assert!(execute(&state, &run_id, "edit_document", &args)
            .await
            .is_err());
    }
    assert_eq!(document(&f, &f.owner_token).await["revision"], 1);
}
