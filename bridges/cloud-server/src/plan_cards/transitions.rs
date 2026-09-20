//! Card state changes after a proposal: answers, votes, confirmation,
//! reopening, and cancellation. Each runs under a per-card advisory lock.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::models::{PlanCardRow, PlanCardRsvp, PlanCardStoreError};
use super::store::{options_from_json, options_to_json, require_active_member, require_row};

pub(super) async fn lock_event(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    event_id: &str,
) -> Result<(), PlanCardStoreError> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("plan_card_event:{event_id}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Records one participant's answer. An answer is that person's own state,
/// so it applies at any revision: a member pressing a button on an older
/// snapshot must never be told to refresh first.
pub async fn rsvp(
    pool: &PgPool,
    event_id: &str,
    account_id: &str,
    response: PlanCardRsvp,
    note: Option<&str>,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, String)> =
        query_as("SELECT conversation_id, state FROM cloud_plan_cards WHERE event_id = $1")
            .bind(event_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (conversation_id, state) = current.ok_or(PlanCardStoreError::NotFound)?;
    if state == "canceled" {
        return Err(PlanCardStoreError::InvalidTransition(
            "cannot respond to a canceled plan".to_string(),
        ));
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
    super::projection::enqueue(&mut *tx, &row).await?;
    tx.commit().await?;
    Ok(row)
}

/// Records one participant's vote for an option while the card is polling.
/// A participant holds one vote at a time; voting again moves it. Like an
/// RSVP, a vote applies at any revision.
pub async fn vote(
    pool: &PgPool,
    event_id: &str,
    account_id: &str,
    option_id: &str,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, String, serde_json::Value)> = query_as(
        "SELECT conversation_id, state, options FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (conversation_id, state, options) = current.ok_or(PlanCardStoreError::NotFound)?;
    if state != "polling" {
        return Err(PlanCardStoreError::InvalidTransition(
            "votes are only open while the plan is polling".to_string(),
        ));
    }
    require_active_member(&mut *tx, conversation_id, account_id).await?;
    let participant: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_plan_card_participants WHERE event_id = $1 AND account_id = $2",
    )
    .bind(event_id)
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    if participant.is_none() {
        return Err(PlanCardStoreError::NotAParticipant);
    }
    let mut options = options_from_json(options);
    if !options.iter().any(|option| option.id == option_id) {
        return Err(PlanCardStoreError::InvalidTransition(format!(
            "unknown option {option_id}"
        )));
    }
    for option in &mut options {
        option.votes.retain(|voter| voter != account_id);
        if option.id == option_id {
            option.votes.push(account_id.to_string());
        }
    }
    query(
        "UPDATE cloud_plan_cards SET options = $1, revision = revision + 1, updated_at = now() \
         WHERE event_id = $2",
    )
    .bind(options_to_json(&options))
    .bind(event_id)
    .execute(&mut *tx)
    .await?;

    let row = require_row(&mut tx, event_id).await?;
    super::projection::enqueue(&mut *tx, &row).await?;
    tx.commit().await?;
    Ok(row)
}

/// Locks the plan in. With `option_id`, the chosen option's time and place
/// become the card's own, so a poll resolves into one concrete plan.
pub async fn confirm(
    pool: &PgPool,
    event_id: &str,
    revision: i64,
    confirmed_by: &str,
    option_id: Option<&str>,
    note: Option<&str>,
) -> Result<PlanCardRow, PlanCardStoreError> {
    let mut tx = pool.begin().await?;
    lock_event(&mut tx, event_id).await?;

    let current: Option<(Uuid, String, i64, serde_json::Value, bool)> = query_as(
        "SELECT conversation_id, state, revision, options, start_at IS NOT NULL FROM cloud_plan_cards WHERE event_id = $1",
    )
    .bind(event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (conversation_id, state, current_revision, options, has_start) =
        current.ok_or(PlanCardStoreError::NotFound)?;
    require_active_member(&mut *tx, conversation_id, confirmed_by).await?;

    match state.as_str() {
        "canceled" => {
            return Err(PlanCardStoreError::InvalidTransition(
                "cannot confirm a canceled plan".to_string(),
            ));
        }
        "confirmed" if !has_start => {
            return Err(PlanCardStoreError::InvalidTransition(
                "Set a date and time in chat before confirming this plan.".to_string(),
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
    let chosen = match option_id {
        Some(option_id) => Some(
            options_from_json(options)
                .into_iter()
                .find(|option| option.id == option_id)
                .ok_or_else(|| {
                    PlanCardStoreError::InvalidTransition(format!("unknown option {option_id}"))
                })?,
        ),
        None => None,
    };

    if !has_start
        && chosen
            .as_ref()
            .and_then(|option| option.start_at.as_ref())
            .is_none()
    {
        return Err(PlanCardStoreError::InvalidTransition(
            "Set a date and time in chat before confirming this plan.".to_string(),
        ));
    }

    // Voting for the winning option is itself a way of saying "I'm in": mark
    // those voters as attending, but never downgrade an explicit "no".
    if let Some(option) = &chosen {
        if !option.votes.is_empty() {
            query(
                "UPDATE cloud_plan_card_participants SET rsvp = 'yes', responded_at = now() \
                 WHERE event_id = $1 AND rsvp = 'pending' AND account_id = ANY($2)",
            )
            .bind(event_id)
            .bind(&option.votes)
            .execute(&mut *tx)
            .await?;
        }
    }

    query(
        "UPDATE cloud_plan_cards SET state = 'confirmed', revision = revision + 1, \
            note = $1, \
            start_at = COALESCE($3::timestamptz, start_at), \
            end_at = COALESCE($4::timestamptz, end_at), \
            location = COALESCE($5, location), \
            unresolved_fields = CASE WHEN $3::timestamptz IS NULL THEN unresolved_fields \
                                ELSE (SELECT COALESCE(jsonb_agg(field), '[]'::jsonb) \
                                      FROM jsonb_array_elements(unresolved_fields) field \
                                      WHERE field <> '\"time\"'::jsonb) END, \
            updated_at = now() WHERE event_id = $2",
    )
    .bind(note)
    .bind(event_id)
    .bind(chosen.as_ref().and_then(|option| option.start_at.clone()))
    .bind(chosen.as_ref().and_then(|option| option.end_at.clone()))
    .bind(chosen.as_ref().and_then(|option| option.location.clone()))
    .execute(&mut *tx)
    .await?;

    let row = require_row(&mut tx, event_id).await?;
    super::projection::enqueue(&mut *tx, &row).await?;
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
    super::projection::enqueue(&mut *tx, &row).await?;
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
    super::projection::enqueue(&mut *tx, &row).await?;
    tx.commit().await?;
    Ok(row)
}
