//! Sweep state and evaluation runs.
//!
//! Every agent with its Proactive setting on has one state row whose cursor
//! is the `received_at` of the newest connector event it has looked at. An
//! agent is a candidate once events granted to it arrived after the cursor
//! and went quiet (batching), while it is off cooldown and under its daily
//! caps; a reservation then queues exactly one evaluation.

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::config::{backoff_seconds, PersonalAgentConfig, MAX_ATTEMPTS};
use super::prompt::evaluation_system_prompt;
use super::sessions::PersonalSession;
use super::snapshot::{build, load_agent, new_events, Agent, IGNORED_KINDS, SETTLE_SECONDS};
use super::{run_session_id, EVAL_HINT, RUN_PREFIX};
use crate::cloud_agent_runtime::runs::route_fill::fill_cloud_route;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;

const SWEEP_BATCH: i64 = 10;

/// An agent with its setting on and no state row starts at now.
const SEED_SQL: &str = "INSERT INTO cloud_personal_agent_state (agent_id, owner_account_id)
     SELECT setting.agent_id, setting.owner_account_id FROM cloud_personal_agent_settings setting
     WHERE setting.proactive
     ON CONFLICT (agent_id) DO NOTHING";

/// Candidates: $1 batch, $2 quiet seconds, $3 max wait seconds, $4 daily
/// evaluations, $5 cap window start (RFC 3339, as runs store it), $6 daily
/// messages, $7 settle seconds, $8 ignored event kinds.
pub(super) const SWEEP_SQL: &str = "UPDATE cloud_personal_agent_state state SET checked_at = now()
 FROM (
     SELECT s.agent_id, s.owner_account_id, s.cursor_received_at
     FROM cloud_personal_agent_state s
     JOIN cloud_personal_agent_settings setting
       ON setting.agent_id = s.agent_id AND setting.owner_account_id = s.owner_account_id
      AND setting.proactive
     CROSS JOIN LATERAL (
         SELECT max(e.received_at) AS newest, min(e.received_at) AS oldest
         FROM cloud_connector_events e
         JOIN cloud_connectors c ON c.connector_id = e.connector_id
         JOIN cloud_connector_agent_grants g
           ON g.connector_id = c.connector_id AND g.agent_id = s.agent_id
         WHERE c.account_id = s.owner_account_id AND c.status <> 'revoked'
           AND e.received_at > s.cursor_received_at
           AND e.received_at <= now() - make_interval(secs => $7)
           AND e.expires_at > now() AND NOT (e.kind = ANY($8))
     ) fresh
     WHERE s.active_run_id IS NULL AND s.retry_after <= now() AND s.cooldown_until <= now()
       AND (s.agent_id = 'cloud-agent:' || s.owner_account_id OR EXISTS (
             SELECT 1 FROM cloud_agent_definitions d
             WHERE d.agent_id = s.agent_id AND d.owner_account_id = s.owner_account_id
               AND d.status = 'active' AND d.is_system_managed = FALSE))
       AND fresh.newest IS NOT NULL
       AND (fresh.newest <= now() - make_interval(secs => $2)
            OR fresh.oldest <= now() - make_interval(secs => $3))
       AND (SELECT count(*) FROM cloud_agent_fallback_runs run
             WHERE run.execution_agent_id = s.agent_id
               AND starts_with(run.run_id, 'personal_agent_eval_')
               AND run.created_at >= $5) < $4
       AND (SELECT count(*) FROM cloud_personal_agent_messages sent
             WHERE sent.agent_id = s.agent_id AND sent.created_at > now() - interval '24 hours') < $6
     ORDER BY s.checked_at ASC
     LIMIT $1
 ) picked
 WHERE state.agent_id = picked.agent_id
 RETURNING picked.agent_id, picked.owner_account_id, picked.cursor_received_at";

/// An agent the sweep picked.
#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub agent_id: String,
    pub owner_account_id: String,
    pub cursor: DateTime<Utc>,
}

/// What happened to one candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    Queued,
    Skipped,
}

/// Starts state rows for agents that were turned on without one.
pub(super) async fn seed(pool: &PgPool) -> Result<(), sqlx_core::Error> {
    query(SEED_SQL).execute(pool).await?;
    Ok(())
}

/// The agents the next sweep would evaluate, with the gate applied.
pub(super) async fn select(
    pool: &PgPool,
    config: &PersonalAgentConfig,
    limit: i64,
) -> Result<Vec<Candidate>, sqlx_core::Error> {
    let window_start = (Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let rows: Vec<(String, String, DateTime<Utc>)> = query_as(SWEEP_SQL)
        .bind(limit)
        .bind(config.quiet_seconds as f64)
        .bind(config.max_wait_seconds as f64)
        .bind(config.daily_evaluations)
        .bind(window_start)
        .bind(config.daily_shares)
        .bind(SETTLE_SECONDS as f64)
        .bind(IGNORED_KINDS)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(agent_id, owner_account_id, cursor)| Candidate {
            agent_id,
            owner_account_id,
            cursor,
        })
        .collect())
}

/// One sweep pass. Returns the number of evaluations queued.
pub async fn sweep(pool: &PgPool, config: &PersonalAgentConfig) -> Result<usize, sqlx_core::Error> {
    seed(pool).await?;
    let mut queued = 0;
    for candidate in select(pool, config, SWEEP_BATCH).await? {
        match evaluate(pool, &candidate).await {
            Ok(Outcome::Queued) => queued += 1,
            Ok(Outcome::Skipped) => {}
            Err(error) => {
                eprintln!(
                    "[personal_agent] Evaluation of agent {} failed before it queued: {error}",
                    candidate.agent_id
                );
                if let Err(error) = defer(pool, &candidate).await {
                    eprintln!("[personal_agent] Could not schedule the next look: {error}");
                }
            }
        }
    }
    Ok(queued)
}

