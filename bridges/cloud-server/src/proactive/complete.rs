//! Finished and failed evaluation runs. Silence writes nothing but the run's
//! own status; an offer becomes a proposal and a card for the owner.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::config::{ProactiveConfig, PROPOSAL_LIFETIME_HOURS};
use super::output::{parse, Decision, Offer};
use super::snapshot::trigger_message;

/// Retry schedule after a failed evaluation, by consecutive failures.
pub(super) fn backoff_seconds(attempts: i32) -> i64 {
    match attempts.max(1) {
        1 => 60,
        2 => 300,
        3 => 1_800,
        4 => 7_200,
        _ => 43_200,
    }
}

struct EvaluationRun {
    agent_id: String,
    owner_account_id: String,
    session_id: String,
    snapshot: Value,
}

async fn leased_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<EvaluationRun>, sqlx_core::Error> {
    let row: Option<(String, String, String, String)> = query_as(
        "SELECT execution_agent_id, owner_account_id, session_id, prompt
         FROM cloud_agent_fallback_runs
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(agent_id, owner_account_id, session_id, prompt)| EvaluationRun {
            agent_id,
            owner_account_id,
            session_id,
            snapshot: serde_json::from_str(&prompt).unwrap_or(Value::Null),
        },
    ))
}

/// Records a finished evaluation. An offer is stored only while the agent is
/// still watching and its owner is still in the group.
pub async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<(), sqlx_core::Error> {
    let Some(run) = leased_run(pool, run_id, runner_id).await? else {
        return Ok(());
    };
    let decision = parse(response_text);
    let now = Utc::now();
    let mut tx = pool.begin().await?;
    let finished = query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'completed', updated_at = $3, completed_at = $3
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(now.to_rfc3339())
    .execute(&mut *tx)
    .await?;
    if finished.rows_affected() == 0 {
        return Ok(());
    }
    let conversation: Option<(Uuid,)> = query_as(
        "UPDATE cloud_agent_proactive_state
         SET active_run_id = NULL, attempts = 0, last_error = NULL, updated_at = now()
         WHERE active_run_id = $1 RETURNING conversation_id",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    let proposal_id = match (decision, conversation) {
        (Decision::Offer(offer), Some((conversation_id,))) => {
            store_offer(&mut tx, run_id, &run, conversation_id, &offer).await?
        }
        _ => None,
    };
    tx.commit().await?;
    if let Some(proposal_id) = proposal_id {
        if let Err(error) = super::card::post(pool, &proposal_id).await {
            eprintln!("[proactive] Could not post the card for {proposal_id}: {error}");
        }
    }
    Ok(())
}

