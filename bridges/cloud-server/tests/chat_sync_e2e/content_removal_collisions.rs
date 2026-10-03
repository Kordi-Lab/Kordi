//! Deleting a message reaches only that message's records, even when another
//! member reuses one of its client-chosen ids (a client id or a group
//! envelope id) for their own message.

use super::content_removal::{direct_chat, group_chat, send_text, Chat};
use super::content_removal_worker::{job_ids, settle, FakeObjects};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::chat_sync::models::MessageSnapshot;
use kordi_cloud_server::cloud_agent_runtime::runs::{claim_run, ClaimRunRequest, RunError};
use serde_json::Value;

async fn send_as(
    pool: &PgPool,
    chat: &Chat,
    sender: &str,
    client_message_id: Uuid,
    content: Value,
) -> MessageSnapshot {
    store::send_message(
        pool,
        sender,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id,
            kind: "text".into(),
            content,
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send message")
    .value
}

fn quote_action(session_id: &str, source_id: &str, preview: &str) -> Value {
    json!({
        "schemaVersion": 1,
        "kind": "quote",
        "source": {
            "sourceSessionId": session_id,
            "sourceMessageId": source_id,
            "senderLabel": "Owner",
            "textPreview": preview,
            "attachmentCount": 0,
            "createdAtMs": 1
        }
    })
}

fn encoded(prefix: &str, envelope: &Value) -> Value {
    content(&format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    ))
}

/// A group envelope sent by `sender` whose logical id is `logical_id`.
fn group_message(
    chat: &Chat,
    sender: &str,
    logical_id: &str,
    text: &str,
    action: Option<Value>,
) -> Value {
    let mut message = json!({
        "id": logical_id, "senderAccountId": sender, "text": text, "createdAtMs": 1
    });
    if let Some(action) = action {
        message["messageAction"] = action;
    }
    encoded(
        "kordi-cloud-group:",
        &json!({
            "kind": "group-message",
            "groupId": chat.session_id,
            "groupTitle": null,
            "createdByAccountId": chat.owner,
            "actor": { "accountId": sender, "displayName": "Member" },
            "participants": [
                { "accountId": chat.owner, "displayName": "Owner" },
                { "accountId": chat.peer, "displayName": "Peer" }
            ],
            "message": message
        }),
    )
}

/// A run of `owner`'s agent that `requester` asked for, with a live lease.
async fn insert_run(
    pool: &PgPool,
    chat: &Chat,
    request_id: &str,
    owner: &str,
    requester: &str,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,execution_agent_id) VALUES($1,$1,$2,$3,$4,$5,'queued','Summarize the request',$6,$6,$7)")
        .bind(&run_id).bind(request_id).bind(&chat.session_id).bind(owner).bind(requester)
        .bind(&now).bind(format!("cloud-agent:{owner}"))
        .execute(pool).await.expect("insert run");
    run_id
}

