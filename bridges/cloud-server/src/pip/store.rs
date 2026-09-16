//! Sweep state, run creation and run completion for Pip.
//!
//! The sweep copies the digest worker's shape: a bounded batch of dirty
//! conversations, an atomic per-row reservation, one queued cloud run per
//! reservation. Unlike the digest worker it never clears its own progress on
//! failure; retries follow a bounded backoff so a persistently failing
//! provider costs at most a handful of calls per day.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::models::PlanCardRow;

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

/// Parses the text form Postgres gives for a `timestamptz` cast
/// (`2026-09-16 18:34:00+00`), which is not quite RFC 3339: the space and the
/// short `+00` offset both need normalizing.
pub(crate) use crate::plan_cards::store::parse_pg_timestamp;

fn encode_pip_message_with_mentions(text: &str, mentions: Vec<Value>) -> String {
    let payload =
        json!({"schemaVersion": 1, "kind": "message", "text": text, "mentions": mentions});
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
    Value,
);

/// `@Handle` for a member: the display name without spaces, which is what the
/// clients' mention parsers match a token against.
pub(crate) fn mention_handle(display_name: &str) -> String {
    display_name
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Resolves `@Handle` tokens in Pip's text to member mentions in the shape
/// the clients render and notify on. Unknown handles stay plain text.
pub(crate) fn resolve_mentions(text: &str, members: &[(String, String)]) -> Vec<Value> {
    let mut mentions = Vec::new();
    let mut utf16_offset = 0usize;
    let mut chars = text.char_indices().peekable();
    let mut previous: Option<char> = None;
    while let Some((byte_index, c)) = chars.next() {
        if c == '@' && previous.is_none_or(|p| !p.is_alphanumeric()) {
            let start_utf16 = utf16_offset;
            let mut handle = String::new();
            let mut token_utf16 = c.len_utf16();
            while let Some((_, next)) = chars.peek() {
                if next.is_alphanumeric() {
                    handle.push(*next);
                    token_utf16 += next.len_utf16();
                    chars.next();
                } else {
                    break;
                }
            }
            utf16_offset += token_utf16;
            previous = handle.chars().last().or(Some(c));
            if handle.is_empty() {
                continue;
            }
            let matched: Vec<&(String, String)> = members
                .iter()
                .filter(|(_, display_name)| {
                    mention_handle(display_name).eq_ignore_ascii_case(&handle)
                })
                .collect();
            // An ambiguous handle must never pick a member by position.
            if let [(account_id, display_name)] = matched.as_slice() {
                mentions.push(json!({
                    "label": mention_handle(display_name),
                    "targetKind": "person",
                    "targetIdentityId": account_id,
                    "humanId": account_id,
                    "displayText": format!("@{handle}"),
                    "displayLabel": display_name,
                    "startUtf16": start_utf16,
                    "lengthUtf16": token_utf16,
                }));
            }
            let _ = byte_index;
            continue;
        }
        utf16_offset += c.len_utf16();
        previous = Some(c);
    }
    mentions
}

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
                     AND card.revision > COALESCE((s.hooks_fired->>'card_seen_revision')::bigint, 0)
                     AND card.updated_at <= now() - interval '45 seconds'
                 )
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

    let members: Vec<(String, Option<String>, String, Option<String>)> = query_as(
        "SELECT member.account_id, account.display_name, member.role, digest.timezone
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         LEFT JOIN cloud_account_digests digest ON digest.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.joined_at ASC",
    )
    .bind(candidate.conversation_id)
    .fetch_all(pool)
    .await?;
    let member_timezone = |account_id: &str| -> Option<String> {
        members
            .iter()
            .find(|(id, _, _, _)| id == account_id)
            .and_then(|(_, _, _, timezone)| timezone.clone())
    };

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
                    unresolved_fields, options
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
    let mut organizer_account_id: Option<String> = None;
    if let Some((
        event_id,
        revision,
        state,
        title,
        start_at,
        end_at,
        location,
        unresolved,
        options,
    )) = card
    {
        let seen_revision = candidate
            .hooks_fired
            .get("card_seen_revision")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if revision > seen_revision {
            hooks.push(json!({
                "name": "card_changed",
                "key": format!("card_seen_revision"),
                "eventId": event_id,
                "revision": revision,
                "detail": "Members responded or voted on the card since your last look.",
            }));
        }
        let participants: Vec<(String, String, bool, String)> = query_as(
            "SELECT account_id, display_name, organizer, rsvp
             FROM cloud_plan_card_participants WHERE event_id = $1
             ORDER BY organizer DESC, display_name ASC",
        )
        .bind(&event_id)
        .fetch_all(pool)
        .await?;
        organizer_account_id = participants
            .iter()
            .find(|(_, _, organizer, _)| *organizer)
            .map(|(account_id, _, _, _)| account_id.clone());
        if let Some(start) = start_at.as_deref().and_then(parse_pg_timestamp) {
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
            "options": options,
            "participants": participants.into_iter().map(|(account_id, display_name, organizer, rsvp)| json!({
                "participantId": account_id,
                "displayName": display_name,
                "organizer": organizer,
                "rsvp": rsvp,
            })).collect::<Vec<_>>(),
        });
    }

    // Prefer the open card's organizer's timezone, since that's whose "now"
    // the plan is really being scheduled around; fall back to whichever
    // member happens to have one on file.
    let organizer_timezone = organizer_account_id
        .and_then(|account_id| member_timezone(&account_id))
        .or_else(|| {
            members
                .iter()
                .find_map(|(_, _, _, timezone)| timezone.clone())
        });

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
        "members": members.into_iter().map(|(account_id, display_name, role, timezone)| {
            let display_name = display_name.unwrap_or_else(|| "Member".to_string());
            json!({
                "participantId": account_id,
                "displayName": display_name,
                "handle": format!("@{}", mention_handle(&display_name)),
                "role": role,
                "isPip": account_id == config.account_id,
                "timezone": timezone,
            })
        }).collect::<Vec<_>>(),
        "organizerTimezone": organizer_timezone,
        "openCard": open_card,
        "messages": messages,
        "hooks": hooks,
        "now": Utc::now().to_rfc3339(),
    }))
}

