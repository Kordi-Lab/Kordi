use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::routes::{cloud_session_middleware, CloudSession},
    server::ServerState,
};

use super::models::{
    PlanCardParticipantInput, PlanCardProposeArgs, PlanCardRow, PlanCardRsvp, PlanCardState,
    PlanCardStoreError,
};
use super::store;

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/plan_cards", post(handle))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireParticipant {
    participant_id: String,
    display_name: String,
    #[serde(default)]
    organizer: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum Request {
    Propose {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(default, rename = "existingEventId")]
        existing_event_id: Option<String>,
        #[serde(default, rename = "existingRevision")]
        existing_revision: Option<i64>,
        title: String,
        #[serde(default, rename = "startAt")]
        start_at: Option<String>,
        #[serde(default, rename = "endAt")]
        end_at: Option<String>,
        #[serde(default)]
        location: Option<String>,
        state: String,
        #[serde(default, rename = "unresolvedFields")]
        unresolved_fields: Vec<String>,
        participants: Vec<WireParticipant>,
        #[serde(default, rename = "sourceMessageIds")]
        source_message_ids: Vec<String>,
    },
    Rsvp {
        #[serde(rename = "eventId")]
        event_id: String,
        revision: i64,
        #[serde(rename = "participantId")]
        participant_id: String,
        rsvp: String,
        #[serde(default)]
        note: Option<String>,
    },
    Confirm {
        #[serde(rename = "eventId")]
        event_id: String,
        revision: i64,
        #[serde(rename = "confirmedBy")]
        confirmed_by: String,
    },
    Reopen {
        #[serde(rename = "eventId")]
        event_id: String,
        revision: i64,
        reason: String,
    },
    Cancel {
        #[serde(rename = "eventId")]
        event_id: String,
        revision: i64,
        #[serde(rename = "canceledBy")]
        canceled_by: String,
        #[serde(default)]
        reason: Option<String>,
    },
}

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

