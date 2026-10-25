//! Sweep state and evaluation runs.
//!
//! Every enabled agent, a definition or an owner's default agent, gets one cursor row per group its owner is in,
//! starting at the newest message. A row is a candidate once collaborators
//! wrote and the chat went quiet; the snapshot then decides whether it is
//! worth a model call, and a reservation queues exactly one run.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::agents::watchers_sql;
use super::complete::{backoff_seconds, MAX_ATTEMPTS};
use super::config::ProactiveConfig;
use super::prefilter::worth_a_look;
use super::prompt::evaluation_system_prompt;
use super::snapshot::{build, load_agent, Agent, Candidate};
use super::RUN_PREFIX;
use crate::cloud_agent_runtime::runs::route_fill::fill_cloud_route;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;

const SWEEP_BATCH: i64 = 10;

/// Conditions shared by seeding and selection: a group (not a Grounding
/// group) the owner of an agent with the setting on is in. `agent` is a row
/// of [`watchers_sql`].
macro_rules! watched_sql {
    () => {
        "c.kind = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM cloud_common_ground_room_groups room
                           WHERE room.conversation_id = c.conversation_id)"
    };
}

/// A new watched conversation starts at its newest message, so history is
/// never evaluated.
const SEED_SQL: &str = concat!(
    "INSERT INTO cloud_agent_proactive_state
         (agent_id, owner_account_id, conversation_id, seen_sequence)
     SELECT agent.agent_id, agent.owner_account_id, c.conversation_id, c.latest_message_sequence
     FROM ",
    watchers_sql!(),
    " agent
     JOIN cloud_chat_conversation_members owner_member
       ON owner_member.account_id = agent.owner_account_id
      AND owner_member.membership_state = 'active'
     JOIN cloud_chat_conversations c ON c.conversation_id = owner_member.conversation_id
     WHERE ",
    watched_sql!(),
    " ON CONFLICT (agent_id, conversation_id) DO NOTHING"
);

/// Rows whose owner left the group or whose agent stopped watching. A later
/// return starts again at the newest message.
const PRUNE_SQL: &str = concat!(
    "DELETE FROM cloud_agent_proactive_state state
     WHERE state.active_run_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM ",
    watchers_sql!(),
    " agent
         JOIN cloud_chat_conversation_members member
           ON member.account_id = agent.owner_account_id
          AND member.conversation_id = state.conversation_id
          AND member.membership_state = 'active'
         WHERE agent.agent_id = state.agent_id)"
);

/// Candidates: $1 conversation kinds, $2 service accounts, $3 batch, $4 quiet
/// seconds, $5 max wait seconds, $6 daily cap, $7 cap window start (RFC 3339).
pub(super) const SWEEP_SQL: &str = concat!(
    "UPDATE cloud_agent_proactive_state state SET checked_at = now()
 FROM (
     SELECT s.agent_id, s.conversation_id, c.legacy_session_id, c.latest_message_sequence,
            s.seen_sequence
     FROM cloud_agent_proactive_state s
     JOIN ",
    watchers_sql!(),
    " agent ON agent.agent_id = s.agent_id
     JOIN cloud_chat_conversations c ON c.conversation_id = s.conversation_id
     JOIN cloud_chat_conversation_members owner_member
       ON owner_member.conversation_id = c.conversation_id
      AND owner_member.account_id = agent.owner_account_id
      AND owner_member.membership_state = 'active'
     WHERE ",
    watched_sql!(),
    "
       AND c.legacy_session_id IS NOT NULL
       AND s.active_run_id IS NULL
       AND s.retry_after <= now() AND s.cooldown_until <= now()
       AND c.latest_message_sequence > s.seen_sequence
       AND EXISTS (SELECT 1 FROM cloud_chat_messages msg
           WHERE msg.conversation_id = c.conversation_id AND msg.deleted_at IS NULL
             AND msg.conversation_sequence > s.seen_sequence
             AND msg.sender_account_id <> agent.owner_account_id
             AND NOT (msg.sender_account_id = ANY($2)))
       AND (
         (SELECT msg.created_at FROM cloud_chat_messages msg
           WHERE msg.conversation_id = c.conversation_id AND msg.deleted_at IS NULL
             AND msg.conversation_sequence > s.seen_sequence
             AND msg.sender_account_id <> agent.owner_account_id
             AND NOT (msg.sender_account_id = ANY($2))
           ORDER BY msg.conversation_sequence DESC LIMIT 1)
           <= now() - make_interval(secs => $4)
         OR (SELECT msg.created_at FROM cloud_chat_messages msg
           WHERE msg.conversation_id = c.conversation_id AND msg.deleted_at IS NULL
             AND msg.conversation_sequence > s.seen_sequence
             AND msg.sender_account_id <> agent.owner_account_id
             AND NOT (msg.sender_account_id = ANY($2))
           ORDER BY msg.conversation_sequence ASC LIMIT 1)
           <= now() - make_interval(secs => $5))
       AND NOT EXISTS (SELECT 1 FROM cloud_agent_proactive_proposals proposal
           WHERE proposal.agent_id = s.agent_id
             AND proposal.conversation_id = s.conversation_id
             AND proposal.status = 'pending')
       AND (SELECT count(*) FROM cloud_agent_fallback_runs run
             WHERE run.execution_agent_id = s.agent_id
               AND starts_with(run.run_id, 'proactive_eval_')
               AND run.created_at >= $7) < $6
     ORDER BY s.checked_at ASC
     LIMIT $3
 ) picked
 WHERE state.agent_id = picked.agent_id AND state.conversation_id = picked.conversation_id
 RETURNING picked.agent_id, picked.conversation_id, picked.legacy_session_id,
           picked.latest_message_sequence, picked.seen_sequence"
);

