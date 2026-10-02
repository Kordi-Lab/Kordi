//! The content removal worker: stored files, agent run records, and the
//! history backfill job. Object storage is a recording fake.

use std::collections::VecDeque;
use std::sync::Mutex;

use super::content_removal::{direct_chat, photo, send_text, Chat};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::chat_sync::models::MessageSnapshot;
use kordi_cloud_server::chat_sync::removal::{
    purge_attachment, run_jobs, ObjectDeleteError, ObjectStoreDeleter, PurgeOutcome,
};
use serde_json::Value;

/// Records deleted keys; fails the next deletions it is told to fail.
#[derive(Default)]
pub(super) struct FakeObjects {
    deleted: Mutex<Vec<String>>,
    failures: Mutex<VecDeque<ObjectDeleteError>>,
}

impl FakeObjects {
    pub(super) fn failing_once(error: ObjectDeleteError) -> Self {
        let objects = Self::default();
        objects.failures.lock().unwrap().push_back(error);
        objects
    }

    pub(super) fn deleted(&self) -> Vec<String> {
        self.deleted.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl ObjectStoreDeleter for FakeObjects {
    async fn delete_object(&self, object_key: &str) -> Result<(), ObjectDeleteError> {
        if let Some(error) = self.failures.lock().unwrap().pop_front() {
            return Err(error);
        }
        self.deleted.lock().unwrap().push(object_key.to_string());
        Ok(())
    }
}

pub(super) async fn job_ids(pool: &PgPool, message_id: Uuid) -> Vec<Uuid> {
    let rows: Vec<(Uuid,)> = query_as(
        "SELECT job_id FROM cloud_content_removal_jobs WHERE message_id = $1 ORDER BY created_at",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().map(|(id,)| id).collect()
}

/// Runs the jobs until they complete or wait for a retry.
pub(super) async fn settle(pool: &PgPool, objects: &FakeObjects, ids: &[Uuid]) {
    for _ in 0..50 {
        if run_jobs(pool, Some(objects), ids).await.unwrap() == 0 {
            return;
        }
    }
    panic!("removal jobs did not settle");
}

/// (completed, attempts, last error, steps done: digests, records, attachments, quotes)
pub(super) type JobState = (bool, i32, Option<String>, [bool; 4]);

pub(super) async fn job_state(pool: &PgPool, job_id: Uuid) -> JobState {
    let row: (bool, i32, Option<String>, bool, bool, bool, bool) = query_as(
        "SELECT completed_at IS NOT NULL, attempts, last_error_code, digests_done_at IS NOT NULL, \
                records_done_at IS NOT NULL, attachments_done_at IS NOT NULL, \
                quotes_done_at IS NOT NULL \
         FROM cloud_content_removal_jobs WHERE job_id = $1",
    )
    .bind(job_id)
    .fetch_one(pool)
    .await
    .unwrap();
    (row.0, row.1, row.2, [row.3, row.4, row.5, row.6])
}

/// (purge candidate, reads denied, bytes deleted, preview and hash cleared)
pub(super) async fn file_state(pool: &PgPool, attachment_id: &str) -> (bool, bool, bool, bool) {
    query_as(
        "SELECT purge_candidate_at IS NOT NULL, purge_requested_at IS NOT NULL, \
                object_deleted_at IS NOT NULL, preview_url IS NULL AND sha256_hex IS NULL \
         FROM cloud_attachments WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// A finalized photo with a stored preview and hash.
pub(super) async fn stored_photo(pool: &PgPool, owner: &str) -> String {
    let id = photo(pool, owner, "image/png").await;
    query("UPDATE cloud_attachments SET preview_url = 'data:image/png;base64,iVBORw0KGgo=', sha256_hex = 'ab' WHERE attachment_id = $1")
        .bind(&id)
        .execute(pool)
        .await
        .unwrap();
    id
}

/// The owner sends `attachment_ids` with a caption.
pub(super) async fn send_files(
    pool: &PgPool,
    chat: &Chat,
    attachment_ids: &[String],
) -> MessageSnapshot {
    let attachments: Vec<_> = attachment_ids
        .iter()
        .map(|id| json!({"attachmentId": id, "name": "Photo.png", "kind": "image", "mimeType": "image/png", "sizeBytes": 100}))
        .collect();
    let envelope =
        json!({"schemaVersion": 1, "kind": "message", "text": "files", "attachments": attachments});
    let text = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    );
    store::send_message(
        pool,
        &chat.owner,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": attachments}),
            reply_to_message_id: None,
            attachment_ids: attachment_ids.to_vec(),
        },
    )
    .await
    .expect("send files")
    .value
}

pub(super) async fn delete_for_everyone(pool: &PgPool, chat: &Chat, message: &MessageSnapshot) {
    store::delete_message(pool, &chat.owner, chat.conversation_id, message.id, true)
        .await
        .expect("delete for everyone");
}

#[tokio::test]
async fn shared_files_are_kept_until_the_last_message_is_deleted() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "worker-shared-file").await;
    let file = stored_photo(&pool, &chat.owner).await;
    let first = send_files(&pool, &chat, std::slice::from_ref(&file)).await;
    let second = send_files(&pool, &chat, std::slice::from_ref(&file)).await;
    let objects = FakeObjects::default();

    delete_for_everyone(&pool, &chat, &first).await;
    let first_jobs = job_ids(&pool, first.id).await;
    settle(&pool, &objects, &first_jobs).await;
    let (completed, attempts, error, steps) = job_state(&pool, first_jobs[0]).await;
    assert!(completed && attempts == 0 && error.is_none() && steps == [true; 4]);
    assert_eq!(file_state(&pool, &file).await, (true, false, false, false));
    assert!(objects.deleted().is_empty(), "a file still in use is kept");

    delete_for_everyone(&pool, &chat, &second).await;
    let second_jobs = job_ids(&pool, second.id).await;
    settle(&pool, &objects, &second_jobs).await;
    assert!(job_state(&pool, second_jobs[0]).await.0);
    assert_eq!(file_state(&pool, &file).await, (false, true, true, true));
    assert_eq!(objects.deleted(), vec![file.clone()]);
    // A completed job is not run again, and a finished purge is idempotent.
    assert_eq!(
        run_jobs(&pool, Some(&objects), &second_jobs).await.unwrap(),
        0
    );
    assert_eq!(
        purge_attachment(&pool, &objects, &file).await,
        Ok(PurgeOutcome::AlreadyGone)
    );
    assert_eq!(objects.deleted().len(), 1);
}

#[tokio::test]
async fn an_agent_run_artifact_of_a_live_message_keeps_its_file() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "worker-run-artifact").await;
    let file = stored_photo(&pool, &chat.owner).await;
    let request = send_files(&pool, &chat, std::slice::from_ref(&file)).await;
    let response = send_text(&pool, &chat, "agent response").await;
    let now = chrono::Utc::now().to_rfc3339();
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let sandbox_id = format!("sandbox_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_agent_sandboxes(sandbox_id,owner_account_id,session_id,scope,status,workspace_key,storage_bytes_quota,created_at,last_active_at,expires_at) VALUES($1,$2,$3,'shared_session','active',$1,0,$4,$4,$4)")
        .bind(&sandbox_id).bind(&chat.owner).bind(&chat.session_id).bind(&now)
        .execute(&pool).await.unwrap();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$2,$3,$4,$4,'completed','',$5,$5)")
        .bind(&run_id).bind(request.id.to_string()).bind(&chat.session_id).bind(&chat.owner).bind(&now)
        .execute(&pool).await.unwrap();
    query("INSERT INTO cloud_agent_run_artifacts(artifact_id,run_id,sandbox_id,attachment_id,message_id,sandbox_path,name,content_type,size_bytes,created_at) VALUES($1,$2,$3,$4,$5,'out.png','out.png','image/png',100,$6)")
        .bind(format!("carartifact_{}", Uuid::new_v4().simple())).bind(&run_id).bind(&sandbox_id)
        .bind(&file).bind(response.id).bind(&now)
        .execute(&pool).await.unwrap();
    let objects = FakeObjects::default();

    delete_for_everyone(&pool, &chat, &request).await;
    settle(&pool, &objects, &job_ids(&pool, request.id).await).await;
    assert_eq!(file_state(&pool, &file).await, (true, false, false, false));
    assert!(objects.deleted().is_empty());

    // Once the response that carries the artifact is deleted, nothing keeps it.
    delete_for_everyone(&pool, &chat, &response).await;
    assert_eq!(
        purge_attachment(&pool, &objects, &file).await,
        Ok(PurgeOutcome::Purged)
    );
    assert_eq!(objects.deleted(), vec![file.clone()]);
}