fn store_error(err: PlanCardStoreError) -> Response {
    match err {
        PlanCardStoreError::NotFound => error(
            "plan_card_not_found",
            "This plan card no longer exists.",
            StatusCode::NOT_FOUND,
        ),
        PlanCardStoreError::RevisionConflict => error(
            "plan_card_revision_conflict",
            "This plan card changed since you last read it. Refresh and try again.",
            StatusCode::CONFLICT,
        ),
        PlanCardStoreError::InvalidTransition(reason) => error(
            "plan_card_invalid_transition",
            &reason,
            StatusCode::CONFLICT,
        ),
        PlanCardStoreError::NotAParticipant => error(
            "plan_card_not_a_participant",
            "That account is not a participant on this plan card.",
            StatusCode::BAD_REQUEST,
        ),
        PlanCardStoreError::Forbidden => error(
            "plan_card_forbidden",
            "You must be an active member of this conversation.",
            StatusCode::FORBIDDEN,
        ),
        PlanCardStoreError::Db(_) => error(
            "plan_card_unavailable",
            "Could not update the plan card. Try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn handle(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<Request>,
) -> Response {
    let actor = Actor {
        account_id: session.account_id.clone(),
        on_behalf_of_conversation: None,
    };
    let change = MemberChange::from_request(&request);
    match dispatch_row(state.db_pool(), &actor, request).await {
        Ok(row) => {
            // A member's vote must reach everyone, not only the device that
            // pressed the button: Pip reposts the fresh card at once, with no
            // model call, so every transcript shows the same snapshot.
            if let (Some(pip), Some(change)) = (state.pip(), change) {
                let text = change.describe(&row);
                if let Err(error) = crate::pip::store::post_member_update(
                    state.db_pool(),
                    &pip.config().account_id,
                    &row,
                    &text,
                )
                .await
                {
                    eprintln!("[pip] Could not post the plan card update: {error}");
                }
            }
            Json(row).into_response()
        }
        Err(response) => response,
    }
}

/// What a signed-in member just did to a card, in the words Pip uses to tell
/// the group. Proposals are left to Pip's own runs.
enum MemberChange {
    Rsvp { participant_id: String, going: bool },
    Confirm { account_id: String },
    Reopen { reason: String },
    Cancel { account_id: String },
}

impl MemberChange {
    fn from_request(request: &Request) -> Option<Self> {
        match request {
            Request::Propose { .. } => None,
            Request::Rsvp {
                participant_id,
                rsvp,
                ..
            } => Some(Self::Rsvp {
                participant_id: participant_id.clone(),
                going: rsvp == "yes",
            }),
            Request::Confirm { confirmed_by, .. } => Some(Self::Confirm {
                account_id: confirmed_by.clone(),
            }),
            Request::Reopen { reason, .. } => Some(Self::Reopen {
                reason: reason.trim().to_string(),
            }),
            Request::Cancel { canceled_by, .. } => Some(Self::Cancel {
                account_id: canceled_by.clone(),
            }),
        }
    }

    fn describe(&self, row: &PlanCardRow) -> String {
        let name = |account_id: &str| {
            row.participants
                .iter()
                .find(|participant| participant.account_id == account_id)
                .map(|participant| participant.display_name.clone())
                .unwrap_or_else(|| "A member".to_string())
        };
        match self {
            Self::Rsvp {
                participant_id,
                going: true,
            } => format!("{} is in.", name(participant_id)),
            Self::Rsvp {
                participant_id,
                going: false,
            } => format!("{} can't make it.", name(participant_id)),
            Self::Confirm { account_id } => format!("{} confirmed the plan.", name(account_id)),
            Self::Reopen { reason } => format!("The plan is open again: {reason}"),
            Self::Cancel { account_id } => format!("{} canceled the plan.", name(account_id)),
        }
    }
}

/// Who is acting on a card. A signed-in member acts for themselves only. A
/// service agent (Pip) acts inside one conversation and may record another
/// active member's RSVP, confirmation, or cancellation from what that member
/// said in the chat.
pub(crate) struct Actor {
    pub account_id: String,
    pub on_behalf_of_conversation: Option<Uuid>,
}

async fn is_active_member(
    pool: &sqlx_postgres::PgPool,
    conversation_id: Uuid,
    account_id: &str,
) -> bool {
    sqlx_core::query_as::query_as::<_, (bool,)>(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active')",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(pool)
    .await
    .map(|row| row.0)
    .unwrap_or(false)
}

/// Validates that `acting_for` may be acted on by this actor: either it is the
/// actor itself, or the actor is a service agent and `acting_for` is an active
/// member of the actor's conversation.
async fn may_act_for(pool: &sqlx_postgres::PgPool, actor: &Actor, acting_for: &str) -> bool {
    if acting_for == actor.account_id {
        return true;
    }
    match actor.on_behalf_of_conversation {
        Some(conversation_id) => is_active_member(pool, conversation_id, acting_for).await,
        None => false,
    }
}

pub(crate) async fn dispatch(
    pool: &sqlx_postgres::PgPool,
    actor: &Actor,
    request: Request,
) -> Response {
    match dispatch_row(pool, actor, request).await {
        Ok(row) => Json(row).into_response(),
        Err(response) => response,
    }
}

/// Applies one request and returns the resulting card, or the error response
/// to send back. Split from `dispatch` so the member route can act on the
/// new card after a successful change.
pub(crate) async fn dispatch_row(
    pool: &sqlx_postgres::PgPool,
    actor: &Actor,
    request: Request,
) -> Result<PlanCardRow, Response> {
    match request {
        Request::Propose {
            conversation_id,
            existing_event_id,
            existing_revision,
            title,
            start_at,
            end_at,
            location,
            state: state_str,
            unresolved_fields,
            participants,
            source_message_ids,
        } => {
            let Ok(conversation_id) = Uuid::parse_str(&conversation_id) else {
                return Err(error(
                    "invalid_conversation_id",
                    "conversationId must be a valid conversation identifier.",
                    StatusCode::BAD_REQUEST,
                ));
            };
            if actor
                .on_behalf_of_conversation
                .is_some_and(|scope| scope != conversation_id)
            {
                return Err(error(
                    "plan_card_forbidden",
                    "This run may only manage plan cards in its own conversation.",
                    StatusCode::FORBIDDEN,
                ));
            }
            let Some(card_state) = PlanCardState::from_db_str(&to_snake_case(&state_str)) else {
                return Err(error(
                    "invalid_state",
                    "state must be polling or awaitingConfirmation.",
                    StatusCode::BAD_REQUEST,
                ));
            };
            if title.trim().is_empty() {
                return Err(error(
                    "invalid_title",
                    "title is required.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            if participants.is_empty() {
                return Err(error(
                    "invalid_participants",
                    "At least one participant is required.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            // Models often send optional strings as "" rather than omitting
            // them; an empty existingEventId must mean "new card", not an
            // update of a card that does not exist.
            let existing_event_id = blank_to_none(existing_event_id);
            let existing_revision = existing_revision.filter(|_| existing_event_id.is_some());
            let location = blank_to_none(location);
            let start_at = match normalize_instant(start_at.as_deref()) {
                Ok(value) => value,
                Err(message) => {
                    return Err(error("invalid_start_at", message, StatusCode::BAD_REQUEST))
                }
            };
            let end_at = match normalize_instant(end_at.as_deref()) {
                Ok(value) => value,
                Err(message) => {
                    return Err(error("invalid_end_at", message, StatusCode::BAD_REQUEST))
                }
            };
            let args = PlanCardProposeArgs {
                conversation_id,
                existing_event_id,
                existing_revision,
                title,
                start_at,
                end_at,
                location,
                state: card_state,
                unresolved_fields,
                participants: participants
                    .into_iter()
                    .map(|participant| PlanCardParticipantInput {
                        account_id: participant.participant_id,
                        display_name: participant.display_name,
                        organizer: participant.organizer,
                    })
                    .collect(),
                source_message_ids,
            };
            store::propose(pool, &actor.account_id, args)
                .await
                .map_err(store_error)
        }
        Request::Rsvp {
            event_id,
            revision,
            participant_id,
            rsvp,
            note,
        } => {
            let Some(rsvp) = PlanCardRsvp::from_db_str(&rsvp) else {
                return Err(error(
                    "invalid_rsvp",
                    "rsvp must be yes or no.",
                    StatusCode::BAD_REQUEST,
                ));
            };
            if matches!(rsvp, PlanCardRsvp::Pending) {
                return Err(error(
                    "invalid_rsvp",
                    "rsvp must be yes or no.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            // A member records only their own RSVP. Pip may record another
            // active member's RSVP from what that member said in the chat.
            if !may_act_for(pool, actor, &participant_id).await {
                return Err(error(
                    "plan_card_forbidden",
                    "You can only record your own RSVP.",
                    StatusCode::FORBIDDEN,
                ));
            }
            let note = blank_to_none(note);
            store::rsvp(
                pool,
                &event_id,
                revision,
                &participant_id,
                rsvp,
                note.as_deref(),
            )
            .await
            .map_err(store_error)
        }
        Request::Confirm {
            event_id,
            revision,
            confirmed_by,
        } => {
            if !may_act_for(pool, actor, &confirmed_by).await {
                return Err(error(
                    "plan_card_forbidden",
                    "confirmedBy must match the authenticated account.",
                    StatusCode::FORBIDDEN,
                ));
            }
            store::confirm(pool, &event_id, revision, &confirmed_by, None)
                .await
                .map_err(store_error)
        }
        Request::Reopen {
            event_id,
            revision,
            reason,
        } => {
            if reason.trim().is_empty() {
                return Err(error(
                    "invalid_reason",
                    "reason is required to reopen a plan card.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            store::reopen(pool, &event_id, revision, &actor.account_id, &reason)
                .await
                .map_err(store_error)
        }
        Request::Cancel {
            event_id,
            revision,
            canceled_by,
            reason,
        } => {
            if !may_act_for(pool, actor, &canceled_by).await {
                return Err(error(
                    "plan_card_forbidden",
                    "canceledBy must match the authenticated account.",
                    StatusCode::FORBIDDEN,
                ));
            }
            store::cancel(pool, &event_id, revision, &canceled_by, reason.as_deref())
                .await
                .map_err(store_error)
        }
    }
}

/// Treats an empty or whitespace-only optional string as absent.
pub(crate) fn blank_to_none(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Optional instants must be RFC 3339 with an explicit offset so the card's
/// time is unambiguous for every participant. Blank means unknown.
pub(crate) fn normalize_instant(value: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    match chrono::DateTime::parse_from_rfc3339(raw) {
        Ok(instant) => Ok(Some(instant.to_rfc3339())),
        Err(_) => Err(
            "startAt and endAt must be RFC 3339 timestamps with a timezone offset, \
             for example 2026-09-20T12:30:00+03:00. Leave them out when the time is not known yet.",
        ),
    }
}

/// Wire `state` arrives camelCase (`awaitingConfirmation`); the store speaks
/// the DB's snake_case (`awaiting_confirmation`).
fn to_snake_case(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 4);
    for ch in value.chars() {
        if ch.is_ascii_uppercase() {
            result.push('_');
            result.push(ch.to_ascii_lowercase());
        } else {
            result.push(ch);
        }
    }
    result
}

#[cfg(test)]
mod instant_tests {
    use super::normalize_instant;

    #[test]
    fn blank_optional_strings_are_absent() {
        assert_eq!(super::blank_to_none(None), None);
        assert_eq!(super::blank_to_none(Some("  ".into())), None);
        assert_eq!(
            super::blank_to_none(Some(" plan_1 ".into())),
            Some("plan_1".into())
        );
    }

    #[test]
    fn instants_require_an_offset() {
        assert_eq!(normalize_instant(None).unwrap(), None);
        assert_eq!(normalize_instant(Some("  ")).unwrap(), None);
        assert_eq!(
            normalize_instant(Some("2026-09-20T12:30:00+03:00")).unwrap(),
            Some("2026-09-20T12:30:00+03:00".to_string())
        );
        assert!(normalize_instant(Some("2026-09-20T12:30:00")).is_err());
        assert!(normalize_instant(Some("Saturday 12:30")).is_err());
    }
}
