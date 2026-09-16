//! Sweep state, run creation and run completion for Pip.
//!
//! The sweep copies the digest worker's shape: a bounded batch of dirty
//! conversations, an atomic per-row reservation, one queued cloud run per
//! reservation. Unlike the digest worker it never clears its own progress on
//! failure; retries follow a bounded backoff so a persistently failing
//! provider costs at most a handful of calls per day.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;

use super::config::PipConfig;
use super::prompt::PIP_SYSTEM_PROMPT;

pub const RUN_PREFIX: &str = "pip_";
const SWEEP_BATCH: i64 = 10;
const RECENT_MESSAGE_LIMIT: i64 = 40;
const MESSAGE_TEXT_LIMIT: usize = 1200;
const CLOUD_MESSAGE_PREFIXES: [&str; 2] = ["kordi-cloud-message:", "kordi-cloud-group:"];

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
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        return RunOutput {
            message: None,
            hooks_handled: Vec::new(),
        };
    }
    RunOutput {
        message: Some(trimmed.to_string()),
        hooks_handled: Vec::new(),
    }
}

fn decode_cloud_text(text: &str) -> String {
    for prefix in CLOUD_MESSAGE_PREFIXES {
        if let Some(encoded) = text.strip_prefix(prefix) {
            if let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('=')) {
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(inner) = value.get("text").and_then(Value::as_str) {
                        return inner.to_string();
                    }
                    if let Some(inner) = value
                        .get("message")
                        .and_then(|message| message.get("text"))
                        .and_then(Value::as_str)
                    {
                        return inner.to_string();
                    }
                }
            }
            return String::new();
        }
    }
    text.to_string()
}

fn message_text(content: &Value) -> String {
    let mut out = String::new();
    for block in content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&decode_cloud_text(text));
            }
        }
    }
    if out.chars().count() > MESSAGE_TEXT_LIMIT {
        out = out.chars().take(MESSAGE_TEXT_LIMIT).collect::<String>() + "…";
    }
    out
}

fn encode_pip_message(text: &str) -> String {
    let payload = json!({"schemaVersion": 1, "kind": "message", "text": text, "mentions": []});
    format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
    )
}

/// message_id, sequence, sender, sender display name, kind, content, created_at
type MessageRow = (String, i64, String, Option<String>, String, Value, String);
/// event_id, revision, state, title, start_at, end_at, location, unresolved_fields
type CardRow = (
    String,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Value,
);

struct Candidate {
    conversation_id: Uuid,
    legacy_session_id: String,
    latest_sequence: i64,
    seen_sequence: i64,
    hooks_fired: Value,
}