/// Pushes back a candidate whose evaluation failed before it queued, under
/// the same backoff and attempt cap as a failed run; giving up skips the
/// events received so far.
async fn defer(pool: &PgPool, candidate: &Candidate) -> Result<(), sqlx_core::Error> {
    let attempts: Option<(i32,)> = query_as(
        "SELECT attempts + 1 FROM cloud_personal_agent_state
         WHERE agent_id = $1 AND active_run_id IS NULL",
    )
    .bind(&candidate.agent_id)
    .fetch_optional(pool)
    .await?;
    let Some((attempts,)) = attempts else {
        return Ok(());
    };
    let give_up = attempts >= MAX_ATTEMPTS;
    query(
        "UPDATE cloud_personal_agent_state
         SET attempts = CASE WHEN $2 THEN 0 ELSE $3 END,
             cursor_received_at = CASE WHEN $2
               THEN GREATEST(cursor_received_at, now() - make_interval(secs => $5))
               ELSE cursor_received_at END,
             retry_after = now() + make_interval(secs => $4),
             last_error = 'evaluation_setup_failed', updated_at = now()
         WHERE agent_id = $1 AND active_run_id IS NULL",
    )
    .bind(&candidate.agent_id)
    .bind(give_up)
    .bind(attempts)
    .bind(if give_up {
        0.0
    } else {
        backoff_seconds(attempts) as f64
    })
    .bind(SETTLE_SECONDS as f64)
    .execute(pool)
    .await?;
    Ok(())
}

/// Builds the snapshot of a candidate's new events and queues one
/// evaluation for it. The cursor moves only when the evaluation ends.
pub(super) async fn evaluate(
    pool: &PgPool,
    candidate: &Candidate,
) -> Result<Outcome, sqlx_core::Error> {
    let Some(agent) = load_agent(pool, &candidate.agent_id).await? else {
        return Ok(Outcome::Skipped);
    };
    if agent.owner_account_id != candidate.owner_account_id {
        return Ok(Outcome::Skipped);
    }
    let events = new_events(pool, &agent, candidate.cursor).await?;
    let Some(newest) = events.iter().map(|event| event.received_at).max() else {
        return Ok(Outcome::Skipped);
    };
    let session = super::sessions::ensure(pool, &agent.owner_account_id, &agent.agent_id)
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    let snapshot = build(pool, &agent, session.conversation_id, &events).await?;
    enqueue(pool, &agent, &session, &snapshot, newest).await
}

async fn enqueue(
    pool: &PgPool,
    agent: &Agent,
    session: &PersonalSession,
    snapshot: &serde_json::Value,
    newest: DateTime<Utc>,
) -> Result<Outcome, sqlx_core::Error> {
    let route = serde_json::from_value::<AgentRuntimeRoute>(agent.model_routing.clone())
        .unwrap_or_default();
    let route = fill_cloud_route(pool, &agent.owner_account_id, &session.session_id, route).await?;
    let route =
        serde_json::to_value(route).map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    // A Mac that runs proactive evaluations gets one presence timeout first,
    // and the owner's devices hear of the held run in the same transaction.
    let ready = crate::cloud_agent_runtime::agent_desktop_ready(
        pool,
        &agent.owner_account_id,
        crate::proactive::CAPABILITY,
    )
    .await?;
    let preferred_until = ready.then(|| Utc::now() + crate::presence::presence_timeout());
    let system_prompt =
        evaluation_system_prompt(&agent.name, &agent.owner_name, &agent.system_prompt);
    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let run_session = run_session_id(&agent.agent_id);
    let mut tx = pool.begin().await?;
    // A new evaluation starts with its whole search budget.
    let reserved = query(
        "UPDATE cloud_personal_agent_state
         SET active_run_id = $2, run_cursor_received_at = $3, memory_searches = 0,
             updated_at = now()
         WHERE agent_id = $1 AND active_run_id IS NULL",
    )
    .bind(&agent.agent_id)
    .bind(&run_id)
    .bind(newest)
    .execute(&mut *tx)
    .await?;
    if reserved.rows_affected() == 0 {
        return Ok(Outcome::Skipped);
    }
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (
             run_id, idempotency_key, request_message_id, session_id, owner_account_id,
             requester_account_id, status, prompt, system_prompt, runtime_route_json,
             created_at, updated_at, execution_backend, execution_agent_id, run_trigger,
             connector_audience, desktop_preferred_until
         ) VALUES ($1, $1, $1, $2, $3, $3, 'queued', $4, $5, $6, $7, $7, 'cloud', $8,
                   'background', 'owner_private', $9)",
    )
    .bind(&run_id)
    .bind(&run_session)
    .bind(&agent.owner_account_id)
    .bind(snapshot.to_string())
    .bind(system_prompt)
    .bind(route)
    .bind(&now)
    .bind(&agent.agent_id)
    .bind(preferred_until)
    .execute(&mut *tx)
    .await?;
    if ready {
        let payload = json!({"runId": run_id, "sessionId": run_session, "agentId": agent.agent_id});
        crate::chat_sync::store::append_account_hint(
            &mut tx,
            &agent.owner_account_id,
            EVAL_HINT,
            &payload,
        )
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not announce the evaluation.".into()))?;
    }
    tx.commit().await?;
    Ok(Outcome::Queued)
}