async fn store_offer(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    run_id: &str,
    run: &EvaluationRun,
    conversation_id: Uuid,
    offer: &Offer,
) -> Result<Option<String>, sqlx_core::Error> {
    // The same checks as at selection: the agent still watches and its owner
    // is still in the group.
    let (allowed,): (bool,) = query_as(concat!(
        "SELECT EXISTS (
             SELECT 1 FROM ",
        super::agents::watchers_sql!(),
        " agent
             JOIN cloud_chat_conversation_members member
               ON member.account_id = agent.owner_account_id
              AND member.conversation_id = $2 AND member.membership_state = 'active'
             WHERE agent.agent_id = $1 AND agent.owner_account_id = $3)"
    ))
    .bind(&run.agent_id)
    .bind(conversation_id)
    .bind(&run.owner_account_id)
    .fetch_one(&mut **tx)
    .await?;
    let known: Vec<&str> = run.snapshot["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|message| message["messageId"].as_str())
        .collect();
    let evidence: Vec<String> = offer
        .evidence
        .iter()
        .filter(|id| known.contains(&id.as_str()))
        .cloned()
        .collect();
    let trigger = trigger_message(&run.snapshot, &evidence)
        .and_then(|message| message["messageId"].as_str())
        .map(str::to_string);
    let Some(trigger) = trigger.filter(|_| allowed) else {
        return Ok(None);
    };
    query(
        "UPDATE cloud_agent_proactive_proposals SET status = 'expired'
         WHERE agent_id = $1 AND conversation_id = $2 AND status = 'pending'
           AND expires_at <= now()",
    )
    .bind(&run.agent_id)
    .bind(conversation_id)
    .execute(&mut **tx)
    .await?;
    let proposal_id = format!("pro_{}", Uuid::new_v4().simple());
    let config = ProactiveConfig::from_env();
    let inserted = query(
        "INSERT INTO cloud_agent_proactive_proposals (
             proposal_id, agent_id, owner_account_id, conversation_id, session_id,
             trigger_message_id, evidence_json, problem, offer, plan, status,
             evaluation_run_id, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, now(),
                   now() + make_interval(hours => $12))
         ON CONFLICT DO NOTHING",
    )
    .bind(&proposal_id)
    .bind(&run.agent_id)
    .bind(&run.owner_account_id)
    .bind(conversation_id)
    .bind(&run.session_id)
    .bind(&trigger)
    .bind(json!(evidence))
    .bind(&offer.problem)
    .bind(&offer.offer)
    .bind(&offer.plan)
    .bind(run_id)
    .bind(PROPOSAL_LIFETIME_HOURS as i32)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() == 0 {
        return Ok(None);
    }
    query(
        "UPDATE cloud_agent_proactive_state
         SET cooldown_until = now() + make_interval(secs => $3), updated_at = now()
         WHERE agent_id = $1 AND conversation_id = $2",
    )
    .bind(&run.agent_id)
    .bind(conversation_id)
    .bind(config.cooldown_seconds as f64)
    .execute(&mut **tx)
    .await?;
    Ok(Some(proposal_id))
}

/// Records a failed evaluation and schedules the next look with bounded
/// backoff, from the messages the failed run started at.
pub async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    error_code: &str,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let failed: Option<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'failed', error_code = $3,
             error_message = 'The proactive check could not finish.',
             updated_at = $4, completed_at = $4
         WHERE run_id = $1 AND ($2::text IS NULL OR claimed_by = $2)
           AND status IN ('queued', 'leased', 'running')
         RETURNING prompt",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(error_code)
    .bind(&now)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((prompt,)) = failed {
        let since = serde_json::from_str::<Value>(&prompt)
            .ok()
            .and_then(|snapshot| snapshot["sinceSequence"].as_i64());
        let attempts: Option<(i32,)> = query_as(
            "SELECT attempts + 1 FROM cloud_agent_proactive_state WHERE active_run_id = $1",
        )
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?;
        let attempts = attempts.map(|(value,)| value).unwrap_or(1);
        query(
            "UPDATE cloud_agent_proactive_state
             SET active_run_id = NULL, attempts = $2, last_error = $3,
                 retry_after = now() + make_interval(secs => $4),
                 seen_sequence = COALESCE(LEAST(seen_sequence, $5), seen_sequence),
                 updated_at = now()
             WHERE active_run_id = $1",
        )
        .bind(run_id)
        .bind(attempts)
        .bind(error_code)
        .bind(backoff_seconds(attempts) as f64)
        .bind(since)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Frees conversations whose evaluation can no longer finish: it ended or
/// vanished without clearing the reservation, or its lease expired long ago.
pub async fn release_stale_runs(pool: &PgPool) -> Result<u64, sqlx_core::Error> {
    let stale: Vec<(String, bool)> = query_as(
        "SELECT state.active_run_id,
                run.run_id IS NULL OR run.status NOT IN ('queued', 'leased', 'running')
         FROM cloud_agent_proactive_state state
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
                "UPDATE cloud_agent_proactive_state SET active_run_id = NULL, updated_at = now()
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
    fn backoff_grows_and_caps() {
        assert_eq!(backoff_seconds(0), 60);
        assert_eq!(backoff_seconds(2), 300);
        assert_eq!(backoff_seconds(9), 43_200);
    }
}