/// The current card of a conversation as a `plan_card` message block, so
/// clients can render the card inline with Pip's message. `None` when the
/// conversation has no card or the card was not touched since `since`.
async fn plan_card_block(
    pool: &PgPool,
    conversation_id: Uuid,
    since: &str,
) -> Result<Option<Value>, sqlx_core::Error> {
    let card: Option<CardRow> = query_as(
        "SELECT event_id, revision, state, title, start_at::text, end_at::text, location,
                unresolved_fields, options
         FROM cloud_plan_cards
         WHERE conversation_id = $1 AND updated_at >= $2::timestamptz
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(conversation_id)
    .bind(since)
    .fetch_optional(pool)
    .await?;
    let Some((event_id, revision, state, title, start_at, end_at, location, unresolved, options)) =
        card
    else {
        return Ok(None);
    };
    let participants: Vec<(String, String, bool, String)> = query_as(
        "SELECT account_id, display_name, organizer, rsvp
         FROM cloud_plan_card_participants WHERE event_id = $1
         ORDER BY organizer DESC, display_name ASC",
    )
    .bind(&event_id)
    .fetch_all(pool)
    .await?;
    let rfc3339 = |value: Option<String>| {
        value
            .as_deref()
            .and_then(parse_pg_timestamp)
            .map(|instant| instant.to_rfc3339())
    };
    Ok(Some(json!({
        "type": "plan_card",
        "eventId": event_id,
        "revision": revision,
        "state": state,
        "title": title,
        "startAt": rfc3339(start_at),
        "endAt": rfc3339(end_at),
        "location": location,
        "unresolvedFields": unresolved,
        "options": options,
        "participants": participants.into_iter().map(|(account_id, display_name, organizer, rsvp)| json!({
            "participantId": account_id,
            "displayName": display_name,
            "organizer": organizer,
            "rsvp": rsvp,
        })).collect::<Vec<_>>(),
    })))
}

/// The same `plan_card` block `plan_card_block` derives from the database,
/// built from a card the store just returned.
pub(crate) fn card_block_from_row(row: &PlanCardRow) -> Value {
    json!({
        "type": "plan_card",
        "eventId": row.event_id,
        "revision": row.revision,
        "state": row.state.as_db_str(),
        "title": row.title,
        "startAt": row.start_at,
        "endAt": row.end_at,
        "location": row.location,
        "unresolvedFields": row.unresolved_fields,
        "options": serde_json::to_value(&row.options).unwrap_or_else(|_| json!([])),
        "participants": row.participants.iter().map(|participant| json!({
            "participantId": participant.account_id,
            "displayName": participant.display_name,
            "organizer": participant.organizer,
            "rsvp": participant.rsvp.as_db_str(),
        })).collect::<Vec<_>>(),
    })
}

/// Keeps the card in Pip's newest message current after a member changed it
/// from a client. The message is refreshed in place, so the group sees the
/// vote on the card itself, with no new chat line and no model run. Returns
/// false when no Pip message carries this card yet.
pub(crate) async fn refresh_card_message(
    pool: &PgPool,
    pip_account_id: &str,
    row: &PlanCardRow,
) -> Result<bool, sqlx_core::Error> {
    let Ok(conversation_id) = Uuid::parse_str(&row.conversation_id) else {
        return Ok(false);
    };
    let probe = json!([{"type": "plan_card", "eventId": row.event_id}]);
    let holder: Option<(Uuid, Value)> = query_as(
        "SELECT message_id, content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2 AND deleted_at IS NULL
           AND content->'blocks' @> $3::jsonb
         ORDER BY conversation_sequence DESC LIMIT 1",
    )
    .bind(conversation_id)
    .bind(pip_account_id)
    .bind(&probe)
    .fetch_optional(pool)
    .await?;
    let Some((message_id, mut content)) = holder else {
        return Ok(false);
    };
    if let Some(blocks) = content.get_mut("blocks").and_then(Value::as_array_mut) {
        for block in blocks.iter_mut() {
            if block.get("type").and_then(Value::as_str) == Some("plan_card")
                && block.get("eventId").and_then(Value::as_str) == Some(row.event_id.as_str())
            {
                *block = card_block_from_row(row);
            }
        }
    }
    crate::chat_sync::store::refresh_server_message_content(
        pool,
        pip_account_id,
        message_id,
        content,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
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
    let mut posted_sequence: Option<i64> = None;
    let card_block = plan_card_block(pool, run.conversation_id, &run.created_at).await?;
    // The card and Pip's words are two messages: the card first, as its own
    // message the group acts on, then the guidance text below it.
    let mut outgoing: Vec<(&str, Vec<Value>)> = Vec::new();
    if let Some(block) = card_block {
        outgoing.push(("card", vec![block]));
    }
    if let Some(text) = message {
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
        outgoing.push((
            "text",
            vec![json!({
                "type": "text",
                "text": encode_pip_message_with_mentions(text, mentions),
            })],
        ));
    }
    for (part, blocks) in outgoing {
        let request = SendMessageRequest {
            client_message_id: Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("{run_id}:{part}").as_bytes(),
            ),
            kind: "text".to_string(),
            content: json!({
                "schema": 1,
                "blocks": blocks,
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
            Ok(outcome) => {
                response_message_id = Some(outcome.value.id.to_string());
                posted_sequence = Some(outcome.value.conversation_sequence);
            }
            Err(error) => {
                eprintln!("[pip] Could not post Pip's {part} message: {error}");
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

    // The card as it stands after this run, so member votes during the run
    // are seen and Pip's own tool calls never wake the next sweep.
    let card_revision: Option<(i64,)> = query_as(
        "SELECT revision FROM cloud_plan_cards
         WHERE conversation_id = $1 AND state <> 'canceled'
         ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(run.conversation_id)
    .fetch_optional(pool)
    .await?;
    hooks["card_seen_revision"] = json!(card_revision.map(|row| row.0).unwrap_or(0));

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
    // Pip's own message must not wake the next sweep: move the cursor past it.
    query(
        "UPDATE cloud_pip_conversation_state
         SET active_run_id = NULL, attempts = 0, last_error = NULL,
             hooks_fired = hooks_fired || $2::jsonb,
             seen_sequence = GREATEST(seen_sequence, COALESCE($4, seen_sequence)),
             updated_at = now()
         WHERE conversation_id = $1 AND active_run_id = $3",
    )
    .bind(run.conversation_id)
    .bind(hooks)
    .bind(run_id)
    .bind(posted_sequence)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
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
    fn postgres_timestamp_text_parses() {
        let parsed = parse_pg_timestamp("2026-09-16 18:34:00+00").expect("pg text");
        assert_eq!(parsed.to_rfc3339(), "2026-09-16T18:34:00+00:00");
        assert!(parse_pg_timestamp("2026-09-19T12:30:00+03:00").is_some());
        assert!(parse_pg_timestamp("2026-09-16 18:34:00.123456+02").is_some());
        assert!(parse_pg_timestamp("Saturday").is_none());
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
        let encoded = encode_pip_message_with_mentions("Ramen at 12:30 works", Vec::new());
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
