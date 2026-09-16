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
    PlanCardParticipantInput, PlanCardProposeArgs, PlanCardRsvp, PlanCardState, PlanCardStoreError,
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
struct WireParticipant {
    participant_id: String,
    display_name: String,
    #[serde(default)]
    organizer: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Request {
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
                return error(
                    "invalid_conversation_id",
                    "conversationId must be a valid conversation identifier.",
                    StatusCode::BAD_REQUEST,
                );
            };
            let Some(card_state) = PlanCardState::from_db_str(&to_snake_case(&state_str)) else {
                return error(
                    "invalid_state",
                    "state must be polling or awaitingConfirmation.",
                    StatusCode::BAD_REQUEST,
                );
            };
            if title.trim().is_empty() {
                return error(
                    "invalid_title",
                    "title is required.",
                    StatusCode::BAD_REQUEST,
                );
            }
            if participants.is_empty() {
                return error(
                    "invalid_participants",
                    "At least one participant is required.",
                    StatusCode::BAD_REQUEST,
                );
            }
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
            match store::propose(state.db_pool(), &session.account_id, args).await {
                Ok(row) => Json(row).into_response(),
                Err(err) => store_error(err),
            }
        }
        Request::Rsvp {
            event_id,
            revision,
            participant_id,
            rsvp,
            note,
        } => {
            let Some(rsvp) = PlanCardRsvp::from_db_str(&rsvp) else {
                return error(
                    "invalid_rsvp",
                    "rsvp must be yes or no.",
                    StatusCode::BAD_REQUEST,
                );
            };
            if matches!(rsvp, PlanCardRsvp::Pending) {
                return error(
                    "invalid_rsvp",
                    "rsvp must be yes or no.",
                    StatusCode::BAD_REQUEST,
                );
            }
            // The acting account and the account the RSVP is recorded for
            // are always the same: nobody can RSVP on someone else's behalf.
            if participant_id != session.account_id {
                return error(
                    "plan_card_forbidden",
                    "You can only record your own RSVP.",
                    StatusCode::FORBIDDEN,
                );
            }
            match store::rsvp(
                state.db_pool(),
                &event_id,
                revision,
                &participant_id,
                rsvp,
                note.as_deref(),
            )
            .await
            {
                Ok(row) => Json(row).into_response(),
                Err(err) => store_error(err),
            }
        }
        Request::Confirm {
            event_id,
            revision,
            confirmed_by,
        } => {
            if confirmed_by != session.account_id {
                return error(
                    "plan_card_forbidden",
                    "confirmedBy must match the authenticated account.",
                    StatusCode::FORBIDDEN,
                );
            }
            match store::confirm(state.db_pool(), &event_id, revision, &confirmed_by, None).await {
                Ok(row) => Json(row).into_response(),
                Err(err) => store_error(err),
            }
        }
        Request::Reopen {
            event_id,
            revision,
            reason,
        } => {
            if reason.trim().is_empty() {
                return error(
                    "invalid_reason",
                    "reason is required to reopen a plan card.",
                    StatusCode::BAD_REQUEST,
                );
            }
            match store::reopen(
                state.db_pool(),
                &event_id,
                revision,
                &session.account_id,
                &reason,
            )
            .await
            {
                Ok(row) => Json(row).into_response(),
                Err(err) => store_error(err),
            }
        }
        Request::Cancel {
            event_id,
            revision,
            canceled_by,
            reason,
        } => {
            if canceled_by != session.account_id {
                return error(
                    "plan_card_forbidden",
                    "canceledBy must match the authenticated account.",
                    StatusCode::FORBIDDEN,
                );
            }
            match store::cancel(
                state.db_pool(),
                &event_id,
                revision,
                &canceled_by,
                reason.as_deref(),
            )
            .await
            {
                Ok(row) => Json(row).into_response(),
                Err(err) => store_error(err),
            }
        }
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
