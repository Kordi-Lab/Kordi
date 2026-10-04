//! PiP only suggests.
//!
//! PiP never records anyone's answer or vote and never confirms, cancels, or
//! reopens a plan. When its run asks to, the card stays as it is and a pending
//! action waits for a person: the member the answer or vote is for, or any
//! organizer or chat owner or admin for a plan decision. A suggestion lasts 24
//! hours, and a newer one for the same thing replaces it. Approving applies the
//! change as the person who approved it; a plan decision uses the revision
//! PiP saw, and an answer or vote applies only while the card still shows the
//! plan the suggestion showed, so a plan that changed since is not decided or
//! answered by accident. A revision that changes the plan retires the answers
//! and votes suggested for the old one.

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::models::{PlanCardRow, PlanCardRsvp, PlanCardState, PlanCardStoreError};
use super::routes::Actor;
use super::wire::{blank_to_none, error, store_error, Rejection, Request};

mod approvals;
mod store;

pub(super) use approvals::supersede_after_member_action;
pub(crate) use approvals::{apply_approval, supersede_after_apply, ApplyError};
use store::{insert, retire_stale, strip_nulls, NewSuggestion};

/// The outcome of a plan-card request.
pub(crate) enum Dispatched {
    /// The card changed (or already was as asked).
    Applied(PlanCardRow),
    /// Nothing changed yet: a person must confirm the pending action.
    Suggested {
        row: PlanCardRow,
        action_id: Uuid,
        awaiting: &'static str,
    },
}

impl Dispatched {
    pub(crate) fn into_row(self) -> PlanCardRow {
        match self {
            Self::Applied(row) | Self::Suggested { row, .. } => row,
        }
    }
}

fn db(err: sqlx_core::Error) -> Rejection {
    store_error(PlanCardStoreError::Db(err))
}

/// The event a request is about, if it names one.
pub(super) fn event_of(request: &Request) -> Option<String> {
    match request {
        Request::Propose(_) => None,
        Request::Rsvp { event_id, .. }
        | Request::Vote { event_id, .. }
        | Request::Confirm { event_id, .. }
        | Request::Reopen { event_id, .. }
        | Request::Cancel { event_id, .. } => Some(event_id.clone()),
    }
}

