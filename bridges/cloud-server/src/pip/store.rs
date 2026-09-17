//! Sweep state, run creation and run completion for PiP.
//!
//! The sweep copies the digest worker's shape: a bounded batch of dirty
//! conversations, an atomic per-row reservation, one queued cloud run per
//! reservation. Unlike the digest worker it never clears its own progress on
//! failure; retries follow a bounded backoff so a persistently failing
//! provider costs at most a handful of calls per day.

use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;

use super::cards::{mark_card_seen, sync_card_messages};
use super::config::PipConfig;
use super::context;
use super::input::{build_input, Candidate};
use super::mentions::{encode_pip_message_with_mentions, resolve_mentions};
use super::prompt::PIP_SYSTEM_PROMPT;

pub use super::retry::{fail, release_stale_runs};

pub const RUN_PREFIX: &str = "pip_";
const SWEEP_BATCH: i64 = 10;

/// Conversations worth a run. Every condition reads the same card as the run
/// input (the newest one still in play), so a selected conversation always
/// yields a hook or moves its cursor, and is never reselected every tick.
pub(super) const SWEEP_SQL: &str = concat!(
    "UPDATE cloud_pip_conversation_state state SET checked_at = now()
 WHERE state.conversation_id IN (
     SELECT s.conversation_id
     FROM cloud_pip_conversation_state s
     JOIN cloud_chat_conversations c ON c.conversation_id = s.conversation_id
     JOIN cloud_chat_conversation_members member
       ON member.conversation_id = c.conversation_id
      AND member.account_id = $1 AND member.membership_state = 'active'
     LEFT JOIN LATERAL (
         SELECT card.event_id, card.revision, card.start_at, card.updated_at
         FROM cloud_plan_cards card
         WHERE card.conversation_id = c.conversation_id AND ",
    crate::plan_cards::live_plan_card_sql!(),
    "
         ORDER BY card.updated_at DESC LIMIT 1
     ) card ON true
     WHERE s.active_run_id IS NULL
       AND s.retry_after <= now()
       AND (
         -- Members' new messages (never PiP's own), once the chat has been
         -- quiet for 30 seconds, or two minutes after the first one.
         (c.latest_message_sequence > s.seen_sequence
          AND EXISTS (SELECT 1 FROM cloud_chat_messages msg
            WHERE msg.conversation_id = c.conversation_id
              AND msg.conversation_sequence > s.seen_sequence AND msg.sender_account_id <> $1)
          AND (
            (SELECT msg.created_at FROM cloud_chat_messages msg
              WHERE msg.conversation_id = c.conversation_id AND msg.sender_account_id <> $1
              ORDER BY msg.conversation_sequence DESC LIMIT 1)
              <= now() - interval '30 seconds'
            OR (SELECT msg.created_at FROM cloud_chat_messages msg
              WHERE msg.conversation_id = c.conversation_id
                AND msg.conversation_sequence > s.seen_sequence AND msg.sender_account_id <> $1
              ORDER BY msg.conversation_sequence ASC LIMIT 1)
              <= now() - interval '2 minutes'
          ))
         -- Votes or answers changed the card, and it has been quiet for 45 seconds.
         OR (card.revision > CASE
               WHEN jsonb_typeof(s.hooks_fired->('card_seen:' || card.event_id)) = 'number'
               THEN (s.hooks_fired->>('card_seen:' || card.event_id))::bigint ELSE 0 END
             AND card.updated_at <= now() - interval '45 seconds')
         -- A reminder is due: one window at a time, as the run input offers it.
         OR (card.start_at > now() AND (
               (card.start_at <= now() + interval '2 hours'
                AND NOT (s.hooks_fired ? ('t_minus_2h:' || card.event_id)))
               OR (card.start_at > now() + interval '2 hours'
                AND card.start_at <= now() + interval '24 hours'
                AND NOT (s.hooks_fired ? ('t_minus_24h:' || card.event_id)))))
       )
     ORDER BY s.checked_at ASC
     LIMIT $2)
 RETURNING state.conversation_id,
           (SELECT legacy_session_id FROM cloud_chat_conversations
             WHERE conversation_id = state.conversation_id),
           (SELECT latest_message_sequence FROM cloud_chat_conversations
             WHERE conversation_id = state.conversation_id),
           state.seen_sequence,
           state.hooks_fired"
);

#[derive(Debug, Deserialize)]
pub struct RunOutput {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default, rename = "hooksHandled")]
    pub hooks_handled: Vec<String>,
}

/// Parses the runner's JSON reply. A bare string is tolerated as a message so
/// a model that forgets the envelope still posts rather than failing.
pub fn parse_run_output(text: &str) -> RunOutput {
    let trimmed = text.trim();
    if let Ok(output) = serde_json::from_str::<RunOutput>(trimmed) {
        return output;
    }
    let message =
        (!trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("null")).then(|| trimmed.to_string());
    RunOutput {
        message,
        hooks_handled: Vec::new(),
    }
}