#[tokio::test]
async fn a_failed_deletion_keeps_reads_denied_and_retries() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "worker-retry").await;
    let file = stored_photo(&pool, &chat.owner).await;
    let message = send_files(&pool, &chat, std::slice::from_ref(&file)).await;
    let objects = FakeObjects::failing_once(ObjectDeleteError::Failed);
    delete_for_everyone(&pool, &chat, &message).await;
    let ids = job_ids(&pool, message.id).await;

    settle(&pool, &objects, &ids).await;
    let (completed, attempts, error, steps) = job_state(&pool, ids[0]).await;
    assert!(!completed);
    assert_eq!(
        (attempts, error.as_deref()),
        (1, Some("object_store_error"))
    );
    assert_eq!(steps, [true, true, false, true], "the other steps finished");
    assert_eq!(file_state(&pool, &file).await, (false, true, false, true));
    let (due,): (bool,) = query_as(
        "SELECT next_attempt_at > now() + interval '20 seconds' FROM cloud_content_removal_jobs WHERE job_id = $1",
    )
    .bind(ids[0])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(due, "the retry waits for the backoff");
    // The file cannot be linked again while it waits.
    let relinked = store::send_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".into(),
            content: content("again"),
            reply_to_message_id: None,
            attachment_ids: vec![file.clone()],
        },
    )
    .await;
    assert!(matches!(relinked, Err(StoreError::InvalidInput(_))));

    query("UPDATE cloud_content_removal_jobs SET next_attempt_at = now() WHERE job_id = $1")
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
    settle(&pool, &objects, &ids).await;
    let (completed, attempts, error, steps) = job_state(&pool, ids[0]).await;
    assert!(completed && attempts == 1 && error.is_none() && steps == [true; 4]);
    assert_eq!(file_state(&pool, &file).await, (false, true, true, true));
    assert_eq!(objects.deleted(), vec![file]);
}