/// Turns PiP's rsvp, vote, confirm, cancel, or reopen into a suggestion. The
/// card is never changed here.
pub(super) async fn suggest(
    pool: &PgPool,
    actor: &Actor,
    request: Request,
) -> Result<Dispatched, Rejection> {
    let Some(conversation_id) = actor.on_behalf_of_conversation else {
        return Err(error(
            "plan_card_forbidden",
            "Only PiP's runs make suggestions.",
            StatusCode::FORBIDDEN,
        ));
    };
    let Some(event_id) = event_of(&request) else {
        return Err(store_error(PlanCardStoreError::NotFound));
    };
    let card = super::store::load(pool, &event_id)
        .await
        .map_err(db)?
        .ok_or_else(|| store_error(PlanCardStoreError::NotFound))?;
    // A decision the card already reflects needs no one's confirmation.
    if matches!(
        (&request, card.state),
        (Request::Confirm { .. }, PlanCardState::Confirmed)
            | (Request::Cancel { .. }, PlanCardState::Canceled)
    ) {
        return Ok(Dispatched::Applied(card));
    }
    let base = |extra: Value| {
        let mut subject = json!({"eventId": card.event_id, "title": card.title});
        if let (Some(target), Some(extra)) = (subject.as_object_mut(), extra.as_object()) {
            for (key, value) in extra {
                if !value.is_null() {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        subject
    };
    let invalid = |reason: &str| store_error(PlanCardStoreError::InvalidTransition(reason.into()));
    let suggestion = match request {
        Request::Propose(_) => return Err(store_error(PlanCardStoreError::NotFound)),
        Request::Rsvp {
            participant_id,
            rsvp,
            note,
            ..
        } => {
            let rsvp = PlanCardRsvp::from_db_str(&rsvp)
                .filter(|rsvp| !matches!(rsvp, PlanCardRsvp::Pending))
                .ok_or_else(|| {
                    error(
                        "invalid_rsvp",
                        "rsvp must be yes or no.",
                        StatusCode::BAD_REQUEST,
                    )
                })?;
            require_represented(pool, actor, conversation_id, &participant_id).await?;
            require_participant(&card, &participant_id)?;
            if card.state == PlanCardState::Canceled {
                return Err(invalid("cannot respond to a canceled plan"));
            }
            NewSuggestion::member(
                "plan_rsvp",
                &participant_id,
                format!("event:{event_id}:rsvp"),
                base(json!({"startAt": card.start_at, "location": card.location,
                    "rsvp": rsvp.as_db_str(), "note": blank_to_none(note)})),
            )
        }
        Request::Vote {
            participant_id,
            option_id,
            ..
        } => {
            require_represented(pool, actor, conversation_id, &participant_id).await?;
            require_participant(&card, &participant_id)?;
            if card.state != PlanCardState::Polling {
                return Err(invalid("votes are only open while the plan is polling"));
            }
            let option_id = option_id.trim().to_string();
            let Some(option) = card.options.iter().find(|option| option.id == option_id) else {
                return Err(invalid(&format!("unknown option {option_id}")));
            };
            NewSuggestion::member(
                "plan_vote",
                &participant_id,
                format!("event:{event_id}:vote"),
                base(json!({"optionId": option.id, "optionLabel": option.label})),
            )
        }
        Request::Confirm {
            revision,
            option_id,
            ..
        } => {
            if card.state == PlanCardState::Canceled {
                return Err(invalid("cannot confirm a canceled plan"));
            }
            require_revision(&card, revision)?;
            let option_id = blank_to_none(option_id);
            let option = match &option_id {
                Some(id) => Some(
                    card.options
                        .iter()
                        .find(|option| &option.id == id)
                        .ok_or_else(|| invalid(&format!("unknown option {id}")))?,
                ),
                None => None,
            };
            let start_at = option
                .and_then(|option| option.start_at.clone())
                .or_else(|| card.start_at.clone());
            if start_at.is_none() {
                return Err(invalid(
                    "Set a date and time in chat before confirming this plan.",
                ));
            }
            let location = option
                .and_then(|option| option.location.clone())
                .or_else(|| card.location.clone());
            NewSuggestion::manager(
                "plan_confirm",
                &event_id,
                base(json!({"revision": revision, "optionId": option_id,
                    "startAt": start_at, "location": location})),
            )
        }
        Request::Cancel {
            revision, reason, ..
        } => {
            require_revision(&card, revision)?;
            NewSuggestion::manager(
                "plan_cancel",
                &event_id,
                base(json!({"revision": revision, "reason": blank_to_none(reason)})),
            )
        }
        Request::Reopen {
            revision, reason, ..
        } => {
            let reason = reason.trim().to_string();
            if reason.is_empty() {
                return Err(error(
                    "invalid_reason",
                    "reason is required to reopen a plan card.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            if card.state != PlanCardState::Confirmed {
                return Err(invalid("reopen only applies to a confirmed plan"));
            }
            require_revision(&card, revision)?;
            NewSuggestion::manager(
                "plan_reopen",
                &event_id,
                base(json!({"revision": revision, "reason": reason})),
            )
        }
    };
    let awaiting = if suggestion.approver.is_some() {
        "member"
    } else {
        "organizer_or_admin"
    };
    let action_id = insert(
        pool,
        conversation_id,
        &event_id,
        &actor.account_id,
        suggestion,
    )
    .await
    .map_err(db)?;
    Ok(Dispatched::Suggested {
        row: card,
        action_id,
        awaiting,
    })
}

/// After PiP proposes or revises a card, answers and votes suggested for an
/// earlier version of the plan are retired, and the organizer gets a
/// suggestion to say yes instead of being marked in automatically.
pub(super) async fn after_pip_propose(
    pool: &PgPool,
    actor: &Actor,
    card: &PlanCardRow,
) -> Result<(), sqlx_core::Error> {
    let Some(conversation_id) = actor.on_behalf_of_conversation else {
        return Ok(());
    };
    retire_stale(pool, card).await?;
    for organizer in card
        .participants
        .iter()
        .filter(|participant| participant.organizer && participant.rsvp == PlanCardRsvp::Pending)
    {
        let (waiting,): (bool,) = query_as(
            "SELECT EXISTS (SELECT 1 FROM cloud_agent_pending_actions
                            WHERE kind = 'plan_rsvp' AND event_id = $1
                              AND approver_account_id = $2 AND status = 'pending'
                              AND expires_at > now())",
        )
        .bind(&card.event_id)
        .bind(&organizer.account_id)
        .fetch_one(pool)
        .await?;
        if waiting {
            continue;
        }
        let subject = json!({"eventId": card.event_id, "title": card.title,
            "startAt": card.start_at, "location": card.location, "rsvp": "yes"});
        let subject = strip_nulls(subject);
        insert(
            pool,
            conversation_id,
            &card.event_id,
            &actor.account_id,
            NewSuggestion::member(
                "plan_rsvp",
                &organizer.account_id,
                format!("event:{}:rsvp", card.event_id),
                subject,
            ),
        )
        .await?;
    }
    Ok(())
}

/// PiP may suggest an answer or vote only for a member who wrote in the new
/// messages of this run, and who is still an active member.
async fn require_represented(
    pool: &PgPool,
    actor: &Actor,
    conversation_id: Uuid,
    participant_id: &str,
) -> Result<(), Rejection> {
    let forbidden = || {
        error(
            "plan_card_forbidden",
            "PiP can only suggest answers for members who wrote in the new messages.",
            StatusCode::FORBIDDEN,
        )
    };
    if !actor.represented_accounts.contains(participant_id) {
        return Err(forbidden());
    }
    let (active,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active')",
    )
    .bind(conversation_id)
    .bind(participant_id)
    .fetch_one(pool)
    .await
    .map_err(db)?;
    if active {
        Ok(())
    } else {
        Err(forbidden())
    }
}

fn require_participant(card: &PlanCardRow, participant_id: &str) -> Result<(), Rejection> {
    if card
        .participants
        .iter()
        .any(|participant| participant.account_id == participant_id)
    {
        Ok(())
    } else {
        Err(store_error(PlanCardStoreError::NotAParticipant))
    }
}

fn require_revision(card: &PlanCardRow, revision: i64) -> Result<(), Rejection> {
    if card.revision == revision {
        Ok(())
    } else {
        Err(store_error(PlanCardStoreError::RevisionConflict))
    }
}
