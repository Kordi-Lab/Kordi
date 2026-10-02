//! Removal jobs finish when nothing real is left to wait for: agent runs
//! without a live lease never hold a job open, and a job with no files needs
//! no object storage.

use super::content_removal::{direct_chat, send_text, Chat};
use super::content_removal_worker::{job_ids, job_state, FakeObjects};
use super::*;
use kordi_cloud_server::chat_sync::removal::run_jobs;

/// A run for `request_id` with the given status and lease, under its own
/// agent id so several runs may share a request.
async fn insert_run(
    pool: &PgPool,
    chat: &Chat,
    request_id: &str,
    status: &str,
    lease_expires_at: Option<chrono::DateTime<chrono::Utc>>,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,lease_expires_at,execution_agent_id) VALUES($1,$1,$2,$3,$4,$4,$5,'Summarize the request',$6,$6,$7,$1)")
        .bind(&run_id).bind(request_id).bind(&chat.session_id).bind(&chat.owner).bind(status)
        .bind(&now).bind(lease_expires_at.map(|at| at.to_rfc3339()))
        .execute(pool).await.expect("insert run");
    run_id
}

async fn run_state(pool: &PgPool, run_id: &str) -> (String, String, Option<String>) {
    query_as("SELECT status, prompt, error_code FROM cloud_agent_fallback_runs WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn runs_without_a_live_lease_never_hold_a_deleted_request_open() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "progress-leases").await;
    let request = send_text(&pool, &chat, "@Kordi summarize").await;
    let request_id = request.id.to_string();
    let now = chrono::Utc::now();
    // Left active without a lease: no runner reclaims it, so it never ends.
    let unleased = insert_run(&pool, &chat, &request_id, "running", None).await;
    // Its lease expired: a runner would pick it up again.
    let expired = insert_run(
        &pool,
        &chat,
        &request_id,
        "leased",
        Some(now - chrono::Duration::minutes(5)),
    )
    .await;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, request.id, true)
        .await
        .unwrap();
    let ids = job_ids(&pool, request.id).await;
    assert_eq!(
        run_jobs(&pool, Some(&FakeObjects::default()), &ids)
            .await
            .unwrap(),
        1
    );
    let (completed, attempts, error, steps) = job_state(&pool, ids[0]).await;
    assert!(completed && attempts == 0 && error.is_none() && steps == [true; 4]);
    assert_eq!(
        run_state(&pool, &unleased).await,
        ("running".into(), String::new(), None)
    );
    assert_eq!(
        run_state(&pool, &expired).await,
        (
            "cancelled".into(),
            String::new(),
            Some("request_deleted".into())
        )
    );

    // Positive control: a run under a live lease keeps the job waiting.
    let live_request = send_text(&pool, &chat, "@Kordi summarize again").await;
    let working = insert_run(
        &pool,
        &chat,
        &live_request.id.to_string(),
        "running",
        Some(now + chrono::Duration::minutes(5)),
    )
    .await;
    store::delete_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        live_request.id,
        true,
    )
    .await
    .unwrap();
    let ids = job_ids(&pool, live_request.id).await;
    run_jobs(&pool, Some(&FakeObjects::default()), &ids)
        .await
        .unwrap();
    assert!(!job_state(&pool, ids[0]).await.0);
    assert_eq!(
        run_state(&pool, &working).await,
        ("running".into(), "Summarize the request".into(), None)
    );
    // Not due again until the wait passes.
    assert_eq!(
        run_jobs(&pool, Some(&FakeObjects::default()), &ids)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn a_deletion_without_files_finishes_without_object_storage() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "progress-no-files").await;
    let message = send_text(&pool, &chat, "no files here").await;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, message.id, true)
        .await
        .unwrap();
    let ids = job_ids(&pool, message.id).await;
    // The file step is already done when the job is queued.
    assert!(job_state(&pool, ids[0]).await.3[2]);
    assert_eq!(run_jobs(&pool, None, &ids).await.unwrap(), 1);
    let (completed, attempts, error, _) = job_state(&pool, ids[0]).await;
    assert!(completed && attempts == 0 && error.is_none());

    // A job queued by an earlier version with the file step pending, but no
    // files, also finishes without object storage.
    let older = send_text(&pool, &chat, "queued earlier").await;
    store::delete_message(&pool, &chat.owner, chat.conversation_id, older.id, true)
        .await
        .unwrap();
    let ids = job_ids(&pool, older.id).await;
    query("UPDATE cloud_content_removal_jobs SET attachments_done_at = NULL WHERE job_id = $1")
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(run_jobs(&pool, None, &ids).await.unwrap(), 1);
    let (completed, attempts, error, steps) = job_state(&pool, ids[0]).await;
    assert!(completed && attempts == 0 && error.is_none() && steps == [true; 4]);
}
