//! Database tests for comment mentions, the runs they start, and how a
//! run's answer comes back as a reply comment.

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::agents_fixture::*;
use super::db_fixture::*;
use crate::cloud_agent_runtime::runs::{complete_run, fail_run};
use crate::document_shares::access::canonical_record;
use crate::document_shares::agents::mentions::ResolvedAgent;
use crate::document_shares::agents::runs::{start, PlannedRun};

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

async fn annotation_events(f: &Fixture, account: &str) -> i64 {
    let (count,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_chat_user_sync_events WHERE account_id = $1 AND event_type = 'document.updated' AND payload->>'change' = 'annotations'")
        .bind(account)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    count
}

#[tokio::test]
async fn a_members_mention_of_their_own_agent_starts_exactly_one_run() {
    let Some(f) = fixture().await else { return };
    let comment = post_comment(&f, &f.member_token, "b1", "@Kordi can you tighten this?").await;
    assert_eq!(comment["mentionsAgent"], true);
    assert_eq!(comment["kind"], "person");
    assert_eq!(comment["agentRun"]["status"], "queued", "{comment}");
    let comment_id = comment["commentId"].as_str().unwrap();
    let (run_id, owner, requester, agent, trigger, status) = only_run(&f, &comment).await;
    assert_eq!(owner, f.member);
    assert_eq!(requester, f.member);
    assert_eq!(agent, format!("cloud-agent:{}", f.member));
    assert_eq!(trigger, "person_started");
    assert_eq!(status, "queued");
    let (request_id, session_id, audience, prompt, backend): (
        String,
        String,
        String,
        String,
        String,
    ) = query_as(
        "SELECT request_message_id, session_id, connector_audience, prompt, execution_backend \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(request_id, format!("doccmt:{comment_id}"));
    assert!(session_id.starts_with("group-doc-"), "{session_id}");
    assert_eq!((audience.as_str(), backend.as_str()), ("shared", "cloud"));
    assert!(prompt.contains("\"Field notes\""), "{prompt}");
    assert!(prompt.contains("[b1] (the commented block)\nFirst paragraph."));
    assert!(prompt.ends_with("@Kordi can you tighten this?"));
    assert!(!prompt.contains(&f.member), "no account ids in the prompt");

    // The same post again while the first is unanswered starts nothing.
    let again = post_comment(&f, &f.member_token, "b1", "@Kordi can you tighten this?").await;
    assert_ne!(again["commentId"], comment["commentId"]);
    assert!(again["agentRun"].is_null(), "{again}");
    assert!(runs_of(&f, again["commentId"].as_str().unwrap())
        .await
        .is_empty());

    // Starting the run for the same comment and agent again is idempotent.
    let state = state(&f).await;
    let record = canonical_record(&f.pool, &f.attachment_id)
        .await
        .unwrap()
        .unwrap();
    let planned = PlannedRun {
        agent: ResolvedAgent {
            agent_id: agent.clone(),
            owner_account_id: f.member.clone(),
            name: "Kordi".into(),
        },
        session_id,
        requester_account_id: f.member.clone(),
        public_reader: false,
    };
    assert_eq!(
        start(&state, &record, comment_id, &planned).await.unwrap(),
        run_id
    );
    assert_eq!(runs_of(&f, comment_id).await.len(), 1);

    // Unknown names, people, and comments without a mention start nothing.
    for body in [
        "@Nobody can you help?",
        "@member what do you think?",
        "Plain note",
    ] {
        let plain = post_comment(&f, &f.member_token, "b2", body).await;
        assert!(plain["agentRun"].is_null(), "{plain}");
        assert!(runs_of(&f, plain["commentId"].as_str().unwrap())
            .await
            .is_empty());
    }
    // An outsider cannot comment at all.
    let (status, _) = send(
        &f.app,
        "POST",
        &comments_uri(&f),
        Some(&f.outsider_token),
        Some(json!({ "blockId": "b1", "body": "@Kordi hello" })),
    )
    .await;
    assert_ne!(status, StatusCode::OK);
}

#[tokio::test]
async fn completion_posts_the_agent_reply_in_the_thread_and_not_in_chat() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let root = post_comment(&f, &f.owner_token, "b1", "Is this right?").await;
    let root_id = root["commentId"].as_str().unwrap();
    let (status, mention) = send(
        &f.app,
        "POST",
        &comments_uri(&f),
        Some(&f.member_token),
        Some(json!({ "blockId": "b1", "body": "@Kordi please check", "parentCommentId": root_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{mention}");
    let mention_id = mention["commentId"].as_str().unwrap();
    let (run_id, ..) = only_run(&f, &mention).await;
    let prompt: (String,) =
        query_as("SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(
        prompt.0.contains("Thread so far:\nowner: Is this right?"),
        "{}",
        prompt.0
    );

    let (runner, _) = lease(&f, &state, &run_id).await;
    let working = document(&f, &f.owner_token).await;
    assert_eq!(
        comment_in(&working, mention_id)["agentRun"]["status"],
        "running"
    );
    let chat_before = chat_messages(&f).await;
    let events_before = annotation_events(&f, &f.owner).await;

    let done = complete_run(&f.pool, &run_id, &runner, "  It is right.  ")
        .await
        .unwrap();
    assert_eq!(done.status, "completed");
    assert_eq!(chat_messages(&f).await, chat_before, "no chat message");
    assert_eq!(annotation_events(&f, &f.owner).await, events_before + 1);
    assert_eq!(annotation_events(&f, &f.outsider).await, 0);

    let after = document(&f, &f.owner_token).await;
    assert_eq!(
        comment_in(&after, mention_id)["agentRun"]["status"],
        "completed"
    );
    let replies = replies_to(&after, root_id);
    assert_eq!(
        replies.len(),
        2,
        "the mention and the agent reply share the root"
    );
    let reply = replies[1];
    assert_eq!(reply["kind"], "agent");
    assert_eq!(reply["body"], "It is right.");
    assert_eq!(reply["blockId"], "b1");
    assert_eq!(reply["mine"], false);
    assert!(reply["agentRun"].is_null());
    assert_eq!(reply["author"]["displayName"], "Kordi");
    assert_eq!(
        reply["author"]["agentId"],
        format!("cloud-agent:{}", f.member)
    );
    assert_eq!(reply["author"]["ownerAccountId"], f.member.as_str());
    assert!(reply["author"]["accountId"].is_null());
    let (response_id,): (Option<String>,) =
        query_as("SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(response_id.as_deref(), reply["commentId"].as_str());

    // A finished run cannot be completed again, and nobody edits the reply.
    assert!(complete_run(&f.pool, &run_id, &runner, "Again")
        .await
        .is_err());
    let reply_uri = format!(
        "/v1/cloud/documents/comments/{}",
        reply["commentId"].as_str().unwrap()
    );
    let (status, _) = send(&f.app, "DELETE", &reply_uri, Some(&f.member_token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // The agent can be asked again once it has answered.
    let again = post_comment(&f, &f.member_token, "b1", "@Kordi please check").await;
    assert_eq!(again["agentRun"]["status"], "queued");
}

#[tokio::test]
async fn failure_posts_the_system_reply_and_ends_the_working_state() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let mention = post_comment(&f, &f.member_token, "b2", "@Kordi summarize").await;
    let mention_id = mention["commentId"].as_str().unwrap();
    let (run_id, ..) = only_run(&f, &mention).await;
    let (runner, _) = lease(&f, &state, &run_id).await;
    let chat_before = chat_messages(&f).await;
    let failed = fail_run(
        &f.pool,
        &run_id,
        &runner,
        "model_provider_error",
        "boom",
        None,
    )
    .await
    .unwrap();
    assert_eq!(failed.status, "failed");
    assert_eq!(chat_messages(&f).await, chat_before, "no chat message");
    let after = document(&f, &f.member_token).await;
    assert_eq!(
        comment_in(&after, mention_id)["agentRun"]["status"],
        "failed"
    );
    let replies = replies_to(&after, mention_id);
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["kind"], "system");
    assert_eq!(replies[0]["body"], "Kordi could not answer.");
    let (code,): (Option<String>,) =
        query_as("SELECT error_code FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(code.as_deref(), Some("model_provider_error"));
}

async fn public_comment(f: &Fixture, token: &str, body: &str) -> (StatusCode, Value) {
    send(
        &f.app,
        "POST",
        &format!("/v1/cloud/public/documents/{token}/comments"),
        None,
        Some(json!({ "blockId": "b1", "body": body, "readerKey": READER_KEY, "readerName": "Priya" })),
    )
    .await
}

#[tokio::test]
async fn a_public_readers_mention_runs_only_with_the_switch_on_and_never_edits() {
    let Some(f) = fixture().await else { return };
    let state = state(&f).await;
    let share = create_share(&f).await;
    let token = token_of(&share);
    assert_eq!(share["readersCanAskAgent"], true);

    // A reader cannot reach a named agent or another person's agent.
    let (status, other) = public_comment(&f, &token, "@member's Kordi hello").await;
    assert_eq!(status, StatusCode::OK, "{other}");
    assert!(other["agentRun"].is_null());

    let (status, mention) = public_comment(&f, &token, "@Kordi what does this mean?").await;
    assert_eq!(status, StatusCode::OK, "{mention}");
    assert_eq!(mention["agentRun"]["status"], "queued");
    let mention_id = mention["commentId"].as_str().unwrap();
    let (run_id, owner, requester, agent, trigger, _) = only_run(&f, &mention).await;
    assert_eq!(
        (owner.as_str(), requester.as_str()),
        (f.owner.as_str(), f.owner.as_str())
    );
    assert_eq!(agent, format!("cloud-agent:{}", f.owner));
    assert_eq!(
        trigger, "background",
        "a reader's run is never person-started"
    );

    let (runner, tools) = lease(&f, &state, &run_id).await;
    assert_eq!(tool_names(&tools), ["read_document"]);
    let (status, read) = call_tool(&state, &runner, &run_id, "read_document", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{read:?}");
    let edit = json!({ "baseRevision": 1, "operations": [{ "op": "delete", "blockId": "b1" }] });
    let (status, refused) =
        call_tool(&state, &runner, &run_id, "edit_document", edit.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("tool_not_on_lease"));
    // Even with the tool forced onto the lease, the gate refuses a reader.
    sqlx_core::query::query(
        "UPDATE cloud_agent_fallback_runs SET run_trigger = 'person_started', \
         connector_tools_json = connector_tools_json || $2 WHERE run_id = $1",
    )
    .bind(&run_id)
    .bind(json!([{ "connectorId": "kordi-documents", "provider": "kordi_documents", "name": "edit_document", "group": "act", "description": "x", "inputSchema": {} }]))
    .execute(&f.pool)
    .await
    .unwrap();
    let (status, refused) = call_tool(&state, &runner, &run_id, "edit_document", edit).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error_code(), Some("document_tool_forbidden"));
    let unchanged = document(&f, &f.owner_token).await;
    assert_eq!(unchanged["revision"], 1);

    complete_run(&f.pool, &run_id, &runner, "It means the notes are done.")
        .await
        .unwrap();
    let (status, public) = send(
        &f.app,
        "GET",
        &format!("/v1/cloud/public/documents/{token}?readerKey={READER_KEY}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        comment_in(&public, mention_id)["agentRun"]["status"],
        "completed"
    );
    let reply = replies_to(&public, mention_id)[0];
    assert_eq!(reply["kind"], "agent");
    assert_eq!(reply["author"]["displayName"], "Kordi");
    assert!(reply["author"].get("agentId").is_none(), "{reply}");
    assert!(reply["author"].get("ownerAccountId").is_none(), "{reply}");
    assert!(
        !public.to_string().contains(&f.owner),
        "no account ids in public payloads"
    );

    // With the switch off the same comment starts nothing.
    let share_uri = format!(
        "/v1/cloud/documents/shares/{}",
        share["shareId"].as_str().unwrap()
    );
    let (status, _) = send(
        &f.app,
        "PATCH",
        &share_uri,
        Some(&f.owner_token),
        Some(json!({ "readersCanAskAgent": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, quiet) = public_comment(&f, &token, "@Kordi and this?").await;
    assert_eq!(status, StatusCode::OK, "{quiet}");
    assert!(quiet["agentRun"].is_null());
    assert!(runs_of(&f, quiet["commentId"].as_str().unwrap())
        .await
        .is_empty());
}
