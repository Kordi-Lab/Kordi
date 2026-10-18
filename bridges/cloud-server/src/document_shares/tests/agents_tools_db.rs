//! Database tests for `read_document` and `edit_document` under a run lease.

use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::agents_fixture::*;
use super::db_fixture::*;
use crate::document_shares::agents::tools::execute;

async fn save(f: &Fixture, base: i64, source: &str) -> Value {
    let uri = format!("/v1/cloud/documents/{}/content", f.attachment_id);
    let body = json!({ "baseRevision": base, "source": source });
    let (status, saved) = send(&f.app, "PUT", &uri, Some(&f.owner_token), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    saved
}

fn blocks(result: &Value) -> Vec<(String, String)> {
    result["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|block| {
            (
                block["id"].as_str().unwrap().to_string(),
                block["markdown"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

#[tokio::test]
async fn read_document_returns_the_current_revision_and_the_canonical_document() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Kordi what changed?").await;
    let (run_id, ..) = only_run(&f, &mention).await;
    save(
        &f,
        1,
        "# Field notes\n\nFirst paragraph, revised.\n\nSecond paragraph.\n",
    )
    .await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document", "edit_document"]);

    let (status, read) = call_tool(&state, &runner, &run_id, "read_document", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    let result = read.result.unwrap();
    assert_eq!(result["attachmentId"], f.attachment_id.as_str());
    assert_eq!(result["title"], "Field notes");
    assert_eq!(result["format"], "markdown");
    assert_eq!(result["revision"], 2);
    assert_eq!(
        blocks(&result)[1],
        ("b1".to_string(), "First paragraph, revised.".to_string())
    );
    assert!(result.get("threads").is_none());

    // A forwarded copy the member owns resolves to the canonical document.
    let copy = format!("att_doc_copy_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type, \
         size_bytes, created_at, finalized_at, document_source_attachment_id) \
         VALUES ($1, $2, $3, 'text/markdown', 10, $4, $4, $5)",
    )
    .bind(&copy)
    .bind(&f.member)
    .bind(format!("attachments/{}/{copy}", f.member))
    .bind(Utc::now().to_rfc3339())
    .bind(&f.attachment_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let args = json!({ "attachmentId": copy, "includeComments": true });
    let (status, read) = call_tool(&state, &runner, &run_id, "read_document", args).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    let result = read.result.unwrap();
    assert_eq!(result["attachmentId"], f.attachment_id.as_str());
    assert_eq!(result["revision"], 2);
    let threads = result["threads"].as_array().unwrap();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0]["comments"][0]["body"], "@Kordi what changed?");
    assert_eq!(threads[0]["comments"][0]["author"], "member");
    assert!(!result.to_string().contains(&f.member), "no account ids");

    // A document neither account was sent, an unknown id, another runner,
    // and an unknown tool are all refused.
    let foreign = format!("att_doc_foreign_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type, \
         size_bytes, created_at, finalized_at) VALUES ($1, $2, $3, 'text/markdown', 10, $4, $4)",
    )
    .bind(&foreign)
    .bind(&f.outsider)
    .bind(format!("attachments/{}/{foreign}", f.outsider))
    .bind(Utc::now().to_rfc3339())
    .execute(&f.pool)
    .await
    .unwrap();
    for id in [foreign.as_str(), "att_missing"] {
        let args = json!({ "attachmentId": id });
        let (status, refused) = call_tool(&state, &runner, &run_id, "read_document", args).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}");
        assert_eq!(refused.error_code(), Some("document_not_found"));
    }
    let (status, refused) =
        call_tool(&state, "runner-other", &run_id, "read_document", json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("lease_invalid"));
    let (status, _) = call_tool(&state, &runner, &run_id, "delete_document", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn edit_document_applies_operations_and_moves_comments_with_their_blocks() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let stamped = "# Field notes <!-- k:head0001 -->\n\nFirst paragraph.\n\nSecond paragraph.\n<!-- k:tail0001 -->\n";
    save(&f, 1, stamped).await;
    query("INSERT INTO cloud_document_collab (attachment_id, initialized_at) VALUES ($1, now())")
        .bind(&f.attachment_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let on_first = post_comment(&f, &f.owner_token, "b1", "Too long").await;
    let on_tail = post_comment(&f, &f.owner_token, "k:tail0001", "Keep this").await;
    let mention = post_comment(&f, &f.member_token, "b1", "@Kordi rewrite this block").await;
    let (run_id, ..) = only_run(&f, &mention).await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document", "edit_document"]);

    // A stale base revision changes nothing and returns the current blocks.
    let operations = json!([
        { "op": "replace", "blockId": "b1", "markdown": "First paragraph, tightened." },
        { "op": "insert_after", "blockId": "k:head0001", "markdown": "Inserted line." }
    ]);
    let args = json!({ "baseRevision": 1, "operations": operations });
    let (status, stale) = call_tool(&state, &runner, &run_id, "edit_document", args).await;
    assert_eq!(status, StatusCode::OK, "{stale:?}");
    let stale = stale.result.unwrap();
    assert_eq!(stale["applied"], false);
    assert_eq!(stale["reason"], "stale_revision");
    assert_eq!(stale["revision"], 2);
    assert_eq!(blocks(&stale).len(), 3);

    let args = json!({ "baseRevision": 2, "operations": operations });
    let (status, edited) = call_tool(&state, &runner, &run_id, "edit_document", args).await;
    assert_eq!(status, StatusCode::OK, "{edited:?}");
    let edited = edited.result.unwrap();
    assert_eq!(edited["applied"], true);
    assert_eq!(edited["revision"], 3);
    let after = blocks(&edited);
    assert_eq!(after.len(), 4);
    assert_eq!(
        after[0],
        ("k:head0001".to_string(), "# Field notes".to_string())
    );
    assert_eq!(after[1].1, "Inserted line.");
    assert_eq!(after[2].1, "First paragraph, tightened.");
    assert_eq!(
        after[3],
        ("k:tail0001".to_string(), "Second paragraph.".to_string())
    );
    let (inserted, rewritten) = (after[1].0.clone(), after[2].0.clone());
    assert!(inserted.starts_with("k:") && rewritten.starts_with("k:"));
    assert_eq!(edited["newBlockIds"], json!([inserted]));

    let (source, by_account, by_agent, stale_room): (String, Option<String>, Option<String>, bool) =
        query_as(
            "SELECT content.source, content.updated_by_account_id, content.updated_by_agent_id, \
                (SELECT stale_revision FROM cloud_document_collab WHERE attachment_id = $1) \
         FROM cloud_document_contents content WHERE content.attachment_id = $1",
        )
        .bind(&f.attachment_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(
        source.starts_with("# Field notes <!-- k:head0001 -->\n\n"),
        "{source}"
    );
    assert!(
        source.ends_with("Second paragraph.\n<!-- k:tail0001 -->\n"),
        "{source}"
    );
    assert_eq!(by_account.as_deref(), Some(f.member.as_str()));
    assert_eq!(by_agent, Some(format!("cloud-agent:{}", f.member)));
    assert!(stale_room, "connected editors reconcile");

    let now = document(&f, &f.owner_token).await;
    assert_eq!(now["revision"], 3);
    for id in [&on_first, &mention] {
        let moved = comment_in(&now, id["commentId"].as_str().unwrap());
        assert_eq!(
            moved["blockId"],
            rewritten.as_str(),
            "the comment follows its block"
        );
    }
    assert_eq!(
        comment_in(&now, on_tail["commentId"].as_str().unwrap())["blockId"],
        "k:tail0001"
    );
    let (content_events,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'document.updated' AND payload->>'change' = 'content' AND (payload->>'revision')::int = 3 AND payload->>'updatedByAccountId' = $2")
        .bind(&f.owner)
        .bind(&f.member)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(content_events, 1);

    // Bad calls change nothing.
    for (args, code) in [
        (
            json!({ "baseRevision": 3, "operations": [{ "op": "delete", "blockId": "b9" }] }),
            "invalid_request",
        ),
        (
            json!({ "baseRevision": 3, "operations": [] }),
            "invalid_request",
        ),
        (
            json!({ "operations": [{ "op": "delete", "blockId": "b1" }] }),
            "invalid_request",
        ),
    ] {
        let (status, refused) = call_tool(&state, &runner, &run_id, "edit_document", args).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(refused.error_code(), Some(code));
    }
    // A run whose trigger is not person-started loses the edit at once.
    query("UPDATE cloud_agent_fallback_runs SET run_trigger = 'background' WHERE run_id = $1")
        .bind(&run_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let args =
        json!({ "baseRevision": 3, "operations": [{ "op": "delete", "blockId": "k:tail0001" }] });
    let (status, refused) = call_tool(&state, &runner, &run_id, "edit_document", args).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("document_tool_forbidden"));
    assert_eq!(document(&f, &f.owner_token).await["revision"], 3);
}

#[tokio::test]
async fn edit_document_is_refused_when_the_requester_does_not_own_the_agent() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
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
    let mention = post_comment(&f, &f.member_token, "b1", "@Copy Editor fix the tone").await;
    assert_eq!(mention["agentRun"]["status"], "queued", "{mention}");
    let (run_id, owner, requester, agent, trigger, _) = only_run(&f, &mention).await;
    assert_eq!(
        (owner.as_str(), requester.as_str()),
        (f.owner.as_str(), f.member.as_str())
    );
    assert_eq!(agent, agent_id);
    assert_eq!(
        trigger, "background",
        "the requester does not own the agent"
    );
    let (system_prompt,): (String,) =
        query_as("SELECT system_prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(system_prompt.starts_with("You are Copy Editor.\nKeep a formal tone."));
    assert!(!system_prompt.contains("edit_document"));

    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document"]);
    let args = json!({ "baseRevision": 1, "operations": [{ "op": "delete", "blockId": "b1" }] });
    let (status, refused) =
        call_tool(&state, &runner, &run_id, "edit_document", args.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("tool_not_on_lease"));
    assert!(execute(&state, &run_id, "edit_document", &args)
        .await
        .is_err());
    let (status, read) = call_tool(&state, &runner, &run_id, "read_document", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    assert_eq!(read.result.unwrap()["revision"], 1);

    // A private agent of the owner is not reachable by the member at all.
    query("UPDATE cloud_agent_definitions SET access_scope = 'private' WHERE agent_id = $1")
        .bind(&agent_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let private = post_comment(&f, &f.member_token, "b2", "@Copy Editor and here").await;
    assert!(private["agentRun"].is_null(), "{private}");
}

#[tokio::test]
async fn chat_runs_read_documents_of_their_session_and_never_edit() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
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
    let insert_run = |session: String| {
        let run_id = format!("car_{}", Uuid::new_v4().simple());
        let (pool, owner) = (f.pool.clone(), f.owner.clone());
        async move {
            let now = Utc::now().to_rfc3339();
            query(
                "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
                 session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
                 updated_at, run_trigger) VALUES ($1, $1, $2, $3, $4, $4, 'queued', 'Hello', $5, $5, \
                 'person_started')",
            )
            .bind(&run_id)
            .bind(format!("msg_{run_id}"))
            .bind(session)
            .bind(owner)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();
            run_id
        }
    };
    let run_id = insert_run(session_id).await;
    let (runner, tools) = lease(&f, &state, &run_id).await;
    // The session is a group, so the run may also create group documents.
    assert_eq!(tool_names(&tools), ["read_document", "create_document"]);
    let (status, read) = call_tool(&state, &runner, &run_id, "read_document", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    let result = read.result.unwrap();
    assert_eq!(result["attachmentId"], f.attachment_id.as_str());
    assert_eq!(blocks(&result).len(), 3);
    let args = json!({ "baseRevision": 1, "operations": [{ "op": "delete", "blockId": "b1" }] });
    assert!(execute(&state, &run_id, "edit_document", &args)
        .await
        .is_err());

    // A session without a document gets no document tools.
    let empty = insert_run(format!("session:self-agent:{}", Uuid::new_v4().simple())).await;
    let (_, tools) = lease(&f, &state, &empty).await;
    assert!(tools.is_empty(), "{tools:?}");
}