type CandidateRow = (String, Uuid, String, i64, i64);

/// The rows the next sweep would evaluate, with their checks applied. Used by
/// [`sweep`] and by the database tests.
pub(super) async fn select(
    pool: &PgPool,
    config: &ProactiveConfig,
    limit: i64,
) -> Result<Vec<Candidate>, sqlx_core::Error> {
    let window_start = (Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let rows: Vec<CandidateRow> = query_as(SWEEP_SQL)
        .bind(crate::pip::membership::PIP_CONVERSATION_KINDS)
        .bind(crate::system_account::service_account_ids())
        .bind(limit)
        .bind(config.quiet_seconds as f64)
        .bind(config.max_wait_seconds as f64)
        .bind(config.daily_cap)
        .bind(window_start)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(agent_id, conversation_id, session_id, latest_sequence, seen_sequence)| Candidate {
                agent_id,
                conversation_id,
                session_id,
                latest_sequence,
                seen_sequence,
            },
        )
        .collect())
}

/// Starts watching new groups and stops watching groups the owner left.
pub(super) async fn seed(pool: &PgPool) -> Result<(), sqlx_core::Error> {
    query(PRUNE_SQL).execute(pool).await?;
    query(SEED_SQL)
        .bind(crate::pip::membership::PIP_CONVERSATION_KINDS)
        .execute(pool)
        .await?;
    Ok(())
}

/// One sweep pass. Returns the number of evaluations queued.
pub async fn sweep(pool: &PgPool, config: &ProactiveConfig) -> Result<usize, sqlx_core::Error> {
    seed(pool).await?;
    let mut queued = 0;
    for candidate in select(pool, config, SWEEP_BATCH).await? {
        match consider(pool, &candidate).await {
            Ok(true) => queued += 1,
            Ok(false) => {}
            Err(error) => {
                eprintln!(
                    "[proactive] Evaluation of agent {} in {} failed before it queued: {error}",
                    candidate.agent_id, candidate.conversation_id
                );
                if let Err(error) = defer(pool, &candidate).await {
                    eprintln!("[proactive] Could not schedule the next look: {error}");
                }
            }
        }
    }
    Ok(queued)
}