/// One sweep pass. Returns the number of runs queued.
pub async fn sweep(pool: &PgPool, config: &PipConfig) -> Result<usize, sqlx_core::Error> {
    // A chat PiP is already in but has no state yet starts at its newest
    // message, like a chat PiP just joined.
    query(
        "INSERT INTO cloud_pip_conversation_state (conversation_id, seen_sequence)
         SELECT conversation.conversation_id, conversation.latest_message_sequence
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
          AND member.account_id = $1 AND member.membership_state = 'active'
         WHERE conversation.kind = ANY($2)
         ON CONFLICT (conversation_id) DO NOTHING",
    )
    .bind(&config.account_id)
    .bind(super::membership::PIP_CONVERSATION_KINDS)
    .execute(pool)
    .await?;

    let candidates: Vec<(Uuid, Option<String>, i64, i64, Value)> = query_as(SWEEP_SQL)
        .bind(&config.account_id)
        .bind(SWEEP_BATCH)
        .fetch_all(pool)
        .await?;

    let mut queued = 0;
    for (conversation_id, legacy_session_id, latest_sequence, seen_sequence, hooks_fired) in
        candidates
    {
        let Some(legacy_session_id) = legacy_session_id else {
            continue;
        };
        let candidate = Candidate {
            conversation_id,
            legacy_session_id,
            latest_sequence,
            seen_sequence,
            hooks_fired,
        };
        if enqueue(pool, config, &candidate).await? {
            queued += 1;
        }
    }
    Ok(queued)
}

async fn enqueue(
    pool: &PgPool,
    config: &PipConfig,
    candidate: &Candidate,
) -> Result<bool, sqlx_core::Error> {
    let input = build_input(pool, config, candidate).await?;
    let hook_names: Vec<&str> = input["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hook| hook["name"].as_str())
        .collect();
    // New chat alone is checked for free first: small talk with no day, time,
    // place, or plan word (or no answer while a card is open) never reaches
    // the model.
    let only_new_messages = hook_names == ["new_messages"];
    let worth_a_look = !only_new_messages || {
        let new_texts: Vec<String> = input["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|message| message["isNew"] == json!(true) && message["fromPip"] != json!(true))
            .filter_map(|message| message["text"].as_str().map(str::to_string))
            .collect();
        context::worth_a_look(&new_texts, !input["openCard"].is_null())
    };
    if hook_names.is_empty() || !worth_a_look {
        // Nothing to react to after all (for example a card whose reminder
        // already fired). Advance the cursor so the row stops looking dirty.
        query(
            "UPDATE cloud_pip_conversation_state SET seen_sequence = $2, updated_at = now()
             WHERE conversation_id = $1 AND active_run_id IS NULL",
        )
        .bind(candidate.conversation_id)
        .bind(candidate.latest_sequence)
        .execute(pool)
        .await?;
        return Ok(false);
    }

    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let mut tx = pool.begin().await?;
    let reserved = query(
        "UPDATE cloud_pip_conversation_state
         SET active_run_id = $2, seen_sequence = $3, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id IS NULL",
    )
    .bind(candidate.conversation_id)
    .bind(&run_id)
    .bind(candidate.latest_sequence)
    .execute(&mut *tx)
    .await?;
    if reserved.rows_affected() == 0 {
        return Ok(false);
    }
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (
             run_id, idempotency_key, request_message_id, session_id, owner_account_id,
             requester_account_id, status, prompt, system_prompt, runtime_route_json,
             created_at, updated_at
         ) VALUES ($1, $1, $1, $2, $3, $3, 'queued', $4, $5, $6, $7, $7)",
    )
    .bind(&run_id)
    .bind(&candidate.legacy_session_id)
    .bind(&config.account_id)
    .bind(input.to_string())
    .bind(PIP_SYSTEM_PROMPT)
    .bind(config.model_routing())
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

struct ActiveRun {
    conversation_id: Uuid,
    owner_account_id: String,
    created_at: String,
    input: Value,
}

async fn active_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<ActiveRun>, sqlx_core::Error> {
    let row: Option<(String, Uuid, String, String)> = query_as(
        "SELECT run.prompt, state.conversation_id, run.owner_account_id, run.created_at
         FROM cloud_agent_fallback_runs run
         JOIN cloud_pip_conversation_state state ON state.active_run_id = run.run_id
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(prompt, conversation_id, owner_account_id, created_at)| ActiveRun {
            conversation_id,
            owner_account_id,
            created_at,
            input: serde_json::from_str(&prompt).unwrap_or(Value::Null),
        },
    ))
}

/// Posts PiP's words as their own message, with `@Handle` mentions resolved.
async fn post_text(
    pool: &PgPool,
    run_id: &str,
    run: &ActiveRun,
    text: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let members: Vec<(String, String)> = query_as(
        "SELECT member.account_id, COALESCE(account.display_name, 'Member')
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'",
    )
    .bind(run.conversation_id)
    .fetch_all(pool)
    .await?;
    let mentions = resolve_mentions(text, &members);
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, format!("{run_id}:text").as_bytes()),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [{"type": "text", "text": encode_pip_message_with_mentions(text, mentions)}],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    match crate::chat_sync::store::send_message(
        pool,
        &run.owner_account_id,
        run.conversation_id,
        request,
    )
    .await
    {
        Ok(outcome) => Ok(Some(outcome.value.id.to_string())),
        Err(error) => {
            eprintln!("[pip] Could not post PiP's text message: {error}");
            Ok(None)
        }
    }
}

