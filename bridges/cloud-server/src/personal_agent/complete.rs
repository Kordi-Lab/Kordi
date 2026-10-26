//! Finished and failed evaluation runs. `skip` only moves the cursor; `share`
//! posts one agent message in the personal session, logs it, moves the
//! cursor and starts the cooldown in the same transaction, and pushes it to
//! the owner's devices after commit.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::config::{backoff_seconds, PersonalAgentConfig, MAX_ATTEMPTS};
use super::output::{parse, Decision, Share};
use super::snapshot;
use crate::chat_sync::models::SendMessageRequest;

const RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

struct EvaluationRun {
    agent_id: String,
    owner_account_id: String,
    snapshot: Value,
}

async fn leased_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<EvaluationRun>, sqlx_core::Error> {
    let row: Option<(String, String, String)> = query_as(
        "SELECT execution_agent_id, owner_account_id, prompt FROM cloud_agent_fallback_runs
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(
        row.map(|(agent_id, owner_account_id, prompt)| EvaluationRun {
            agent_id,
            owner_account_id,
            snapshot: serde_json::from_str(&prompt).unwrap_or(Value::Null),
        }),
    )
}

/// The `agent-response` body of a message the agent posts on its own, with
/// the events it is about as `sources`. `agentId` and `agentName` name the
/// writer for clients and the push title.
pub(super) fn response_body(run_id: &str, text: &str, sources: &[Value], agent: &Value) -> String {
    let envelope = json!({
        "kind": "agent-response",
        "requestId": run_id,
        "text": text,
        "deliveryState": "complete",
        "sources": sources,
        "agentId": agent["agentId"],
        "agentName": agent["name"],
    });
    format!(
        "{RESPONSE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

/// Records a finished evaluation. Nothing is posted unless the run is still
/// the agent's active evaluation: turning the setting off or archiving the
/// agent clears it.
pub async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<(), sqlx_core::Error> {
    let Some(run) = leased_run(pool, run_id, runner_id).await? else {
        return Ok(());
    };
    let decision = parse(response_text, &snapshot::event_ids(&run.snapshot));
    // Operators can tell a skip from a reply that did not parse; the text
    // itself stays out of the log.
    let trimmed = response_text.trim();
    eprintln!(
        "[personal_agent] evaluation {run_id}: {} (reply {} chars, json={})",
        match &decision {
            Decision::Skip => "skip",
            Decision::Share(_) => "share",
        },
        trimmed.chars().count(),
        serde_json::from_str::<Value>(trimmed).is_ok()
    );
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let finished = query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'completed', error_code = NULL, error_message = NULL,
             updated_at = $3, completed_at = $3
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    if finished.rows_affected() == 0 {
        return Ok(());
    }
    let active: Option<(Option<DateTime<Utc>>,)> = query_as(
        "SELECT run_cursor_received_at FROM cloud_personal_agent_state
         WHERE agent_id = $1 AND owner_account_id = $2 AND active_run_id = $3 FOR UPDATE",
    )
    .bind(&run.agent_id)
    .bind(&run.owner_account_id)
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((run_cursor,)) = active else {
        return tx.commit().await;
    };
    let posted = match &decision {
        Decision::Share(share) => deliver(&mut tx, run_id, &run, share).await?,
        Decision::Skip => None,
    };
    query(
        "UPDATE cloud_personal_agent_state
         SET active_run_id = NULL, run_cursor_received_at = NULL, attempts = 0, last_error = NULL,
             cursor_received_at = GREATEST(cursor_received_at, COALESCE($2, cursor_received_at)),
             cooldown_until = CASE WHEN $3 THEN now() + make_interval(secs => $4)
                              ELSE cooldown_until END,
             updated_at = now()
         WHERE agent_id = $1",
    )
    .bind(&run.agent_id)
    .bind(run_cursor)
    .bind(posted.is_some())
    .bind(PersonalAgentConfig::from_env().cooldown_seconds as f64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Some(message_id) = posted {
        super::push::message(pool, message_id);
    }
    Ok(())
}

/// Posts the share in the agent's personal session as the agent and logs it.
/// Returns the message id, or `None` when the agent has no session.
async fn deliver(
    tx: &mut Transaction<'_, Postgres>,
    run_id: &str,
    run: &EvaluationRun,
    share: &Share,
) -> Result<Option<Uuid>, sqlx_core::Error> {
    let session: Option<(Uuid,)> = query_as(
        "SELECT conversation_id FROM cloud_personal_agent_sessions
         WHERE agent_id = $1 AND owner_account_id = $2",
    )
    .bind(&run.agent_id)
    .bind(&run.owner_account_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((conversation_id,)) = session else {
        return Ok(None);
    };
    let sources: Vec<Value> = share
        .event_ids
        .iter()
        .filter_map(|event_id| snapshot::source(&run.snapshot, event_id))
        .collect();
    let body = response_body(run_id, &share.message, &sources, &run.snapshot["agent"]);
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, format!("{run_id}:share").as_bytes()),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": body}]}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let message = crate::chat_sync::store::send_message_in_transaction(
        tx,
        &run.owner_account_id,
        conversation_id,
        request,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(format!("personal agent message: {error}")))?;
    let message_id = message.value.id;
    query(
        "INSERT INTO cloud_personal_agent_messages
             (run_id, agent_id, owner_account_id, message_id, text, event_ids)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id) DO NOTHING",
    )
    .bind(run_id)
    .bind(&run.agent_id)
    .bind(&run.owner_account_id)
    .bind(message_id)
    .bind(&share.message)
    .bind(&share.event_ids)
    .execute(&mut **tx)
    .await?;
    Ok(Some(message_id))
}

/// Records a failed evaluation and schedules the next look with bounded
/// backoff from the same cursor. After [`MAX_ATTEMPTS`] failures in a row
/// the evaluation's events are skipped.
pub async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    error_code: &str,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let failed = query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'failed', error_code = $3,
             error_message = 'The personal agent check could not finish.',
             updated_at = $4, completed_at = $4
         WHERE run_id = $1 AND ($2::text IS NULL OR claimed_by = $2)
           AND status IN ('queued', 'leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(error_code)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    if failed.rows_affected() == 0 {
        return tx.commit().await;
    }
    let row: Option<(String, i32)> = query_as(
        "SELECT agent_id, attempts + 1 FROM cloud_personal_agent_state
         WHERE active_run_id = $1 FOR UPDATE",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((agent_id, attempts)) = row {
        let give_up = attempts >= MAX_ATTEMPTS;
        if give_up {
            eprintln!(
                "[personal_agent] Giving up on the events of agent {agent_id} after {attempts} failed evaluations ({error_code})"
            );
        }
        query(
            "UPDATE cloud_personal_agent_state
             SET active_run_id = NULL, last_error = $2,
                 attempts = CASE WHEN $3 THEN 0 ELSE $4 END,
                 cursor_received_at = CASE WHEN $3
                   THEN GREATEST(cursor_received_at, COALESCE(run_cursor_received_at, cursor_received_at))
                   ELSE cursor_received_at END,
                 run_cursor_received_at = NULL,
                 retry_after = now() + make_interval(secs => $5), updated_at = now()
             WHERE active_run_id = $1",
        )
        .bind(run_id)
        .bind(error_code)
        .bind(give_up)
        .bind(attempts)
        .bind(if give_up {
            0.0
        } else {
            backoff_seconds(attempts) as f64
        })
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Frees agents whose evaluation can no longer finish: it ended or vanished
/// without clearing the reservation, or its lease expired long ago.
pub async fn release_stale_runs(pool: &PgPool) -> Result<u64, sqlx_core::Error> {
    let stale: Vec<(String, bool)> = query_as(
        "SELECT state.active_run_id,
                run.run_id IS NULL OR run.status NOT IN ('queued', 'leased', 'running')
         FROM cloud_personal_agent_state state
         LEFT JOIN cloud_agent_fallback_runs run ON run.run_id = state.active_run_id
         WHERE state.active_run_id IS NOT NULL
           AND (run.run_id IS NULL
             OR run.status NOT IN ('queued', 'leased', 'running')
             OR (run.status IN ('leased', 'running')
                 AND run.lease_expires_at IS NOT NULL
                 AND run.lease_expires_at::timestamptz < now() - interval '10 minutes'))",
    )
    .fetch_all(pool)
    .await?;
    let mut released = 0;
    for (run_id, ended) in stale {
        if ended {
            query(
                "UPDATE cloud_personal_agent_state
                 SET active_run_id = NULL, run_cursor_received_at = NULL, updated_at = now()
                 WHERE active_run_id = $1",
            )
            .bind(&run_id)
            .execute(pool)
            .await?;
        } else {
            fail(pool, &run_id, None, "lease_expired").await?;
        }
        released += 1;
    }
    Ok(released)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_is_an_agent_response_with_sources() {
        let sources = vec![json!({"eventId": "cnevt_a", "provider": "gmail", "title": "Sam"})];
        let agent = json!({"agentId": "cloud_agent_x", "name": "Scout"});
        let body = response_body("personal_agent_eval_1", "Sam wrote.", &sources, &agent);
        let encoded = body.strip_prefix(RESPONSE_PREFIX).expect("prefix");
        let envelope: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        assert_eq!(
            envelope,
            json!({
                "kind": "agent-response", "requestId": "personal_agent_eval_1",
                "text": "Sam wrote.", "deliveryState": "complete", "sources": sources,
                "agentId": "cloud_agent_x", "agentName": "Scout",
            })
        );
    }
}
