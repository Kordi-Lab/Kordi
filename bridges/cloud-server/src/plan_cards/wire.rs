//! Plan-card requests as clients and PiP's runner send them, and the error
//! responses they get back.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use super::models::{
    PlanCardOption, PlanCardParticipantInput, PlanCardProposeArgs, PlanCardState,
    PlanCardStoreError,
};

/// An error response. Boxed so the `Result` carrying it stays small.
pub(crate) type Rejection = Box<Response>;

pub(crate) fn error(code: &str, message: &str, status: StatusCode) -> Rejection {
    Box::new((status, Json(json!({"errorCode": code, "message": message}))).into_response())
}

pub(crate) fn store_error(err: PlanCardStoreError) -> Rejection {
    let (code, message, status) = match &err {
        PlanCardStoreError::NotFound => (
            "plan_card_not_found",
            "This plan card no longer exists.",
            StatusCode::NOT_FOUND,
        ),
        PlanCardStoreError::RevisionConflict => (
            "plan_card_revision_conflict",
            "This plan card changed since you last read it. Refresh and try again.",
            StatusCode::CONFLICT,
        ),
        PlanCardStoreError::InvalidTransition(reason) => {
            return error("plan_card_invalid_transition", reason, StatusCode::CONFLICT)
        }
        PlanCardStoreError::NotAParticipant => (
            "plan_card_not_a_participant",
            "That account is not a participant on this plan card.",
            StatusCode::BAD_REQUEST,
        ),
        PlanCardStoreError::ParticipantNotMember => (
            "invalid_participants",
            "Every participant must be an active member of this conversation.",
            StatusCode::BAD_REQUEST,
        ),
        PlanCardStoreError::Forbidden => (
            "plan_card_forbidden",
            "You must be an active member of this conversation.",
            StatusCode::FORBIDDEN,
        ),
        PlanCardStoreError::Db(_) => (
            "plan_card_unavailable",
            "Could not update the plan card. Try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    };
    error(code, message, status)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireParticipant {
    participant_id: String,
    display_name: String,
    #[serde(default)]
    organizer: bool,
}

/// A vote option as a caller supplies it. Ids are optional; missing ones are
/// assigned in order so the model can send plain labels.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireOption {
    #[serde(default)]
    id: Option<String>,
    label: String,
    #[serde(default)]
    start_at: Option<String>,
    #[serde(default)]
    end_at: Option<String>,
    #[serde(default)]
    location: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProposeRequest {
    conversation_id: String,
    #[serde(default)]
    existing_event_id: Option<String>,
    #[serde(default)]
    existing_revision: Option<i64>,
    title: String,
    #[serde(default)]
    start_at: Option<String>,
    #[serde(default)]
    end_at: Option<String>,
    #[serde(default)]
    location: Option<String>,
    state: String,
    #[serde(default)]
    unresolved_fields: Vec<String>,
    participants: Vec<WireParticipant>,
    #[serde(default)]
    source_message_ids: Vec<String>,
    #[serde(default)]
    options: Vec<WireOption>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum Request {
    Propose(ProposeRequest),
    Rsvp {
        #[serde(rename = "eventId")]
        event_id: String,
        // Accepted for compatibility; an answer applies at any revision.
        #[serde(default)]
        #[allow(dead_code)]
        revision: Option<i64>,
        #[serde(rename = "participantId")]
        participant_id: String,
        rsvp: String,
        #[serde(default)]
        note: Option<String>,
    },
    Vote {
        #[serde(rename = "eventId")]
        event_id: String,
        #[serde(default)]
        #[allow(dead_code)]
        revision: Option<i64>,
        #[serde(rename = "participantId")]
        participant_id: String,
        #[serde(rename = "optionId")]
        option_id: String,
    },
    Confirm {
        #[serde(rename = "eventId")]
        event_id: String,
        revision: i64,
        #[serde(rename = "confirmedBy")]
        confirmed_by: String,
        #[serde(default, rename = "optionId")]
        option_id: Option<String>,
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

impl Request {
    /// The action name, safe to log: it carries none of the card's content.
    pub(crate) fn action(&self) -> &'static str {
        match self {
            Self::Propose(_) => "propose",
            Self::Rsvp { .. } => "rsvp",
            Self::Vote { .. } => "vote",
            Self::Confirm { .. } => "confirm",
            Self::Reopen { .. } => "reopen",
            Self::Cancel { .. } => "cancel",
        }
    }
}

fn bad_request(code: &str, message: &str) -> Rejection {
    error(code, message, StatusCode::BAD_REQUEST)
}

/// An optional start that must be RFC 3339 and not already past.
fn upcoming_start(value: Option<&str>, past: (&str, &str)) -> Result<Option<String>, Rejection> {
    let instant =
        normalize_instant(value).map_err(|message| bad_request("invalid_start_at", message))?;
    if starts_in_the_past(instant.as_deref()) {
        return Err(bad_request(past.0, past.1));
    }
    Ok(instant)
}

impl ProposeRequest {
    /// Validates a proposal and turns it into store arguments. `scope` is the
    /// only conversation a PiP run may propose in.
    pub(crate) fn into_args(self, scope: Option<Uuid>) -> Result<PlanCardProposeArgs, Rejection> {
        let Ok(conversation_id) = Uuid::parse_str(&self.conversation_id) else {
            return Err(bad_request(
                "invalid_conversation_id",
                "conversationId must be a valid conversation identifier.",
            ));
        };
        if scope.is_some_and(|scope| scope != conversation_id) {
            return Err(error(
                "plan_card_forbidden",
                "This run may only manage plan cards in its own conversation.",
                StatusCode::FORBIDDEN,
            ));
        }
        let Some(state) = PlanCardState::from_db_str(&to_snake_case(&self.state)) else {
            return Err(bad_request(
                "invalid_state",
                "state must be polling or awaitingConfirmation.",
            ));
        };
        if self.title.trim().is_empty() {
            return Err(bad_request("invalid_title", "title is required."));
        }
        if self.participants.is_empty() {
            return Err(bad_request(
                "invalid_participants",
                "At least one participant is required.",
            ));
        }
        // Models often send optional strings as "" rather than omitting them;
        // an empty existingEventId must mean "new card", not an update of a
        // card that does not exist.
        let existing_event_id = blank_to_none(self.existing_event_id);
        let existing_revision = self
            .existing_revision
            .filter(|_| existing_event_id.is_some());
        let plan_past = (
            "start_in_past",
            "startAt is already in the past. Use the next upcoming date for this plan.",
        );
        let start_at = upcoming_start(self.start_at.as_deref(), plan_past)?;
        let end_at = normalize_instant(self.end_at.as_deref())
            .map_err(|message| bad_request("invalid_end_at", message))?;
        let mut options = Vec::with_capacity(self.options.len());
        for (index, option) in self.options.into_iter().enumerate() {
            let label = option.label.trim().to_string();
            if label.is_empty() {
                return Err(bad_request(
                    "invalid_options",
                    "Every option needs a label.",
                ));
            }
            let option_past = (
                "option_in_past",
                "An option starts in the past. Offer only upcoming times.",
            );
            options.push(PlanCardOption {
                id: blank_to_none(option.id).unwrap_or_else(|| format!("opt_{}", index + 1)),
                label,
                start_at: upcoming_start(option.start_at.as_deref(), option_past)?,
                end_at: normalize_instant(option.end_at.as_deref())
                    .map_err(|message| bad_request("invalid_end_at", message))?,
                location: blank_to_none(option.location),
                votes: Vec::new(),
            });
        }
        Ok(PlanCardProposeArgs {
            conversation_id,
            existing_event_id,
            existing_revision,
            title: self.title,
            start_at,
            end_at,
            location: blank_to_none(self.location),
            state,
            unresolved_fields: self.unresolved_fields,
            participants: self
                .participants
                .into_iter()
                .map(|participant| PlanCardParticipantInput {
                    account_id: participant.participant_id,
                    display_name: participant.display_name,
                    organizer: participant.organizer,
                })
                .collect(),
            source_message_ids: self.source_message_ids,
            options,
        })
    }
}

/// A plan or option that starts more than ten minutes ago cannot be proposed.
fn starts_in_the_past(instant: Option<&str>) -> bool {
    instant
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|start| {
            start.with_timezone(&chrono::Utc) < chrono::Utc::now() - chrono::Duration::minutes(10)
        })
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
mod tests {
    use super::*;

    #[test]
    fn blank_optional_strings_are_absent() {
        assert_eq!(blank_to_none(None), None);
        assert_eq!(blank_to_none(Some("  ".into())), None);
        assert_eq!(
            blank_to_none(Some(" plan_1 ".into())),
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

    #[test]
    fn a_run_cannot_propose_in_another_conversation() {
        let request: Request = serde_json::from_value(json!({
            "action": "propose", "conversationId": Uuid::new_v4().to_string(),
            "title": "Lunch", "state": "polling",
            "participants": [{"participantId": "a", "displayName": "A"}],
        }))
        .unwrap();
        let Request::Propose(propose) = request else {
            panic!("propose");
        };
        let rejection = propose.into_args(Some(Uuid::new_v4())).err().unwrap();
        assert_eq!(rejection.status(), StatusCode::FORBIDDEN);
    }
}
