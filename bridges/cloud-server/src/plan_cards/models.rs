use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanCardState {
    Polling,
    AwaitingConfirmation,
    Confirmed,
    Canceled,
}

impl PlanCardState {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Polling => "polling",
            Self::AwaitingConfirmation => "awaiting_confirmation",
            Self::Confirmed => "confirmed",
            Self::Canceled => "canceled",
        }
    }

    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "polling" => Some(Self::Polling),
            "awaiting_confirmation" => Some(Self::AwaitingConfirmation),
            "confirmed" => Some(Self::Confirmed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }
}

impl Serialize for PlanCardState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_db_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanCardRsvp {
    Pending,
    Yes,
    No,
}

impl PlanCardRsvp {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Yes => "yes",
            Self::No => "no",
        }
    }

    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "yes" => Some(Self::Yes),
            "no" => Some(Self::No),
            _ => None,
        }
    }
}

impl Serialize for PlanCardRsvp {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_db_str())
    }
}

/// One choice on a polling card: a candidate time or place the group can
/// vote on. `votes` holds the account ids that chose it; a participant votes
/// for one option at a time.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default)]
    pub votes: Vec<String>,
}

/// A participant as the propose caller supplied them: identity plus whether
/// they organize the plan. Their RSVP always starts `pending`, except the
/// organizer, who starts `yes` — they proposed it.
#[derive(Clone, Debug)]
pub struct PlanCardParticipantInput {
    pub account_id: String,
    pub display_name: String,
    pub organizer: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardParticipantStatus {
    #[serde(rename = "participantId")]
    pub account_id: String,
    pub display_name: String,
    pub organizer: bool,
    pub rsvp: PlanCardRsvp,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCardRow {
    pub event_id: String,
    #[serde(skip)]
    pub conversation_id: String,
    pub revision: i64,
    pub state: PlanCardState,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_fields: Vec<String>,
    #[serde(skip)]
    pub source_message_ids: Vec<String>,
    pub participants: Vec<PlanCardParticipantStatus>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<PlanCardOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

pub struct PlanCardProposeArgs {
    pub conversation_id: uuid::Uuid,
    pub existing_event_id: Option<String>,
    pub existing_revision: Option<i64>,
    pub title: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub location: Option<String>,
    pub state: PlanCardState,
    pub unresolved_fields: Vec<String>,
    pub participants: Vec<PlanCardParticipantInput>,
    pub source_message_ids: Vec<String>,
    pub options: Vec<PlanCardOption>,
}

#[derive(Debug)]
pub enum PlanCardStoreError {
    /// No card exists with that event ID.
    NotFound,
    /// The caller's revision no longer matches; re-read and retry.
    RevisionConflict,
    /// The requested action doesn't apply to the card's current state,
    /// e.g. confirming an already-canceled plan. Distinct from a revision
    /// conflict: retrying with a fresher revision won't help.
    InvalidTransition(String),
    /// `account_id` isn't one of this card's participants.
    NotAParticipant,
    /// The acting account isn't an active member of the card's conversation.
    Forbidden,
    Db(sqlx_core::Error),
}

impl std::fmt::Display for PlanCardStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "plan card not found"),
            Self::RevisionConflict => write!(f, "plan card revision conflict"),
            Self::InvalidTransition(reason) => write!(f, "invalid plan card transition: {reason}"),
            Self::NotAParticipant => write!(f, "account is not a participant on this plan card"),
            Self::Forbidden => write!(f, "account is not an active member of this conversation"),
            Self::Db(err) => write!(f, "plan card database error: {err}"),
        }
    }
}

impl std::error::Error for PlanCardStoreError {}

impl From<sqlx_core::Error> for PlanCardStoreError {
    fn from(err: sqlx_core::Error) -> Self {
        Self::Db(err)
    }
}