#[tokio::test]
async fn without_object_storage_files_wait_and_nothing_is_marked_deleted() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "worker-no-storage").await;
    let file = stored_photo(&pool, &chat.owner).await;
    let message = send_files(&pool, &chat, std::slice::from_ref(&file)).await;
    delete_for_everyone(&pool, &chat, &message).await;
    let ids = job_ids(&pool, message.id).await;
    assert_eq!(run_jobs(&pool, None, &ids).await.unwrap(), 1);
    let (completed, attempts, error, steps) = job_state(&pool, ids[0]).await;
    assert!(!completed && attempts == 1);
    assert_eq!(error.as_deref(), Some("object_store_unavailable"));
    assert_eq!(steps, [true, true, false, true]);
    assert_eq!(file_state(&pool, &file).await, (false, false, false, false));
}

/// A run of `owner`'s agent; each request has one current run per agent.
async fn insert_run(
    pool: &PgPool,
    chat: &Chat,
    owner: &str,
    request_id: &str,
    status: &str,
) -> String {
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,lease_expires_at) VALUES($1,$1,$2,$3,$4,$4,$5,'Summarize the request',$6,$6,$7)")
        .bind(&run_id).bind(request_id).bind(&chat.session_id).bind(owner).bind(status)
        .bind(now.to_rfc3339()).bind((now + chrono::Duration::minutes(5)).to_rfc3339())
        .execute(pool).await.unwrap();
    run_id
}

