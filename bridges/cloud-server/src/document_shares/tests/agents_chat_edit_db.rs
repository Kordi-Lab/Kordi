//! Database tests for `edit_document` in the owner's own chat run on their
//! Mac: offered on the desktop lease, refused for anyone else's request and
//! once the run is back on the cloud runner.

use chrono::Utc;
use serde_json::json;
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

/// A chat run of the owner's agent that `requester` asked for, held by the
/// owner's Mac.
async fn desktop_chat_run(f: &Fixture, session_id: &str, requester: &str) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
         session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
         updated_at, run_trigger, execution_backend, claimed_by) \
         VALUES ($1, $1, $2, $3, $4, $5, 'leased', 'Add a paragraph', $6, $6, \
                 'person_started', 'desktop', 'desktop:test-mac')",
    )
    .bind(&run_id)
    .bind(format!("msg_{run_id}"))
    .bind(session_id)
    .bind(&f.owner)
    .bind(requester)
    .bind(now)
    .execute(&f.pool)
    .await
    .unwrap();
    run_id
}

#[tokio::test]
async fn the_owners_chat_run_on_the_mac_edits_a_session_document() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let session_id = session_of(&f).await;
    let run_id = desktop_chat_run(&f, &session_id, &f.owner).await;
    let tools = deliver_to_run(&f.pool, &state.connectors().providers, &run_id).await;
    assert_eq!(
        tool_names(&tools),
        ["read_document", "edit_document", "create_document"]
    );

    // A document outside the session is not reachable.
    let outside = json!({
        "attachmentId": format!("att_doc_{}", Uuid::new_v4().simple()),
        "baseRevision": 1,
        "operations": [{ "op": "delete", "blockId": "b1" }]
    });
    assert!(execute(&state, &run_id, "edit_document", &outside)
        .await
        .is_err());

    let args = json!({
        "attachmentId": f.attachment_id,
        "baseRevision": 1,
        "operations": [{ "op": "insert_after", "blockId": "b2", "markdown": "Added paragraph." }]
    });
    let edited = execute(&state, &run_id, "edit_document", &args)
        .await
        .expect("the owner's edit applies");
    assert_eq!(edited["applied"], true, "{edited}");
    assert_eq!(edited["revision"], 2);
    let (source, by_account): (String, Option<String>) = query_as(
        "SELECT source, updated_by_account_id FROM cloud_document_contents \
         WHERE attachment_id = $1",
    )
    .bind(&f.attachment_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(source.contains("Added paragraph."), "{source}");
    assert_eq!(by_account.as_deref(), Some(f.owner.as_str()));

    // Handed back to the cloud runner, the run has no approval card.
    query(
        "UPDATE cloud_agent_fallback_runs SET execution_backend = 'cloud', \
         claimed_by = 'runner-test' WHERE run_id = $1",
    )
    .bind(&run_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let again = json!({
        "baseRevision": 2,
        "operations": [{ "op": "delete", "blockId": "b1" }]
    });
    assert!(execute(&state, &run_id, "edit_document", &again)
        .await
        .is_err());
    assert_eq!(document(&f, &f.owner_token).await["revision"], 2);
}

#[tokio::test]
async fn a_members_chat_run_on_the_owners_mac_never_edits() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let session_id = session_of(&f).await;
    let run_id = desktop_chat_run(&f, &session_id, &f.member).await;
    let tools = deliver_to_run(&f.pool, &state.connectors().providers, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document", "create_document"]);
    let args = json!({
        "baseRevision": 1,
        "operations": [{ "op": "delete", "blockId": "b1" }]
    });
    assert!(execute(&state, &run_id, "edit_document", &args)
        .await
        .is_err());
}
