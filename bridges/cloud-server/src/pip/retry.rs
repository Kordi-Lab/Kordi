//! Failed and abandoned PiP runs: bounded backoff, and a retry from the
//! messages the failed run started at.

use chrono::Utc;
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

/// Retry schedule after a failed run, indexed by consecutive failures.
/// Bounded on purpose: the digest worker's fixed 30 s retry turned one bad
/// provider response into thousands of calls a day.
pub fn backoff_seconds(attempts: i32) -> i64 {
    match attempts.max(1) {
        1 => 60,
        2 => 300,
        3 => 1_800,
        4 => 7_200,
        _ => 43_200,
    }
}

/// The message cursor a failed run should be retried from: the sequence its
/// `new_messages` hook started at, so the same snapshot is swept again after
/// the backoff instead of being skipped.
pub fn retry_sequence(prompt: &str) -> Option<i64> {
    let input: Value = serde_json::from_str(prompt).ok()?;
    input
        .get("hooks")?
        .as_array()?
        .iter()
        .filter(|hook| hook.get("name").and_then(Value::as_str) == Some("new_messages"))
        .find_map(|hook| hook.get("sinceSequence").and_then(Value::as_i64))
}

/// Records a failed run and schedules the next attempt with bounded backoff.
/// The message cursor rolls back to where the failed run started so the
/// retry sees the same messages; reminders that were offered are not marked
/// as fired.
pub async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    error_code: &str,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let changed = query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'failed', error_code = $3, error_message = 'PiP could not finish this pass.',
             updated_at = $4
         WHERE run_id = $1 AND ($2::text IS NULL OR claimed_by = $2)
           AND status IN ('queued', 'leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(error_code)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() > 0 {
        let state: Option<(i32, String)> = query_as(
            "SELECT state.attempts + 1, run.prompt
             FROM cloud_pip_conversation_state state
             JOIN cloud_agent_fallback_runs run ON run.run_id = state.active_run_id
             WHERE state.active_run_id = $1",
        )
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?;
        let (attempts, prompt) = state.unwrap_or((1, String::new()));
        let retry_from = retry_sequence(&prompt);
        query(
            "UPDATE cloud_pip_conversation_state
             SET active_run_id = NULL, attempts = $2, last_error = $3,
                 retry_after = now() + ($4 * interval '1 second'),
                 seen_sequence = COALESCE(LEAST(seen_sequence, $5), seen_sequence),
                 updated_at = now()
             WHERE active_run_id = $1",
        )
        .bind(run_id)
        .bind(attempts)
        .bind(error_code)
        .bind(backoff_seconds(attempts) as f64)
        .bind(retry_from)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Releases conversations whose run can no longer finish: its lease expired
/// long ago, or the run already ended or vanished without clearing the
/// reservation. Either way the conversation can be swept again.
pub async fn release_stale_runs(pool: &PgPool) -> Result<u64, sqlx_core::Error> {
    let stale: Vec<(String, bool)> = query_as(
        "SELECT state.active_run_id, run.run_id IS NULL OR run.status NOT IN ('queued', 'leased', 'running')
         FROM cloud_pip_conversation_state state
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
                "UPDATE cloud_pip_conversation_state SET active_run_id = NULL, updated_at = now()
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
    use serde_json::json;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff_seconds(0), 60);
        assert_eq!(backoff_seconds(1), 60);
        assert_eq!(backoff_seconds(2), 300);
        assert_eq!(backoff_seconds(3), 1_800);
        assert_eq!(backoff_seconds(4), 7_200);
        assert_eq!(backoff_seconds(5), 43_200);
        assert_eq!(backoff_seconds(50), 43_200);
    }

    #[test]
    fn failed_runs_retry_from_the_hook_sequence() {
        let prompt = json!({"hooks": [{"name": "t_minus_24h", "key": "t_minus_24h:e1"}, {"name": "new_messages", "sinceSequence": 7}]}).to_string();
        assert_eq!(retry_sequence(&prompt), Some(7));
        let reminder_only =
            json!({"hooks": [{"name": "t_minus_2h", "key": "t_minus_2h:e1"}]}).to_string();
        assert_eq!(retry_sequence(&reminder_only), None);
        assert_eq!(retry_sequence("not json"), None);
    }
}