async fn run_state(pool: &PgPool, run_id: &str) -> (String, String) {
    query_as("SELECT status, prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
        .bind(run_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn events_of_type(pool: &PgPool, account_id: &str, event_type: &str) -> Vec<Value> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = $2 ORDER BY stream_seq",
    )
    .bind(account_id)
    .bind(event_type)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().map(|(payload,)| payload).collect()
}

#[tokio::test]
async fn records_of_a_deleted_request_are_cleared() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "worker-records").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let request = send_text(&pool, &chat, &format!("@Kordi {canary}")).await;
    let request_id = request.id.to_string();
    let finished = insert_run(&pool, &chat, &chat.owner, &request_id, "completed").await;
    let running = insert_run(&pool, &chat, &chat.peer, &request_id, "running").await;
    let now = chrono::Utc::now().to_rfc3339();
    let task_id = format!("task-{}", Uuid::new_v4());
    query("INSERT INTO cloud_session_tasks(task_activity_id,session_id,task_id,title,summary,status,created_by_account_id,participants_json,response_message_id,created_at,updated_at) VALUES($1,$2,$3,'Task',$4,'done',$5,'[]'::jsonb,$6,$7,$7)")
        .bind(format!("taskact_{}", Uuid::new_v4().simple())).bind(&chat.session_id).bind(&task_id)
        .bind(&canary).bind(&chat.owner).bind(format!("collaboration-message:{request_id}")).bind(&now)
        .execute(&pool).await.unwrap();
    let artifact_id = format!("docs/{}.md", Uuid::new_v4());
    query("INSERT INTO cloud_session_artifacts(artifact_activity_id,session_id,artifact_id,name,path,kind,category,created_by_account_id,source_message_id,created_at,updated_at) VALUES($1,$2,$3,'plan.md',$3,'document','artifact',$4,$5,$6,$6)")
        .bind(format!("artifactact_{}", Uuid::new_v4().simple())).bind(&chat.session_id).bind(&artifact_id)
        .bind(&chat.owner).bind(&request_id).bind(&now)
        .execute(&pool).await.unwrap();
    let objects = FakeObjects::default();

    delete_for_everyone(&pool, &chat, &request).await;
    // A claim that raced the delete leaves a queued run behind.
    let other = account(&pool, "worker-records-other").await;
    let raced = insert_run(&pool, &chat, &other, &request_id, "queued").await;
    let ids = job_ids(&pool, request.id).await;
    assert_eq!(run_jobs(&pool, Some(&objects), &ids).await.unwrap(), 1);
    assert_eq!(
        run_state(&pool, &finished).await,
        ("completed".into(), String::new())
    );
    assert_eq!(
        run_state(&pool, &raced).await,
        ("cancelled".into(), String::new())
    );
    assert_eq!(run_state(&pool, &running).await.0, "running");
    let (completed, _, _, steps) = job_state(&pool, ids[0]).await;
    assert!(
        !completed && !steps[1],
        "the run in progress keeps the step open"
    );
    let (wait,): (f64,) = query_as(
        "SELECT EXTRACT(EPOCH FROM next_attempt_at - now())::float8 \
         FROM cloud_content_removal_jobs WHERE job_id = $1",
    )
    .bind(ids[0])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!((30.0..=60.0).contains(&wait), "waits a minute, not {wait}");

    let (summary, archived): (Option<String>, Option<String>) = query_as(
        "SELECT task.summary, artifact.archived_at FROM cloud_session_tasks task, cloud_session_artifacts artifact \
         WHERE task.task_id = $1 AND artifact.artifact_id = $2",
    )
    .bind(&task_id)
    .bind(&artifact_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(summary.is_none() && archived.is_some());
    for account in [&chat.owner, &chat.peer] {
        let tasks = events_of_type(&pool, account, "task.upsert").await;
        assert!(tasks
            .iter()
            .any(|payload| payload["task"]["taskId"] == task_id.as_str()
                && payload["task"]["summary"].is_null()));
        let artifacts = events_of_type(&pool, account, "artifact.archived").await;
        assert!(artifacts
            .iter()
            .any(
                |payload| payload["artifact"]["artifactId"] == artifact_id.as_str()
                    && payload["artifact"]["archivedAt"].is_string()
            ));
    }

    // When the run in progress ends, its prompt is cleared at the next check.
    query("UPDATE cloud_agent_fallback_runs SET status = 'completed' WHERE run_id = $1")
        .bind(&running)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_content_removal_jobs SET next_attempt_at = now() WHERE job_id = $1")
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
    settle(&pool, &objects, &ids).await;
    assert_eq!(
        run_state(&pool, &running).await,
        ("completed".into(), String::new())
    );
    assert!(job_state(&pool, ids[0]).await.0);
}

