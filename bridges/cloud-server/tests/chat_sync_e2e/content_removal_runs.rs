//! Agent runs for deleted requests, and repair of changes made elsewhere.

use super::content_removal::{
    direct_chat, group_chat, group_text, jobs, mentions, photo_message, send_text, stored_rows,
};
use super::*;
use kordi_cloud_server::chat_sync::models::MessageSnapshot;
use kordi_cloud_server::cloud_agent_runtime::runs::{claim_run, ClaimRunRequest, RunError};
use serde_json::Value;

async fn insert_run(
    pool: &PgPool,
    session_id: &str,
    request_id: &str,
    owner: &str,
    status: &str,
    agent: &str,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,execution_agent_id) VALUES($1,$1,$2,$3,$4,$4,$5,'Summarize the request',$6,$6,$7)")
        .bind(&run_id).bind(request_id).bind(session_id).bind(owner).bind(status).bind(&now).bind(agent)
        .execute(pool).await.expect("insert run");
    run_id
}

async fn run_state(pool: &PgPool, run_id: &str) -> (String, String, Option<String>) {
    query_as("SELECT status, prompt, error_code FROM cloud_agent_fallback_runs WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(pool)
        .await
        .expect("load run")
}

fn claim(session_id: &str, request_id: &str, owner: &str) -> ClaimRunRequest {
    ClaimRunRequest {
        request_message_id: request_id.to_string(),
        session_id: session_id.to_string(),
        owner_account_id: owner.to_string(),
        requester_account_id: owner.to_string(),
        prompt: "Summarize the request".to_string(),
        runtime_route: None,
        idempotency_key: Uuid::new_v4().to_string(),
    }
}

#[tokio::test]
async fn deleted_requests_cancel_queued_runs_and_refuse_new_ones() {
    let Some(pool) = try_pool().await else { return };
    let group = group_chat(&pool, "removal-runs-group", &[]).await;
    let logical_id = format!("logical-{}", Uuid::new_v4());
    let request = store::send_message(
        &pool,
        &group.owner,
        group.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: content(&group_text(&group, &logical_id, "@Kordi summarize")),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;
    let owner_agent = format!("cloud-agent:{}", group.owner);
    let queued = insert_run(
        &pool,
        &group.session_id,
        &logical_id,
        &group.owner,
        "queued",
        &owner_agent,
    )
    .await;
    let running = insert_run(
        &pool,
        &group.session_id,
        &logical_id,
        &group.owner,
        "running",
        "other-agent",
    )
    .await;
    let canonical_session = insert_run(
        &pool,
        &group.conversation_id.to_string(),
        &request.id.to_string(),
        &group.owner,
        "queued",
        &owner_agent,
    )
    .await;
    let unrelated = insert_run(
        &pool,
        &group.session_id,
        "another-request",
        &group.owner,
        "queued",
        &owner_agent,
    )
    .await;
    assert!(
        !store::request_was_deleted(&pool, &group.session_id, &logical_id)
            .await
            .unwrap()
    );

    store::delete_message(&pool, &group.owner, group.conversation_id, request.id, true)
        .await
        .unwrap();
    for run_id in [&queued, &canonical_session] {
        assert_eq!(
            run_state(&pool, run_id).await,
            (
                "cancelled".to_string(),
                String::new(),
                Some("request_deleted".to_string())
            )
        );
    }
    assert_eq!(run_state(&pool, &running).await.0, "running");
    assert_eq!(run_state(&pool, &running).await.1, "Summarize the request");
    assert_eq!(run_state(&pool, &unrelated).await.0, "queued");

    assert!(
        store::request_was_deleted(&pool, &group.session_id, &logical_id)
            .await
            .unwrap()
    );
    let refused = claim_run(&pool, &claim(&group.session_id, &logical_id, &group.peer)).await;
    assert!(
        matches!(refused, Err(RunError::ContextUnavailable(_))),
        "{refused:?}"
    );

    let chat = direct_chat(&pool, "removal-runs-direct").await;
    let live = send_text(&pool, &chat, "still here").await;
    let deleted = send_text(&pool, &chat, "please summarize").await;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, deleted.id, true)
        .await
        .unwrap();
    for request_id in [
        deleted.id.to_string(),
        deleted.client_message_id.to_string(),
        format!("ios_{}", deleted.client_message_id),
    ] {
        assert!(
            store::request_was_deleted(&pool, &chat.session_id, &request_id)
                .await
                .unwrap()
        );
    }
    let refused = claim_run(
        &pool,
        &claim(&chat.session_id, &deleted.id.to_string(), &chat.owner),
    )
    .await;
    assert!(
        matches!(refused, Err(RunError::ContextUnavailable(_))),
        "{refused:?}"
    );
    // Positive control: a live request in the same chat is still claimable.
    assert!(
        !store::request_was_deleted(&pool, &chat.session_id, &live.id.to_string())
            .await
            .unwrap()
    );
    let accepted = claim_run(
        &pool,
        &claim(&chat.session_id, &live.id.to_string(), &chat.owner),
    )
    .await
    .expect("a live request is claimable");
    assert_eq!(accepted.status, "queued");
}

#[tokio::test]
async fn reconcile_repairs_deletes_and_hides_made_by_an_older_server() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-reconcile").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let (deleted, mut ids) = photo_message(&pool, &chat, &canary).await;
    ids.sort();
    // An older server empties the row and fans out a tombstone snapshot, but
    // rewrites nothing and queues no job.
    query("UPDATE cloud_chat_messages SET content='{\"schema\":1,\"blocks\":[]}'::jsonb, version=version+1, deleted_at=now() WHERE message_id=$1")
        .bind(deleted.id).execute(&pool).await.unwrap();
    query("DELETE FROM cloud_chat_message_attachments WHERE message_id=$1")
        .bind(deleted.id)
        .execute(&pool)
        .await
        .unwrap();
    let tombstone = store::load_message_snapshot(&pool, deleted.id)
        .await
        .unwrap();
    for account_id in [&chat.owner, &chat.peer] {
        append_raw(
            &pool,
            account_id,
            "message.deleted",
            &tombstone,
            json!({ "message": tombstone }),
        )
        .await;
    }
    let hidden = send_text(&pool, &chat, &canary).await;
    query("INSERT INTO cloud_chat_message_visibility(account_id, message_id) VALUES ($1, $2)")
        .bind(&chat.peer)
        .bind(hidden.id)
        .execute(&pool)
        .await
        .unwrap();

    let since = chrono::Utc::now() - chrono::Duration::minutes(30);
    store::reconcile_deleted_messages(&pool, since, 10_000)
        .await
        .unwrap();
    store::reconcile_hidden_messages(&pool, since, 10_000)
        .await
        .unwrap();
    let rows = stored_rows(&pool, deleted.id).await;
    assert!(rows
        .iter()
        .all(|row| row.1 == "message.deleted" && row.3.get("message").is_none()));
    assert!(!mentions(&rows, &canary) && !mentions(&rows, &ids[0]));
    let deleted_jobs = jobs(&pool, deleted.id).await;
    assert_eq!(deleted_jobs.len(), 1);
    assert_eq!(deleted_jobs[0].0, "message_deleted");
    assert!(deleted_jobs[0]
        .1
        .contains(&format!("ios_{}", deleted.client_message_id)));
    assert_eq!(deleted_jobs[0].2, ids);
    let hidden_rows = stored_rows(&pool, hidden.id).await;
    assert!(hidden_rows
        .iter()
        .filter(|row| row.0 == chat.peer)
        .all(|row| row.1 == "message.hidden"));
    assert!(hidden_rows
        .iter()
        .any(|row| row.0 == chat.owner && row.3.to_string().contains(&canary)));
    assert_eq!(jobs(&pool, hidden.id).await.len(), 1);

    // A second pass changes nothing.
    store::reconcile_deleted_messages(&pool, since, 10_000)
        .await
        .unwrap();
    store::reconcile_hidden_messages(&pool, since, 10_000)
        .await
        .unwrap();
    assert_eq!(stored_rows(&pool, deleted.id).await, rows);
    assert_eq!(jobs(&pool, deleted.id).await.len(), 1);
    assert_eq!(jobs(&pool, hidden.id).await.len(), 1);

    // Without the operator backfill, automatic repair never reaches content
    // changed before this server version was installed.
    let (floor, applied): (
        chrono::DateTime<chrono::Utc>,
        Option<chrono::DateTime<chrono::Utc>>,
    ) = query_as(
        "SELECT automatic_since, history_backfill_applied_at FROM cloud_content_removal_state",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let old = send_text(&pool, &chat, &canary).await;
    query("UPDATE cloud_chat_messages SET content='{\"schema\":1,\"blocks\":[]}'::jsonb, version=version+1, deleted_at=$2 WHERE message_id=$1")
        .bind(old.id).bind(floor - chrono::Duration::days(1)).execute(&pool).await.unwrap();
    store::reconcile_deleted_messages(&pool, floor - chrono::Duration::days(2), 10_000)
        .await
        .unwrap();
    if applied.is_none() {
        assert!(jobs(&pool, old.id).await.is_empty());
        assert!(mentions(&stored_rows(&pool, old.id).await, &canary));
    }
    let replay = store::sync_batch(&pool, &chat.peer, 0, Some(1_000))
        .await
        .unwrap();
    assert!(!serde_json::to_string(&replay.events)
        .unwrap()
        .contains(&canary));
}

/// Appends a row as an older server would, keeping the stream contiguous.
async fn append_raw(
    pool: &PgPool,
    account_id: &str,
    event_type: &str,
    message: &MessageSnapshot,
    payload: Value,
) {
    let mut transaction = pool.begin().await.unwrap();
    let (seq,): (i64,) = query_as(
        "UPDATE cloud_chat_user_sync_heads SET last_seq = last_seq + 1 \
         WHERE account_id = $1 RETURNING last_seq",
    )
    .bind(account_id)
    .fetch_one(&mut *transaction)
    .await
    .unwrap();
    query("INSERT INTO cloud_chat_user_sync_events(account_id,stream_seq,event_id,protocol_version,event_type,conversation_id,entity_id,entity_version,critical,payload) VALUES($1,$2,$3,2,$4,$5,$6,$7,true,$8)")
        .bind(account_id).bind(seq).bind(Uuid::now_v7()).bind(event_type)
        .bind(message.conversation_id).bind(message.id).bind(message.version).bind(payload)
        .execute(&mut *transaction).await.unwrap();
    transaction.commit().await.unwrap();
}

#[tokio::test]
async fn replay_never_returns_content_of_deleted_or_hidden_messages() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "removal-guard").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let deleted = send_text(&pool, &chat, &canary).await;
    let hidden = send_text(&pool, &chat, &canary).await;
    let kept = send_text(&pool, &chat, "still visible").await;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, deleted.id, true)
        .await
        .unwrap();
    store::delete_message(&pool, &chat.peer, chat.conversation_id, hidden.id, false)
        .await
        .unwrap();
    let start = sync_head(&pool, &chat.peer).await.0;
    let tombstone = store::load_message_snapshot(&pool, deleted.id)
        .await
        .unwrap();
    append_raw(
        &pool,
        &chat.peer,
        "message.created",
        &deleted,
        json!({ "message": deleted }),
    )
    .await;
    append_raw(
        &pool,
        &chat.peer,
        "message.deleted",
        &tombstone,
        json!({ "message": tombstone, "conversation": { "id": chat.conversation_id } }),
    )
    .await;
    append_raw(
        &pool,
        &chat.peer,
        "message.updated",
        &hidden,
        json!({ "message": hidden }),
    )
    .await;
    append_raw(
        &pool,
        &chat.peer,
        "message.updated",
        &kept,
        json!({ "message": kept }),
    )
    .await;
    let replay = store::sync_batch(&pool, &chat.peer, start, Some(100))
        .await
        .unwrap();
    let types = replay
        .events
        .iter()
        .map(|event| event.event_type.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        types,
        [
            "message.deleted",
            "message.deleted",
            "message.hidden",
            "message.updated"
        ]
    );
    for event in &replay.events[..3] {
        assert!(event.payload.get("message").is_none());
        assert!(event.critical);
    }
    assert_eq!(replay.events[0].entity_id, Some(deleted.id));
    assert_eq!(
        replay.events[1].payload["conversation"]["id"],
        chat.conversation_id.to_string()
    );
    assert_eq!(
        replay.events[2].payload["message_id"],
        hidden.id.to_string()
    );
    assert_eq!(
        replay.events[3].payload["message"]["id"],
        kept.id.to_string()
    );
    assert!(!serde_json::to_string(&replay.events)
        .unwrap()
        .contains(&canary));
    // Positive control: the stored rows still hold the old content; only replay is guarded.
    assert!(mentions(&stored_rows(&pool, hidden.id).await, &canary));
}