/// One sweep pass. Returns the number of runs queued.
pub async fn sweep(pool: &PgPool, config: &PipConfig) -> Result<usize, sqlx_core::Error> {
    query(
        "INSERT INTO cloud_pip_conversation_state (conversation_id)
         SELECT conversation.conversation_id
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

    let candidates: Vec<(Uuid, Option<String>, i64, i64, Value)> = query_as(
        "UPDATE cloud_pip_conversation_state state SET checked_at = now()
         WHERE state.conversation_id IN (
             SELECT s.conversation_id
             FROM cloud_pip_conversation_state s
             JOIN cloud_chat_conversations c ON c.conversation_id = s.conversation_id
             JOIN cloud_chat_conversation_members m
               ON m.conversation_id = c.conversation_id
              AND m.account_id = $1 AND m.membership_state = 'active'
             WHERE s.active_run_id IS NULL
               AND s.retry_after <= now()
               AND (
                 c.latest_message_sequence > s.seen_sequence
                 OR EXISTS (
                   SELECT 1 FROM cloud_plan_cards card
                   WHERE card.conversation_id = c.conversation_id
                     AND card.state IN ('polling', 'awaiting_confirmation', 'confirmed')
                     AND card.start_at IS NOT NULL
                     AND card.start_at > now()
                     AND (
                       (card.start_at <= now() + interval '24 hours'
                        AND NOT (s.hooks_fired ? ('t_minus_24h:' || card.event_id)))
                       OR
                       (card.start_at <= now() + interval '2 hours'
                        AND NOT (s.hooks_fired ? ('t_minus_2h:' || card.event_id)))
                     )
                 )
               )
             ORDER BY s.checked_at ASC
             LIMIT $2)
         RETURNING state.conversation_id,
                   (SELECT legacy_session_id FROM cloud_chat_conversations
                     WHERE conversation_id = state.conversation_id),
                   (SELECT latest_message_sequence FROM cloud_chat_conversations
                     WHERE conversation_id = state.conversation_id),
                   state.seen_sequence,
                   state.hooks_fired",
    )
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
    let hooks = input["hooks"].as_array().map(Vec::len).unwrap_or(0);
    if hooks == 0 {
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

async fn build_input(
    pool: &PgPool,
    config: &PipConfig,
    candidate: &Candidate,
) -> Result<Value, sqlx_core::Error> {
    let conversation: Option<(String, Option<String>, Option<String>)> = query_as(
        "SELECT kind, shared_title, group_title FROM cloud_chat_conversations
         WHERE conversation_id = $1",
    )
    .bind(candidate.conversation_id)
    .fetch_optional(pool)
    .await?;
    let (kind, shared_title, group_title) = conversation.unwrap_or_default();

    let members: Vec<(String, Option<String>, String)> = query_as(
        "SELECT member.account_id, account.display_name, member.role
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.joined_at ASC",
    )
    .bind(candidate.conversation_id)
    .fetch_all(pool)
    .await?;

    let messages: Vec<MessageRow> = query_as(
        "SELECT message.message_id::text, message.conversation_sequence, message.sender_account_id,
                account.display_name, message.message_kind, message.content,
                message.created_at::text
         FROM cloud_chat_messages message
         JOIN cloud_accounts account ON account.account_id = message.sender_account_id
         WHERE message.conversation_id = $1 AND message.deleted_at IS NULL
           AND message.message_kind IN ('text', 'voice')
         ORDER BY message.conversation_sequence DESC
         LIMIT $2",
    )
    .bind(candidate.conversation_id)
    .bind(RECENT_MESSAGE_LIMIT)
    .fetch_all(pool)
    .await?;

    let card: Option<CardRow> = query_as(
        "SELECT event_id, revision, state, title, start_at::text, end_at::text, location,
                    unresolved_fields
             FROM cloud_plan_cards
             WHERE conversation_id = $1 AND state <> 'canceled'
             ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(candidate.conversation_id)
    .fetch_optional(pool)
    .await?;

    let mut hooks: Vec<Value> = Vec::new();
    if candidate.latest_sequence > candidate.seen_sequence {
        hooks.push(json!({
            "name": "new_messages",
            "sinceSequence": candidate.seen_sequence,
        }));
    }
    let mut open_card = Value::Null;
    if let Some((event_id, revision, state, title, start_at, end_at, location, unresolved)) = card {
        let participants: Vec<(String, String, bool, String)> = query_as(
            "SELECT account_id, display_name, organizer, rsvp
             FROM cloud_plan_card_participants WHERE event_id = $1
             ORDER BY organizer DESC, display_name ASC",
        )
        .bind(&event_id)
        .fetch_all(pool)
        .await?;
        if let Some(start) = start_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(&value.replace(' ', "T")).ok())
        {
            let remaining = start.with_timezone(&Utc) - Utc::now();
            let fired = |key: &str| candidate.hooks_fired.get(key).is_some();
            if remaining > chrono::Duration::zero() {
                if remaining <= chrono::Duration::hours(2) {
                    let key = format!("t_minus_2h:{event_id}");
                    if !fired(&key) {
                        hooks.push(json!({"name": "t_minus_2h", "key": key, "eventId": event_id}));
                    }
                } else if remaining <= chrono::Duration::hours(24) {
                    let key = format!("t_minus_24h:{event_id}");
                    if !fired(&key) {
                        hooks.push(json!({"name": "t_minus_24h", "key": key, "eventId": event_id}));
                    }
                }
            }
        }
        open_card = json!({
            "eventId": event_id,
            "revision": revision,
            "state": state,
            "title": title,
            "startAt": start_at,
            "endAt": end_at,
            "location": location,
            "unresolvedFields": unresolved,
            "participants": participants.into_iter().map(|(account_id, display_name, organizer, rsvp)| json!({
                "participantId": account_id,
                "displayName": display_name,
                "organizer": organizer,
                "rsvp": rsvp,
            })).collect::<Vec<_>>(),
        });
    }

    let messages: Vec<Value> = messages
        .into_iter()
        .rev()
        .map(
            |(id, sequence, sender, display_name, message_kind, content, created_at)| {
                json!({
                    "messageId": id,
                    "sequence": sequence,
                    "senderId": sender,
                    "senderName": display_name.unwrap_or_else(|| "Member".to_string()),
                    "fromPip": sender == config.account_id,
                    "kind": message_kind,
                    "text": message_text(&content),
                    "createdAt": created_at,
                })
            },
        )
        .collect();

    Ok(json!({
        "pip": {"accountId": config.account_id, "name": config.name},
        "conversation": {
            "id": candidate.conversation_id.to_string(),
            "kind": kind,
            "title": group_title.or(shared_title),
        },
        "members": members.into_iter().map(|(account_id, display_name, role)| json!({
            "participantId": account_id,
            "displayName": display_name.unwrap_or_else(|| "Member".to_string()),
            "role": role,
            "isPip": account_id == config.account_id,
        })).collect::<Vec<_>>(),
        "openCard": open_card,
        "messages": messages,
        "hooks": hooks,
        "now": Utc::now().to_rfc3339(),
    }))
}

struct ActiveRun {
    conversation_id: Uuid,
    owner_account_id: String,
    input: Value,
}

async fn active_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<ActiveRun>, sqlx_core::Error> {
    let row: Option<(String, Uuid, String)> = query_as(
        "SELECT run.prompt, state.conversation_id, run.owner_account_id
         FROM cloud_agent_fallback_runs run
         JOIN cloud_pip_conversation_state state ON state.active_run_id = run.run_id
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(
        row.map(|(prompt, conversation_id, owner_account_id)| ActiveRun {
            conversation_id,
            owner_account_id,
            input: serde_json::from_str(&prompt).unwrap_or(Value::Null),
        }),
    )
}

/// Records a finished run: posts Pip's message (if any) into the conversation
/// and marks the one-shot hooks it handled.
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
    let message = output
        .message
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());

    let mut response_message_id: Option<String> = None;
    if let Some(text) = message {
        let request = SendMessageRequest {
            client_message_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, run_id.as_bytes()),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": [{"type": "text", "text": encode_pip_message(text)}],
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
            Ok(outcome) => response_message_id = Some(outcome.value.id.to_string()),
            Err(error) => {
                eprintln!("[pip] Could not post Pip's message: {error}");
            }
        }
    }

    let mut hooks = json!({});
    let offered: Vec<String> = run.input["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|hook| hook.get("key").and_then(Value::as_str).map(str::to_string))
        .collect();
    for handled in &output.hooks_handled {
        // Accept either the bare hook name or the exact key the input offered.
        for key in &offered {
            if key == handled || key.starts_with(&format!("{handled}:")) {
                hooks[key] = json!(true);
            }
        }
    }

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

/// Records a failed run and schedules the next attempt with bounded backoff.
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
         SET status = 'failed', error_code = $3, error_message = 'Pip could not finish this pass.',
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
        let attempts: Option<(i32,)> = query_as(
            "SELECT attempts + 1 FROM cloud_pip_conversation_state WHERE active_run_id = $1",
        )
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await?;
        let attempts = attempts.map(|(value,)| value).unwrap_or(1);
        query(
            "UPDATE cloud_pip_conversation_state
             SET active_run_id = NULL, attempts = $2, last_error = $3,
                 retry_after = now() + ($4 * interval '1 second'), updated_at = now()
             WHERE active_run_id = $1",
        )
        .bind(run_id)
        .bind(attempts)
        .bind(error_code)
        .bind(backoff_seconds(attempts) as f64)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Releases leases that expired without a completion so the conversation can
/// be swept again instead of staying blocked on a dead run.
pub async fn release_stale_runs(pool: &PgPool) -> Result<u64, sqlx_core::Error> {
    let stale: Vec<(String,)> = query_as(
        "SELECT state.active_run_id
         FROM cloud_pip_conversation_state state
         JOIN cloud_agent_fallback_runs run ON run.run_id = state.active_run_id
         WHERE state.active_run_id IS NOT NULL
           AND run.status IN ('failed', 'completed', 'cancelled')
           OR (run.status IN ('leased', 'running')
               AND run.lease_expires_at IS NOT NULL
               AND run.lease_expires_at::timestamptz < now() - interval '10 minutes')",
    )
    .fetch_all(pool)
    .await?;
    let mut released = 0;
    for (run_id,) in stale {
        fail(pool, &run_id, None, "lease_expired").await?;
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
        assert_eq!(backoff_seconds(1), 60);
        assert_eq!(backoff_seconds(2), 300);
        assert_eq!(backoff_seconds(3), 1_800);
        assert_eq!(backoff_seconds(4), 7_200);
        assert_eq!(backoff_seconds(5), 43_200);
        assert_eq!(backoff_seconds(50), 43_200);
    }

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
    fn cloud_envelopes_decode_to_their_text() {
        let encoded = encode_pip_message("Ramen at 12:30 works");
        assert_eq!(decode_cloud_text(&encoded), "Ramen at 12:30 works");
        assert_eq!(decode_cloud_text("plain"), "plain");
        assert_eq!(decode_cloud_text("kordi-cloud-message:!!notbase64"), "");
    }

    #[test]
    fn message_text_joins_text_blocks_and_bounds_length() {
        let long = "x".repeat(MESSAGE_TEXT_LIMIT + 50);
        let content = json!({"blocks": [{"type": "text", "text": "a"}, {"type": "voice"}, {"type": "text", "text": long}]});
        let text = message_text(&content);
        assert!(text.starts_with("a x"));
        assert!(text.ends_with('…'));
        assert!(text.chars().count() <= MESSAGE_TEXT_LIMIT + 3);
    }
}