#[tokio::test]
async fn the_backfill_job_reconciles_then_repairs_digests_once() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "worker-backfill").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let message = send_text(&pool, &chat, &canary).await;
    // An older server deleted the message without rewriting or queueing.
    query("UPDATE cloud_chat_messages SET content='{\"schema\":1,\"blocks\":[]}'::jsonb, version=version+1, deleted_at=now() WHERE message_id=$1")
        .bind(message.id).execute(&pool).await.unwrap();
    let id = message.id.to_string();
    query("INSERT INTO cloud_account_digests(account_id,snapshot_json,snapshot_input_json,revision) VALUES($1,$2,$3,1)")
        .bind(&chat.peer)
        .bind(json!({"claims": [{"id": "c1", "title": "Cites it", "sourceIds": [id]}], "commitments": [], "suggestions": [], "calendarCandidates": []}))
        .bind(json!({"sources": [{"id": id, "text": canary, "version": 1}]}))
        .execute(&pool).await.unwrap();
    let backfill = Uuid::now_v7();
    query("INSERT INTO cloud_content_removal_jobs(job_id,reason,attachments_done_at,quotes_done_at) VALUES($1,'backfill',now(),now())")
        .bind(backfill).execute(&pool).await.unwrap();
    let objects = FakeObjects::default();

    settle(&pool, &objects, &[backfill]).await;
    assert!(job_state(&pool, backfill).await.0);
    let message_jobs = job_ids(&pool, message.id).await;
    assert_eq!(
        message_jobs.len(),
        1,
        "reconcile queued the deleted message"
    );
    let (snapshot, saved, revision): (Value, Value, i64) = query_as(
        "SELECT snapshot_json, snapshot_input_json, revision FROM cloud_account_digests WHERE account_id = $1",
    )
    .bind(&chat.peer)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(snapshot["claims"], json!([]));
    assert!(!saved.to_string().contains(&canary) && revision == 2);

    // A second backfill finds nothing more to do.
    let again = Uuid::now_v7();
    query("INSERT INTO cloud_content_removal_jobs(job_id,reason,attachments_done_at,quotes_done_at) VALUES($1,'backfill',now(),now())")
        .bind(again).execute(&pool).await.unwrap();
    settle(&pool, &objects, &[again]).await;
    assert!(job_state(&pool, again).await.0);
    assert_eq!(job_ids(&pool, message.id).await, message_jobs);
    let (revision,): (i64,) =
        query_as("SELECT revision FROM cloud_account_digests WHERE account_id = $1")
            .bind(&chat.peer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(revision, 2);
}