/// Every reminder a run was offered counts as fired once the run finishes,
/// whether PiP posted a nudge or chose to stay silent. The sweep keeps picking
/// a chat while a due reminder is unmarked, so waiting for the model to list
/// it in `hooksHandled` would rerun the chat every tick until the plan starts.
fn offered_reminders(input: &Value) -> Value {
    let mut hooks = json!({});
    for key in input["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hook| hook.get("key").and_then(Value::as_str))
        .filter(|key| key.starts_with("t_minus_"))
    {
        hooks[key] = json!(true);
    }
    hooks
}

/// Records a finished run: posts PiP's message (if any) into the conversation
/// and marks the one-shot reminders it was offered.
pub async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<(), sqlx_core::Error> {
    let Some(run) = active_run(pool, run_id, runner_id).await? else {
        return Ok(());
    };
    let output = parse_run_output(response_text);
    // A card the run touched gets its card message first (a new vote or
    // calendar card, or an in-place refresh); PiP's words follow as their own
    // message.
    let touched: Option<(String,)> = query_as(
        "SELECT event_id FROM cloud_plan_cards
         WHERE conversation_id = $1 AND updated_at >= $2::timestamptz
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(run.conversation_id)
    .bind(&run.created_at)
    .fetch_optional(pool)
    .await?;
    if let Some((event_id,)) = touched {
        if let Some(row) = crate::plan_cards::store::load(pool, &event_id).await? {
            if let Err(error) = sync_card_messages(pool, &run.owner_account_id, &row).await {
                eprintln!("[pip] Could not post the plan card: {error}");
            }
        }
    }
    let response_message_id = match output.message.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => post_text(pool, run_id, &run, text).await?,
        _ => None,
    };

    let hooks = offered_reminders(&run.input);

    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'completed', response_message_id = $3, updated_at = $4, completed_at = $4
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(&response_message_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    // PiP saw the card as its input showed it; its own tool calls are recorded
    // as they happen, so votes cast during the run still wake the next sweep.
    let card = &run.input["openCard"];
    if let (Some(event_id), Some(revision)) = (card["eventId"].as_str(), card["revision"].as_i64())
    {
        mark_card_seen(&mut *tx, run.conversation_id, event_id, revision).await?;
    }
    query(
        "UPDATE cloud_pip_conversation_state
         SET active_run_id = NULL, attempts = 0, last_error = NULL,
             hooks_fired = hooks_fired || $2::jsonb, updated_at = now()
         WHERE conversation_id = $1 AND active_run_id = $3",
    )
    .bind(run.conversation_id)
    .bind(hooks)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_output_accepts_json_and_bare_text() {
        let json =
            parse_run_output(r#"{"message":"Lunch card is up.","hooksHandled":["t_minus_24h"]}"#);
        assert_eq!(json.message.as_deref(), Some("Lunch card is up."));
        assert_eq!(json.hooks_handled, vec!["t_minus_24h".to_string()]);
        let silent = parse_run_output(r#"{"message":null,"hooksHandled":[]}"#);
        assert!(silent.message.is_none());
        let bare = parse_run_output("Still on for tomorrow?");
        assert_eq!(bare.message.as_deref(), Some("Still on for tomorrow?"));
        assert!(parse_run_output("   ").message.is_none());
    }

    #[test]
    fn offered_reminders_fire_even_when_the_run_stays_silent() {
        let input = json!({"hooks": [
            {"name": "new_messages", "sinceSequence": 4},
            {"name": "t_minus_24h", "key": "t_minus_24h:plan_a", "eventId": "plan_a"},
            {"name": "card_changed", "eventId": "plan_a", "revision": 3},
        ]});
        assert_eq!(
            offered_reminders(&input),
            json!({"t_minus_24h:plan_a": true})
        );
        assert_eq!(offered_reminders(&json!({"hooks": []})), json!({}));
    }
}