async fn run_state(pool: &PgPool, run_id: &str) -> (String, String) {
    query_as("SELECT status, prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A task summary recorded from `response_id` and a files-panel entry created
/// from `source_id`, both written by `account`. Returns their ids.
async fn session_records(
    pool: &PgPool,
    chat: &Chat,
    account: &str,
    response_id: &str,
    source_id: &str,
) -> (String, String) {
    let now = chrono::Utc::now().to_rfc3339();
    let task_id = format!("task-{}", Uuid::new_v4());
    query("INSERT INTO cloud_session_tasks(task_activity_id,session_id,task_id,title,summary,status,created_by_account_id,participants_json,response_message_id,created_at,updated_at) VALUES($1,$2,$3,'Task','Task summary','done',$4,'[]'::jsonb,$5,$6,$6)")
        .bind(format!("taskact_{}", Uuid::new_v4().simple())).bind(&chat.session_id).bind(&task_id)
        .bind(account).bind(response_id).bind(&now)
        .execute(pool).await.unwrap();
    let artifact_id = format!("docs/{}.md", Uuid::new_v4());
    query("INSERT INTO cloud_session_artifacts(artifact_activity_id,session_id,artifact_id,name,path,kind,category,created_by_account_id,source_message_id,created_at,updated_at) VALUES($1,$2,$3,'plan.md',$3,'document','artifact',$4,$5,$6,$6)")
        .bind(format!("artifactact_{}", Uuid::new_v4().simple())).bind(&chat.session_id).bind(&artifact_id)
        .bind(account).bind(source_id).bind(&now)
        .execute(pool).await.unwrap();
    (task_id, artifact_id)
}

/// (task summary present, files-panel entry archived)
async fn records_state(pool: &PgPool, task_id: &str, artifact_id: &str) -> (bool, bool) {
    query_as(
        "SELECT task.summary IS NOT NULL, artifact.archived_at IS NOT NULL \
         FROM cloud_session_tasks task, cloud_session_artifacts artifact \
         WHERE task.task_id = $1 AND artifact.artifact_id = $2",
    )
    .bind(task_id)
    .bind(artifact_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn delete_and_settle(pool: &PgPool, chat: &Chat, sender: &str, message: &MessageSnapshot) {
    store::delete_message(pool, sender, chat.conversation_id, message.id, true)
        .await
        .expect("delete for everyone");
    settle(
        pool,
        &FakeObjects::default(),
        &job_ids(pool, message.id).await,
    )
    .await;
}

async fn was_deleted(pool: &PgPool, chat: &Chat, request_id: &str, requester: &str) -> bool {
    store::request_was_deleted(pool, &chat.session_id, request_id, requester)
        .await
        .unwrap()
}

fn claim(chat: &Chat, request_id: &str, owner: &str, requester: &str) -> ClaimRunRequest {
    ClaimRunRequest {
        request_message_id: request_id.to_string(),
        session_id: chat.session_id.clone(),
        owner_account_id: owner.to_string(),
        requester_account_id: requester.to_string(),
        prompt: "Summarize the request".to_string(),
        runtime_route: None,
        idempotency_key: Uuid::new_v4().to_string(),
    }
}

#[tokio::test]
async fn reusing_another_members_ids_in_a_direct_chat_reaches_only_your_own_records() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "collision-direct").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let live = send_text(&pool, &chat, &canary).await;
    let live_id = live.id.to_string();
    let live_client_id = live.client_message_id.to_string();
    let live_run = insert_run(&pool, &chat, &live_id, &chat.owner, &chat.owner).await;
    let (task_id, artifact_id) =
        session_records(&pool, &chat, &chat.owner, &live_id, &live_client_id).await;

    // The peer sends one message whose client id is the live message's id and
    // one whose client id is the live message's client id, then deletes both.
    let reuses_id = send_as(&pool, &chat, &chat.peer, live.id, content("mine")).await;
    let reuses_client_id = send_as(
        &pool,
        &chat,
        &chat.peer,
        live.client_message_id,
        content("mine too"),
    )
    .await;
    let quote = send_as(
        &pool,
        &chat,
        &chat.owner,
        Uuid::now_v7(),
        encoded(
            "kordi-cloud-message:",
            &json!({"schemaVersion": 1, "kind": "message", "text": "quoting",
                    "messageAction": quote_action(&chat.session_id, &live_id, &canary)}),
        ),
    )
    .await;
    // Positive control: the peer's own run under the reused id is theirs to lose.
    let peer_run = insert_run(&pool, &chat, &live_id, &chat.peer, &chat.peer).await;
    delete_and_settle(&pool, &chat, &chat.peer, &reuses_id).await;
    delete_and_settle(&pool, &chat, &chat.peer, &reuses_client_id).await;

    assert_eq!(
        run_state(&pool, &live_run).await,
        ("queued".into(), "Summarize the request".into())
    );
    assert_eq!(run_state(&pool, &peer_run).await.0, "cancelled");
    for request_id in [
        live_id.clone(),
        live_client_id.clone(),
        format!("ios_{live_client_id}"),
    ] {
        assert!(!was_deleted(&pool, &chat, &request_id, &chat.owner).await);
    }
    assert!(was_deleted(&pool, &chat, &live_id, &chat.peer).await);
    assert!(was_deleted(&pool, &chat, &reuses_id.id.to_string(), &chat.owner).await);
    assert_eq!(
        records_state(&pool, &task_id, &artifact_id).await,
        (true, false)
    );
    let quote_after = store::load_message_snapshot(&pool, quote.id).await.unwrap();
    assert_eq!(quote_after.version, quote.version);
    assert_eq!(quote_after.content, quote.content);
    let claimed = claim_run(&pool, &claim(&chat, &live_id, &chat.owner, &chat.owner))
        .await
        .expect("the live request is still claimable");
    assert_eq!(claimed.status, "queued");

    // Deleting the live message itself still reaches every record that names
    // it by its canonical id.
    delete_and_settle(&pool, &chat, &chat.owner, &live).await;
    assert_eq!(
        run_state(&pool, &live_run).await,
        ("cancelled".into(), String::new())
    );
    assert!(was_deleted(&pool, &chat, &live_id, &chat.owner).await);
    assert!(!records_state(&pool, &task_id, &artifact_id).await.0);
    let quote_after = store::load_message_snapshot(&pool, quote.id).await.unwrap();
    assert_eq!(quote_after.version, quote.version + 1);
    assert!(!quote_after.content.to_string().contains(&canary));
}

#[tokio::test]
async fn reusing_another_members_group_envelope_id_reaches_only_your_own_records() {
    let Some(pool) = try_pool().await else { return };
    let chat = group_chat(&pool, "collision-group", &[]).await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let logical_id = format!("logical-{}", Uuid::new_v4());
    let live = send_as(
        &pool,
        &chat,
        &chat.owner,
        Uuid::now_v7(),
        group_message(&chat, &chat.owner, &logical_id, &canary, None),
    )
    .await;
    let live_run = insert_run(&pool, &chat, &logical_id, &chat.peer, &chat.owner).await;
    let (task_id, artifact_id) = session_records(
        &pool,
        &chat,
        &chat.owner,
        &format!("collaboration-message:{logical_id}"),
        &logical_id,
    )
    .await;

    // The peer sends a message under the same logical id, a thread reply on
    // the live message follows, and the peer deletes their message.
    let reuses = send_as(
        &pool,
        &chat,
        &chat.peer,
        Uuid::now_v7(),
        group_message(&chat, &chat.peer, &logical_id, "mine", None),
    )
    .await;
    let thread = send_as(
        &pool,
        &chat,
        &chat.peer,
        Uuid::now_v7(),
        group_message(
            &chat,
            &chat.peer,
            &format!("logical-{}", Uuid::new_v4()),
            "replying",
            Some(quote_action(&chat.session_id, &logical_id, &canary)),
        ),
    )
    .await;
    delete_and_settle(&pool, &chat, &chat.peer, &reuses).await;

    assert!(!was_deleted(&pool, &chat, &logical_id, &chat.owner).await);
    assert_eq!(
        run_state(&pool, &live_run).await,
        ("queued".into(), "Summarize the request".into())
    );
    assert_eq!(
        records_state(&pool, &task_id, &artifact_id).await,
        (true, false)
    );
    let thread_after = store::load_message_snapshot(&pool, thread.id)
        .await
        .unwrap();
    assert_eq!(thread_after.version, thread.version);
    // Positive control: the peer's own claim under the id they deleted is refused.
    assert!(was_deleted(&pool, &chat, &logical_id, &chat.peer).await);
    let refused = claim_run(&pool, &claim(&chat, &logical_id, &chat.owner, &chat.peer)).await;
    assert!(
        matches!(refused, Err(RunError::ContextUnavailable(_))),
        "{refused:?}"
    );

    // Deleting the live message reaches its run, records, and thread preview.
    delete_and_settle(&pool, &chat, &chat.owner, &live).await;
    assert!(was_deleted(&pool, &chat, &logical_id, &chat.owner).await);
    assert_eq!(
        run_state(&pool, &live_run).await,
        ("cancelled".into(), String::new())
    );
    assert_eq!(
        records_state(&pool, &task_id, &artifact_id).await,
        (false, true)
    );
    let thread_after = store::load_message_snapshot(&pool, thread.id)
        .await
        .unwrap();
    assert_eq!(thread_after.version, thread.version + 1);
    assert!(!thread_after.content.to_string().contains(&canary));
}

#[tokio::test]
async fn a_live_message_reusing_an_id_keeps_only_records_named_through_that_id() {
    let Some(pool) = try_pool().await else { return };
    let chat = group_chat(&pool, "collision-live-reuse", &[]).await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let logical_id = format!("logical-{}", Uuid::new_v4());
    let deleted = send_as(
        &pool,
        &chat,
        &chat.owner,
        Uuid::now_v7(),
        group_message(&chat, &chat.owner, &logical_id, &canary, None),
    )
    .await;
    let queued = insert_run(&pool, &chat, &logical_id, &chat.peer, &chat.owner).await;
    let finished = insert_run(&pool, &chat, &logical_id, &chat.owner, &chat.owner).await;
    query("UPDATE cloud_agent_fallback_runs SET status = 'completed' WHERE run_id = $1")
        .bind(&finished)
        .execute(&pool)
        .await
        .unwrap();
    let (task_id, artifact_id) = session_records(
        &pool,
        &chat,
        &chat.owner,
        &format!("collaboration-message:{}", deleted.id),
        &logical_id,
    )
    .await;
    // The peer's live message reuses the logical id, so a record that names
    // only that id may belong to either message.
    send_as(
        &pool,
        &chat,
        &chat.peer,
        Uuid::now_v7(),
        group_message(&chat, &chat.peer, &logical_id, "mine", None),
    )
    .await;

    delete_and_settle(&pool, &chat, &chat.owner, &deleted).await;
    // Runs of the sender's own request are matched through every id.
    assert_eq!(
        run_state(&pool, &queued).await,
        ("cancelled".into(), String::new())
    );
    assert_eq!(
        run_state(&pool, &finished).await,
        ("completed".into(), String::new())
    );
    assert!(was_deleted(&pool, &chat, &logical_id, &chat.owner).await);
    assert!(!was_deleted(&pool, &chat, &logical_id, &chat.peer).await);
    // The task names the canonical id and is cleared; the files-panel entry
    // names only the shared logical id and is kept.
    assert_eq!(
        records_state(&pool, &task_id, &artifact_id).await,
        (false, false)
    );
}
