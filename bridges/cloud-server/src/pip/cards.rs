//! PiP's plan card messages, and which card revision PiP has already seen.

use serde_json::{json, Value};
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::models::{PlanCardRow, PlanCardState};

/// Key prefix in `cloud_pip_conversation_state.hooks_fired` holding the newest
/// revision of one card PiP has seen, so a vote wakes PiP once per change.
pub(crate) const CARD_SEEN_PREFIX: &str = "card_seen:";

/// The newest revision of `event_id` PiP has seen, or 0.
pub(crate) fn seen_revision(hooks_fired: &Value, event_id: &str) -> i64 {
    hooks_fired
        .get(format!("{CARD_SEEN_PREFIX}{event_id}"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// Records that PiP has seen `revision` of a card. The stored revision never
/// moves back, so a run finishing after PiP's own later action changes nothing.
pub(crate) async fn mark_card_seen<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    conversation_id: Uuid,
    event_id: &str,
    revision: i64,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_pip_conversation_state
         SET hooks_fired = jsonb_set(hooks_fired, ARRAY[$2::text], to_jsonb(GREATEST($3::bigint,
             CASE WHEN jsonb_typeof(hooks_fired->($2::text)) = 'number'
                  THEN (hooks_fired->>($2::text))::bigint ELSE 0 END))),
             updated_at = now()
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .bind(format!("{CARD_SEEN_PREFIX}{event_id}"))
    .bind(revision)
    .execute(executor)
    .await?;
    Ok(())
}

/// Which card a plan shows as: a vote while it polls between options, and a
/// calendar card for the plan itself once it is proposed as one concrete
/// option, confirmed, or canceled. They are separate messages.
pub(crate) fn card_view(row: &PlanCardRow) -> &'static str {
    if row.state == PlanCardState::Polling && !row.options.is_empty() {
        "vote"
    } else {
        "event"
    }
}

fn block_view(block: &Value) -> &'static str {
    match block.get("view").and_then(Value::as_str) {
        Some("vote") => "vote",
        Some("event") => "event",
        _ => {
            let polling = block.get("state").and_then(Value::as_str) == Some("polling");
            let has_options = block
                .get("options")
                .and_then(Value::as_array)
                .is_some_and(|options| !options.is_empty());
            if polling && has_options {
                "vote"
            } else {
                "event"
            }
        }
    }
}

/// A `plan_card` message block for one card view, built from the stored card.
pub(crate) fn card_block_from_row(row: &PlanCardRow, view: &str) -> Value {
    json!({
        "type": "plan_card",
        "view": view,
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

fn card_blocks<'a>(content: &'a Value, event_id: &'a str) -> impl Iterator<Item = &'a Value> {
    content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(move |block| {
            block.get("type").and_then(Value::as_str) == Some("plan_card")
                && block.get("eventId").and_then(Value::as_str) == Some(event_id)
        })
}

/// A carrier message's content with its card blocks for `row` brought up to
/// `row`'s revision, keeping each block's view. A block already at the same or
/// a newer revision is left alone, so a slower refresh never moves a card
/// back. `None` when nothing changes.
fn refreshed_card_content(mut content: Value, row: &PlanCardRow) -> Option<Value> {
    let mut changed = false;
    for block in content
        .get_mut("blocks")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let shows_card = block.get("type").and_then(Value::as_str) == Some("plan_card")
            && block.get("eventId").and_then(Value::as_str) == Some(row.event_id.as_str());
        let stored_revision = block.get("revision").and_then(Value::as_i64).unwrap_or(0);
        if shows_card && stored_revision < row.revision {
            *block = card_block_from_row(row, block_view(block));
            changed = true;
        }
    }
    changed.then_some(content)
}

/// Brings PiP's card messages for a plan up to date. Every message already
/// carrying the card is refreshed in place, keeping its own view, so votes and
/// answers show on the card with no new chat line. When the plan needs a view
/// no message shows yet (the vote card when a poll opens, the calendar card
/// when a poll resolves), PiP posts it as a new card-only message and its
/// sequence is returned.
pub(crate) async fn sync_card_messages(
    pool: &PgPool,
    pip_account_id: &str,
    row: &PlanCardRow,
) -> Result<Option<i64>, sqlx_core::Error> {
    let Ok(conversation_id) = Uuid::parse_str(&row.conversation_id) else {
        return Ok(None);
    };
    let wanted = card_view(row);
    let probe = json!([{"type": "plan_card", "eventId": row.event_id}]);
    let carriers: Vec<(Uuid, Value)> = query_as(
        "SELECT message_id, content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2 AND deleted_at IS NULL
           AND content->'blocks' @> $3::jsonb
         ORDER BY conversation_sequence DESC LIMIT 6",
    )
    .bind(conversation_id)
    .bind(pip_account_id)
    .bind(&probe)
    .fetch_all(pool)
    .await?;
    let has_carrier = !carriers.is_empty();
    let mut shows_wanted = false;
    for (message_id, content) in carriers {
        shows_wanted |=
            card_blocks(&content, &row.event_id).any(|block| block_view(block) == wanted);
        crate::chat_sync::store::refresh_server_message_content(
            pool,
            pip_account_id,
            message_id,
            |content| refreshed_card_content(content, row),
        )
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    }
    // A canceled plan updates the cards it already has; it never adds one.
    if shows_wanted || (row.state == PlanCardState::Canceled && has_carrier) {
        return Ok(None);
    }
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("{}:{}", row.event_id, wanted).as_bytes(),
        ),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [card_block_from_row(row, wanted)],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    // PiP's own messages never wake the sweep, so the cursor stays put and
    // members' messages posted meanwhile are still read.
    let outcome =
        crate::chat_sync::store::send_message(pool, pip_account_id, conversation_id, request)
            .await
            .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(Some(outcome.value.conversation_sequence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan_cards::models::PlanCardRow;

    fn row(revision: i64) -> PlanCardRow {
        PlanCardRow {
            event_id: "plan_a".to_string(),
            conversation_id: Uuid::nil().to_string(),
            revision,
            state: PlanCardState::Polling,
            title: "Dinner".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            unresolved_fields: Vec::new(),
            source_message_ids: Vec::new(),
            participants: Vec::new(),
            options: Vec::new(),
            note: None,
        }
    }

    #[test]
    fn a_card_block_never_moves_back_to_an_older_revision() {
        let content = json!({"blocks": [card_block_from_row(&row(6), "event")]});
        assert!(refreshed_card_content(content.clone(), &row(5)).is_none());
        assert!(refreshed_card_content(content.clone(), &row(6)).is_none());
        let newer = refreshed_card_content(content, &row(7)).expect("newer revision applies");
        assert_eq!(newer["blocks"][0]["revision"], 7);
        assert_eq!(newer["blocks"][0]["view"], "event");
    }
}
