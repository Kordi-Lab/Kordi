use chrono::DateTime;
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgConnection, PgPool, Postgres};
use uuid::Uuid;

use super::models::{
    PlanCardParticipantStatus, PlanCardProposeArgs, PlanCardRow, PlanCardRsvp, PlanCardState,
    PlanCardStoreError,
};

async fn require_active_member(
    executor: impl Executor<'_, Database = Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), PlanCardStoreError> {
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(executor)
    .await?;
    if row.is_some() {
        Ok(())
    } else {
        Err(PlanCardStoreError::Forbidden)
    }
}

type PlanCardRowTuple = (
    String,
    Uuid,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    serde_json::Value,
    serde_json::Value,
    Option<String>,
);

/// Postgres renders `timestamptz::text` as `2026-09-16 18:34:00+00`, which is
/// not RFC 3339. Accept that form and proper RFC 3339 alike.
pub(crate) fn parse_pg_timestamp(value: &str) -> Option<DateTime<chrono::FixedOffset>> {
    let mut text = value.trim().replacen(' ', "T", 1);
    let tail = text.len().saturating_sub(3);
    if text.len() >= 3
        && matches!(text.as_bytes()[tail], b'+' | b'-')
        && text[tail + 1..].chars().all(|c| c.is_ascii_digit())
    {
        text.push_str(":00");
    }
    DateTime::parse_from_rfc3339(&text).ok()
}

/// Card instants leave the store as RFC 3339 so iOS and desktop parse them
/// the same way whether they arrived in a message block or an action reply.
fn rfc3339_instant(value: Option<String>) -> Option<String> {
    value.map(|raw| {
        parse_pg_timestamp(&raw)
            .map(|instant| instant.to_rfc3339())
            .unwrap_or(raw)
    })
}

async fn fetch_row(
    conn: &mut PgConnection,
    event_id: &str,
) -> Result<Option<PlanCardRow>, sqlx_core::Error> {
    let card: Option<PlanCardRowTuple> = query_as(
        "SELECT event_id, conversation_id, revision, state, title, \
                start_at::text, end_at::text, location, \
                unresolved_fields, source_message_ids, note \
         FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((
        event_id,
        conversation_id,
        revision,
        state,
        title,
        start_at,
        end_at,
        location,
        unresolved_fields,
        source_message_ids,
        note,
    )) = card
    else {
        return Ok(None);
    };

    let participant_rows: Vec<(String, String, bool, String)> = query_as(
        "SELECT account_id, display_name, organizer, rsvp \
         FROM cloud_plan_card_participants WHERE event_id = $1 \
         ORDER BY organizer DESC, display_name ASC",
    )
    .bind(&event_id)
    .fetch_all(&mut *conn)
    .await?;

    let participants = participant_rows
        .into_iter()
        .map(
            |(account_id, display_name, organizer, rsvp)| PlanCardParticipantStatus {
                account_id,
                display_name,
                organizer,
                rsvp: PlanCardRsvp::from_db_str(&rsvp).unwrap_or(PlanCardRsvp::Pending),
            },
        )
        .collect();

    Ok(Some(PlanCardRow {
        event_id,
        conversation_id: conversation_id.to_string(),
        revision,
        state: PlanCardState::from_db_str(&state).unwrap_or(PlanCardState::Polling),
        title,
        start_at: rfc3339_instant(start_at),
        end_at: rfc3339_instant(end_at),
        location,
        unresolved_fields: json_string_array(unresolved_fields),
        source_message_ids: json_string_array(source_message_ids),
        participants,
        note,
    }))
}

