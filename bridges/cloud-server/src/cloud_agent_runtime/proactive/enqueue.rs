use std::collections::HashSet;

use chrono::Utc;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;

use super::{
    envelope::{
        history, is_history_message, is_human_message, normalized_agent_id, parse, Message,
    },
    SKILL_PACK_ID, SKILL_PACK_MANIFEST,
};

struct ProactiveCandidate {
    agent_id: String,
    owner_account_id: String,
    prompt: String,
    sandbox_id: String,
}

fn rollout_enabled() -> bool {
    std::env::var("KORDI_PROACTIVE_AGENTS_ENABLED")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn quiet_window_seconds() -> i64 {
    std::env::var("KORDI_PROACTIVE_QUIET_WINDOW_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(8)
        .clamp(1, 120)
}

fn prompt(agent_name: &str, system_prompt: &str, history: &[Message]) -> String {
    let transcript = history
        .iter()
        .map(|message| {
            let speaker = message
                .sender_display_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| message.sender_account_id.trim());
            let kind = message.sender_kind.as_deref().unwrap_or("participant");
            format!(
                "[{}] {speaker} ({kind}): {}",
                message.id.trim(),
                message.text.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are deciding whether {agent_name} should proactively help in a group conversation.
Agent instructions:
{system_prompt}
Versioned proactive collaboration skill pack:
{SKILL_PACK_MANIFEST}
Recent canonical messages:
{transcript}
Return exactly one JSON object and no markdown:
{{\"action\":\"silence\",\"breakdown\":\"none\",\"selectedSkill\":\"breakdown-judgement\",\"evidenceMessageIds\":[],\"response\":null}}
or
{{\"action\":\"intervene\",\"breakdown\":\"<supported breakdown>\",\"selectedSkill\":\"<one repair skill from the pack>\",\"evidenceMessageIds\":[\"<message id>\"],\"response\":\"<one or two sentences, at most 80 words>\"}}
Use only these breakdown and repair-skill pairs: unclear-goal -> clarification-first; stalled-plan -> plan-completion; unresolved-conflict -> conflict-mediation; missed-constraint -> constraint-reminder; lost-focus -> goal-refocusing; repeated-loop -> loop-breaking; participation-imbalance -> participation-balancing; unmanaged-risk -> risk-check.
Prefer silence. Intervene only when the latest human exchange contains a specific collaboration breakdown and the response adds concrete coordination value. Stay silent when people or an agent are already handling the issue, a maintainer just answered, new evidence just arrived, the event is housekeeping, or the contribution would only be optional polish. Do not reveal hidden reasoning, use tools, take side effects, or mention this evaluation."
    )
}

pub async fn enqueue_runs_for_message(
    pool: &PgPool,
    body: &str,
    session_id: Option<&str>,
    sender_account_id: &str,
) -> Result<usize, sqlx_core::Error> {
    if !rollout_enabled() {
        return Ok(0);
    }
    let Some(session_id) = session_id
        .map(str::trim)
        .filter(|value| value.starts_with("session:group:"))
    else {
        return Ok(0);
    };
    let Some(envelope) = parse(body) else {
        return Ok(0);
    };
    if envelope.group_id.trim() != session_id
        || !is_human_message(&envelope, sender_account_id)
        || !envelope
            .participants
            .iter()
            .any(|participant| participant.account_id.trim() == sender_account_id.trim())
    {
        return Ok(0);
    }
    let Some(message) = envelope.message.as_ref() else {
        return Ok(0);
    };
    let now = Utc::now();
    let now_text = now.to_rfc3339();
    let not_before = (now + chrono::Duration::seconds(quiet_window_seconds())).to_rfc3339();
    let cooldown_cutoff = (now - chrono::Duration::minutes(5)).to_rfc3339();
    let mut seen_agents = HashSet::new();
    let mut seen_definitions = HashSet::new();
    let mut candidates = Vec::new();
    for participant in &envelope.participants {
        for raw_agent_id in &participant.agent_ids {
            let agent_id = normalized_agent_id(raw_agent_id);
            if agent_id.is_empty() || !seen_agents.insert(agent_id.clone()) {
                continue;
            }
            let definition: Option<(String, Option<String>, String, String, String)> = query_as(
                "SELECT agent_id, source_agent_id, name, system_prompt, owner_account_id
                 FROM cloud_agent_definitions
                 WHERE (agent_id = $1 OR source_agent_id = $1)
                   AND owner_account_id = $2
                   AND status = 'active'
                   AND access_scope = 'participant_conversations'
                   AND is_system_managed = FALSE
                   AND proactive_enabled = TRUE
                   AND proactive_skill_pack = $3",
            )
            .bind(&agent_id)
            .bind(participant.account_id.trim())
            .bind(SKILL_PACK_ID)
            .fetch_optional(pool)
            .await?;
            let Some((agent_id, source_agent_id, agent_name, system_prompt, owner_account_id)) =
                definition
            else {
                continue;
            };
            if !seen_definitions.insert(agent_id.clone()) {
                continue;
            }
            let recent_intervention: Option<(String,)> = query_as(
                "SELECT run_id FROM cloud_agent_fallback_runs
                 WHERE target_agent_id = $1
                   AND session_id = $2
                   AND trigger_kind = 'proactive'
                   AND proactive_decision = 'intervention'
                   AND completed_at >= $3
                 LIMIT 1",
            )
            .bind(&agent_id)
            .bind(session_id)
            .bind(&cooldown_cutoff)
            .fetch_optional(pool)
            .await?;
            if recent_intervention.is_some() {
                continue;
            }
            let history = history(
                pool,
                session_id,
                &owner_account_id,
                &agent_id,
                source_agent_id.as_deref(),
            )
            .await?;
            let sandbox =
                ensure_sandbox_for_run(pool, session_id, &owner_account_id, sender_account_id)
                    .await?;
            candidates.push(ProactiveCandidate {
                agent_id,
                owner_account_id,
                prompt: prompt(&agent_name, &system_prompt, &history),
                sandbox_id: sandbox.sandbox_id,
            });
        }
    }
    if candidates.is_empty() {
        return Ok(0);
    }

    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('kordi-proactive'), hashtext($1))")
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
    let latest_rows = query_as::<_, (String,)>(
        "SELECT body FROM cloud_messages
         WHERE session_id = $1
         ORDER BY created_at DESC, message_id DESC
         LIMIT 160",
    )
    .bind(session_id)
    .fetch_all(&mut *tx)
    .await?;
    let latest_context_message_id = latest_rows
        .into_iter()
        .filter_map(|(body,)| parse(&body))
        .find(is_history_message)
        .and_then(|envelope| envelope.message.map(|message| message.id));
    if latest_context_message_id
        .as_deref()
        .is_none_or(|latest_id| latest_id.trim() != message.id.trim())
    {
        tx.commit().await?;
        return Ok(0);
    }

    let mut enqueued = 0usize;
    for candidate in candidates {
        let still_active: Option<(String,)> = query_as(
            "SELECT agent_id FROM cloud_agent_definitions
             WHERE agent_id = $1
               AND owner_account_id = $2
               AND status = 'active'
               AND access_scope = 'participant_conversations'
               AND is_system_managed = FALSE
               AND proactive_enabled = TRUE
               AND proactive_skill_pack = $3
             FOR SHARE",
        )
        .bind(&candidate.agent_id)
        .bind(&candidate.owner_account_id)
        .bind(SKILL_PACK_ID)
        .fetch_optional(&mut *tx)
        .await?;
        if still_active.is_none() {
            continue;
        }
        let recent_intervention: Option<(String,)> = query_as(
            "SELECT run_id FROM cloud_agent_fallback_runs
             WHERE target_agent_id = $1
               AND session_id = $2
               AND trigger_kind = 'proactive'
               AND proactive_decision = 'intervention'
               AND completed_at >= $3
             LIMIT 1",
        )
        .bind(&candidate.agent_id)
        .bind(session_id)
        .bind(&cooldown_cutoff)
        .fetch_optional(&mut *tx)
        .await?;
        if recent_intervention.is_some() {
            continue;
        }
        query(
            "UPDATE cloud_agent_fallback_runs
             SET status = 'cancelled', claimed_by = NULL, lease_expires_at = NULL,
                 updated_at = $4, completed_at = $4
             WHERE target_agent_id = $1
               AND session_id = $2
               AND trigger_kind = 'proactive'
               AND request_message_id <> $3
               AND status IN ('queued', 'leased', 'running')",
        )
        .bind(&candidate.agent_id)
        .bind(session_id)
        .bind(&message.id)
        .bind(&now_text)
        .execute(&mut *tx)
        .await?;
        let run_id = format!("car_{}", Uuid::new_v4().simple());
        let idempotency_key = format!(
            "proactive:{}:{session_id}:{}:{SKILL_PACK_ID}",
            candidate.agent_id,
            message.id.trim()
        );
        let inserted = query(
            "INSERT INTO cloud_agent_fallback_runs (
                    run_id, idempotency_key, request_message_id, session_id,
                    owner_account_id, requester_account_id, status, prompt,
                    sandbox_id, trigger_kind, target_agent_id, not_before_at,
                    proactive_skill_pack, created_at, updated_at
                 ) VALUES (
                    $1, $2, $3, $4, $5, $6, 'queued', $7, $8,
                    'proactive', $9, $10, $11, $12, $12
                 )
                 ON CONFLICT (idempotency_key) DO NOTHING",
        )
        .bind(&run_id)
        .bind(&idempotency_key)
        .bind(&message.id)
        .bind(session_id)
        .bind(&candidate.owner_account_id)
        .bind(sender_account_id)
        .bind(&candidate.prompt)
        .bind(&candidate.sandbox_id)
        .bind(&candidate.agent_id)
        .bind(&not_before)
        .bind(SKILL_PACK_ID)
        .bind(&now_text)
        .execute(&mut *tx)
        .await?;
        enqueued += inserted.rows_affected() as usize;
    }
    tx.commit().await?;
    Ok(enqueued)
}

pub fn spawn_enqueue_for_message(
    pool: PgPool,
    body: String,
    session_id: Option<String>,
    sender_account_id: String,
) {
    tokio::spawn(async move {
        if let Err(error) =
            enqueue_runs_for_message(&pool, &body, session_id.as_deref(), &sender_account_id).await
        {
            eprintln!("[cloud_agent_runtime] enqueue proactive run: {error}");
        }
    });
}