/// Pushes back a candidate whose evaluation failed before it queued, under
/// the same backoff and attempt cap as a failed evaluation run.
pub(super) async fn defer(pool: &PgPool, candidate: &Candidate) -> Result<(), sqlx_core::Error> {
    let attempts: Option<(i32,)> = query_as(
        "SELECT attempts + 1 FROM cloud_agent_proactive_state
         WHERE agent_id = $1 AND conversation_id = $2 AND active_run_id IS NULL",
    )
    .bind(&candidate.agent_id)
    .bind(candidate.conversation_id)
    .fetch_optional(pool)
    .await?;
    let Some((attempts,)) = attempts else {
        return Ok(());
    };
    let give_up = attempts >= MAX_ATTEMPTS;
    if give_up {
        eprintln!(
            "[proactive] Giving up on agent {} in {} after {attempts} failed evaluations",
            candidate.agent_id, candidate.conversation_id
        );
    }
    query(
        "UPDATE cloud_agent_proactive_state
         SET attempts = CASE WHEN $3 THEN 0 ELSE $4 END,
             seen_sequence = CASE WHEN $3 THEN GREATEST(seen_sequence, $5) ELSE seen_sequence END,
             retry_after = now() + make_interval(secs => $6),
             last_error = 'evaluation_setup_failed', updated_at = now()
         WHERE agent_id = $1 AND conversation_id = $2 AND active_run_id IS NULL",
    )
    .bind(&candidate.agent_id)
    .bind(candidate.conversation_id)
    .bind(give_up)
    .bind(attempts)
    .bind(candidate.latest_sequence)
    .bind(if give_up {
        0.0
    } else {
        backoff_seconds(attempts) as f64
    })
    .execute(pool)
    .await?;
    Ok(())
}

/// What happened to one candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Outcome {
    Queued,
    /// The cursor moved without a model call.
    Skipped,
}

async fn advance(pool: &PgPool, candidate: &Candidate) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_agent_proactive_state SET seen_sequence = GREATEST(seen_sequence, $3),
             updated_at = now()
         WHERE agent_id = $1 AND conversation_id = $2 AND active_run_id IS NULL",
    )
    .bind(&candidate.agent_id)
    .bind(candidate.conversation_id)
    .bind(candidate.latest_sequence)
    .execute(pool)
    .await?;
    Ok(())
}

async fn consider(pool: &PgPool, candidate: &Candidate) -> Result<bool, sqlx_core::Error> {
    Ok(evaluate(pool, candidate).await? == Outcome::Queued)
}

/// Checks a candidate's new messages for free and queues an evaluation when
/// they are worth one: collaborators wrote, nobody mentioned the agent (a
/// mention already starts a normal run), and something reads like a request.
pub(super) async fn evaluate(
    pool: &PgPool,
    candidate: &Candidate,
) -> Result<Outcome, sqlx_core::Error> {
    let Some(agent) = load_agent(pool, &candidate.agent_id).await? else {
        return Ok(Outcome::Skipped);
    };
    let snapshot = build(pool, &agent, candidate).await?;
    if snapshot.collaborator_texts.is_empty()
        || snapshot.mentions_agent
        || !worth_a_look(&snapshot.collaborator_texts)
    {
        advance(pool, candidate).await?;
        return Ok(Outcome::Skipped);
    }
    enqueue(pool, &agent, candidate, &snapshot.value).await
}

async fn enqueue(
    pool: &PgPool,
    agent: &Agent,
    candidate: &Candidate,
    snapshot: &serde_json::Value,
) -> Result<Outcome, sqlx_core::Error> {
    let route = serde_json::from_value::<AgentRuntimeRoute>(agent.model_routing.clone())
        .unwrap_or_default();
    let route =
        fill_cloud_route(pool, &agent.owner_account_id, &candidate.session_id, route).await?;
    let route =
        serde_json::to_value(route).map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    // A Mac that can run evaluations gets one presence timeout first, and the
    // owner's devices hear of the held run in the same transaction.
    let ready = crate::cloud_agent_runtime::agent_desktop_ready(
        pool,
        &agent.owner_account_id,
        super::CAPABILITY,
    )
    .await?;
    let preferred_until = ready.then(|| Utc::now() + crate::presence::presence_timeout());
    let system_prompt =
        evaluation_system_prompt(&agent.name, &agent.owner_name, &agent.system_prompt);
    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let mut tx = pool.begin().await?;
    // A new evaluation starts with its whole search budget (`memory_search`).
    let reserved = query(
        "UPDATE cloud_agent_proactive_state
         SET active_run_id = $3, seen_sequence = $4, memory_searches = 0, updated_at = now()
         WHERE agent_id = $1 AND conversation_id = $2 AND active_run_id IS NULL",
    )
    .bind(&candidate.agent_id)
    .bind(candidate.conversation_id)
    .bind(&run_id)
    .bind(candidate.latest_sequence)
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
                   'background', 'shared', $9)",
    )
    .bind(&run_id)
    .bind(&candidate.session_id)
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
        super::desktop::announce_evaluation(&mut tx, &agent.owner_account_id, &run_id, candidate)
            .await?;
    }
    tx.commit().await?;
    Ok(Outcome::Queued)
}