fn json_string_array(value: serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                serde_json::Value::String(text) => Some(text),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

async fn require_row(
    conn: &mut PgConnection,
    event_id: &str,
) -> Result<PlanCardRow, PlanCardStoreError> {
    fetch_row(conn, event_id)
        .await?
        .ok_or(PlanCardStoreError::NotFound)
}

pub async fn propose(
    pool: &PgPool,
    acting_account_id: &str,
    args: PlanCardProposeArgs,
) -> Result<PlanCardRow, PlanCardStoreError> {
    if !matches!(
        args.state,
        PlanCardState::Polling | PlanCardState::AwaitingConfirmation
    ) {
        return Err(PlanCardStoreError::InvalidTransition(
            "propose only accepts polling or awaitingConfirmation".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("plan_card_conversation:{}", args.conversation_id))
        .execute(&mut *tx)
        .await?;
    require_active_member(&mut *tx, args.conversation_id, acting_account_id).await?;

    let event_id = if let Some(existing_event_id) = args.existing_event_id {
        let existing_revision = args.existing_revision.ok_or_else(|| {
            PlanCardStoreError::InvalidTransition(
                "existingRevision is required alongside existingEventId".to_string(),
            )
        })?;
        let updated: Option<(String,)> = query_as(
            "UPDATE cloud_plan_cards SET \
                title = $3, start_at = $4::timestamptz, end_at = $5::timestamptz, \
                location = $6, state = $7, unresolved_fields = $8, \
                source_message_ids = $9, revision = revision + 1, updated_at = now() \
             WHERE event_id = $1 AND revision = $2 AND conversation_id = $10 \
               AND state NOT IN ('confirmed', 'canceled') \
             RETURNING event_id",
        )
        .bind(&existing_event_id)
        .bind(existing_revision)
        .bind(&args.title)
        .bind(&args.start_at)
        .bind(&args.end_at)
        .bind(&args.location)
        .bind(args.state.as_db_str())
        .bind(serde_json::Value::Array(
            args.unresolved_fields
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ))
        .bind(serde_json::Value::Array(
            args.source_message_ids
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ))
        .bind(args.conversation_id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some((event_id,)) = updated else {
            // Distinguish "doesn't exist" / "wrong conversation" / "already
            // terminal" from a plain stale revision so the caller knows
            // whether retrying with a fresh read can possibly help.
            let current: Option<(String, i64)> = query_as(
                "SELECT state, revision FROM cloud_plan_cards \
                 WHERE event_id = $1 AND conversation_id = $2",
            )
            .bind(&existing_event_id)
            .bind(args.conversation_id)
            .fetch_optional(&mut *tx)
            .await?;
            return Err(match current {
                None => PlanCardStoreError::NotFound,
                Some((state, _)) if state == "confirmed" || state == "canceled" => {
                    PlanCardStoreError::InvalidTransition(format!(
                        "cannot update a plan card that is already {state}"
                    ))
                }
                Some(_) => PlanCardStoreError::RevisionConflict,
            });
        };
        query("DELETE FROM cloud_plan_card_participants WHERE event_id = $1")
            .bind(&event_id)
            .execute(&mut *tx)
            .await?;
        event_id
    } else {
        let event_id = format!("plan_{}", Uuid::new_v4().simple());
        query(
            "INSERT INTO cloud_plan_cards ( \
                event_id, conversation_id, state, title, start_at, end_at, location, \
                unresolved_fields, source_message_ids, revision, created_by_account_id \
             ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9, 1, $10)",
        )
        .bind(&event_id)
        .bind(args.conversation_id)
        .bind(args.state.as_db_str())
        .bind(&args.title)
        .bind(&args.start_at)
        .bind(&args.end_at)
        .bind(&args.location)
        .bind(serde_json::Value::Array(
            args.unresolved_fields
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ))
        .bind(serde_json::Value::Array(
            args.source_message_ids
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ))
        .bind(acting_account_id)
        .execute(&mut *tx)
        .await?;
        event_id
    };

    for participant in &args.participants {
        let rsvp = if participant.organizer {
            PlanCardRsvp::Yes
        } else {
            PlanCardRsvp::Pending
        };
        query(
            "INSERT INTO cloud_plan_card_participants \
                (event_id, account_id, display_name, organizer, rsvp, responded_at) \
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 THEN now() ELSE NULL END)",
        )
        .bind(&event_id)
        .bind(&participant.account_id)
        .bind(&participant.display_name)
        .bind(participant.organizer)
        .bind(rsvp.as_db_str())
        .execute(&mut *tx)
        .await?;
    }

    let row = require_row(&mut tx, &event_id).await?;
    tx.commit().await?;
    Ok(row)
}

async fn lock_event(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    event_id: &str,
) -> Result<(), PlanCardStoreError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("plan_card_event:{event_id}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn rsvp(
    pool: &PgPool,
    event_id: &str,
    revision: i64,
    account_id: &str,
    response: PlanCardRsvp,
    note: Option<&str>,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, i64)> =
        query_as("SELECT conversation_id, revision FROM cloud_plan_cards WHERE event_id = $1")
            .bind(event_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (conversation_id, current_revision) = current.ok_or(PlanCardStoreError::NotFound)?;
    if current_revision != revision {
        return Err(PlanCardStoreError::RevisionConflict);
    }
    require_active_member(&mut *tx, conversation_id, account_id).await?;

    let updated_participant = query(
        "UPDATE cloud_plan_card_participants SET rsvp = $1, responded_at = now() \
         WHERE event_id = $2 AND account_id = $3",
    )
    .bind(response.as_db_str())
    .bind(event_id)
    .bind(account_id)
    .execute(&mut *tx)
    .await?;
    if updated_participant.rows_affected() == 0 {
        return Err(PlanCardStoreError::NotAParticipant);
    }

    query("UPDATE cloud_plan_cards SET revision = revision + 1, note = $1, updated_at = now() WHERE event_id = $2")
        .bind(note)
        .bind(event_id)
        .execute(&mut *tx)
        .await?;

    let row = require_row(&mut tx, event_id).await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn confirm(
    pool: &PgPool,
    event_id: &str,
    revision: i64,
    confirmed_by: &str,
    note: Option<&str>,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, String, i64)> = query_as(
        "SELECT conversation_id, state, revision FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (conversation_id, state, current_revision) = current.ok_or(PlanCardStoreError::NotFound)?;
    require_active_member(&mut *tx, conversation_id, confirmed_by).await?;

    match state.as_str() {
        "canceled" => {
            return Err(PlanCardStoreError::InvalidTransition(
                "cannot confirm a canceled plan".to_string(),
            ));
        }
        "confirmed" => {
            // Already confirmed: confirming again changes nothing. Harmless
            // even if the caller's revision is stale, since the only effect
            // confirm has is being confirmed, which is already true.
            let row = require_row(&mut tx, event_id).await?;
            tx.commit().await?;
            return Ok(row);
        }
        _ => {}
    }
    if current_revision != revision {
        return Err(PlanCardStoreError::RevisionConflict);
    }

    query(
        "UPDATE cloud_plan_cards SET state = 'confirmed', revision = revision + 1, \
            note = $1, updated_at = now() WHERE event_id = $2",
    )
    .bind(note)
    .bind(event_id)
    .execute(&mut *tx)
    .await?;

    let row = require_row(&mut tx, event_id).await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn reopen(
    pool: &PgPool,
    event_id: &str,
    revision: i64,
    acting_account_id: &str,
    reason: &str,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, String, i64)> = query_as(
        "SELECT conversation_id, state, revision FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (conversation_id, state, current_revision) = current.ok_or(PlanCardStoreError::NotFound)?;
    require_active_member(&mut *tx, conversation_id, acting_account_id).await?;

    if state != "confirmed" {
        return Err(PlanCardStoreError::InvalidTransition(
            "reopen only applies to a confirmed plan".to_string(),
        ));
    }
    if current_revision != revision {
        return Err(PlanCardStoreError::RevisionConflict);
    }

    query(
        "UPDATE cloud_plan_cards SET state = 'awaiting_confirmation', revision = revision + 1, \
            note = $1, updated_at = now() WHERE event_id = $2",
    )
    .bind(reason)
    .bind(event_id)
    .execute(&mut *tx)
    .await?;

    let row = require_row(&mut tx, event_id).await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn cancel(
    pool: &PgPool,
    event_id: &str,
    revision: i64,
    canceled_by: &str,
    reason: Option<&str>,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, String, i64)> = query_as(
        "SELECT conversation_id, state, revision FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (conversation_id, state, current_revision) = current.ok_or(PlanCardStoreError::NotFound)?;
    require_active_member(&mut *tx, conversation_id, canceled_by).await?;

    if state == "canceled" {
        // Retrying a cancellation is safe: it's already canceled.
        let row = require_row(&mut tx, event_id).await?;
        tx.commit().await?;
        return Ok(row);
    }
    if current_revision != revision {
        return Err(PlanCardStoreError::RevisionConflict);
    }

    query(
        "UPDATE cloud_plan_cards SET state = 'canceled', revision = revision + 1, \
            note = $1, updated_at = now() WHERE event_id = $2",
    )
    .bind(reason)
    .bind(event_id)
    .execute(&mut *tx)
    .await?;

    let row = require_row(&mut tx, event_id).await?;
    tx.commit().await?;
    Ok(row)
}
