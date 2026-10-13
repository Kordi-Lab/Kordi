//! Where a comment run's answer goes: a reply comment in the thread, written
//! by the agent. Never a chat message.
//!
//! The run completion and failure paths call in here first; a run whose
//! `request_message_id` starts with `doccmt:` ends here and the chat
//! delivery after it never runs. The reply comment's id is stored in the
//! run's `response_message_id`.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::super::access::canonical_record;
use super::super::events::{publish_document_updated, DocumentChange};
use super::super::validate::MAX_COMMENT_CHARS;
use super::{comment_id_of_request, is_comment_request, AGENT_NAME_SQL};
use crate::cloud_agent_runtime::runs::{RunError, RunResult};

/// The body of an agent's reply: the response text, cut to the comment limit.
pub(crate) fn reply_body(response_text: &str) -> String {
    let trimmed = response_text.trim();
    if trimmed.chars().count() <= MAX_COMMENT_CHARS {
        return trimmed.to_string();
    }
    let mut body: String = trimmed.chars().take(MAX_COMMENT_CHARS - 3).collect();
    body.push_str("...");
    body
}

/// The system reply that ends the "is working" state of a failed run.
pub(crate) fn failure_body(agent_name: &str) -> String {
    let name: String = agent_name.trim().chars().take(120).collect();
    let name = if name.is_empty() { "The agent" } else { &name };
    format!("{name} could not answer.")
}

enum Outcome<'a> {
    Completed(&'a str),
    Failed { code: &'a str, message: &'a str },
}

async fn request_id(pool: &PgPool, run_id: &str) -> RunResult<Option<String>> {
    let row: Option<(String,)> =
        query_as("SELECT request_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(run_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id,)| id).filter(|id| is_comment_request(id)))
}

/// Writes the reply in the mentioning comment's thread and returns its id
/// and the document. `None` when the comment is gone.
async fn insert_reply(
    tx: &mut Transaction<'_, Postgres>,
    comment_id: &str,
    agent_id: &str,
    agent_name: &str,
    body: &str,
) -> Result<Option<(String, String)>, sqlx_core::Error> {
    let comment: Option<(String, String, Option<String>)> = query_as(
        "SELECT attachment_id, block_id, parent_comment_id FROM cloud_document_comments \
         WHERE comment_id = $1 AND deleted_at IS NULL",
    )
    .bind(comment_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((attachment_id, block_id, parent)) = comment else {
        return Ok(None);
    };
    let reply_id = format!("doccmt_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_document_comments \
         (comment_id, attachment_id, block_id, parent_comment_id, author_agent_id, \
          author_agent_name, author_name, body, mentions_agent, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, FALSE, $8)",
    )
    .bind(&reply_id)
    .bind(&attachment_id)
    .bind(&block_id)
    .bind(parent.as_deref().unwrap_or(comment_id))
    .bind(agent_id)
    .bind(agent_name)
    .bind(body)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(Some((reply_id, attachment_id)))
}

async fn finish(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    outcome: Outcome<'_>,
) -> RunResult<bool> {
    let Some(request_id) = request_id(pool, run_id).await? else {
        return Ok(false);
    };
    let mut tx = pool.begin().await?;
    let run: Option<(String, String)> = query_as(&format!(
        "SELECT run.execution_agent_id, {AGENT_NAME_SQL} \
         FROM cloud_agent_fallback_runs run \
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.execution_backend = 'cloud' \
           AND run.status IN ('leased', 'running') \
           AND run.lease_expires_at::timestamptz > now() FOR UPDATE OF run"
    ))
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (agent_id, agent_name) = run.ok_or(RunError::NotFound)?;
    let (body, status, error) = match outcome {
        Outcome::Completed(text) => (reply_body(text), "completed", None),
        Outcome::Failed { code, message } => {
            (failure_body(&agent_name), "failed", Some((code, message)))
        }
    };
    let reply = match comment_id_of_request(&request_id) {
        Some(comment_id) => {
            insert_reply(&mut tx, comment_id, &agent_id, &agent_name, &body).await?
        }
        None => None,
    };
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = $2, response_message_id = $3, error_code = $4, error_message = $5, \
             updated_at = $6, completed_at = $6 \
         WHERE run_id = $1",
    )
    .bind(run_id)
    .bind(status)
    .bind(reply.as_ref().map(|(reply_id, _)| reply_id.as_str()))
    .bind(error.map(|(code, _)| code))
    .bind(error.map(|(_, message)| message))
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Some((_, attachment_id)) = reply {
        match canonical_record(pool, &attachment_id).await {
            Ok(Some(record)) => {
                publish_document_updated(pool, &record, None, DocumentChange::Annotations, None)
                    .await;
            }
            Ok(None) => {}
            Err(_) => eprintln!("[documents] agent reply for {run_id}: document lookup failed"),
        }
    }
    Ok(true)
}

/// Completes a comment run: the response text becomes the agent's reply in
/// the thread and `document.updated` (annotations) is published. Returns
/// false for any other run, which then takes the chat path.
pub(crate) async fn complete_comment_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> RunResult<bool> {
    if request_id(pool, run_id).await?.is_none() {
        return Ok(false);
    }
    if response_text.trim().is_empty() {
        return Err(RunError::NotFound);
    }
    finish(pool, run_id, runner_id, Outcome::Completed(response_text)).await
}

/// Fails a comment run: the thread gets the short system reply. Returns
/// false for any other run.
pub(crate) async fn fail_comment_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    error_code: &str,
    message: &str,
) -> RunResult<bool> {
    let outcome = Outcome::Failed {
        code: error_code,
        message,
    };
    finish(pool, run_id, runner_id, outcome).await
}
