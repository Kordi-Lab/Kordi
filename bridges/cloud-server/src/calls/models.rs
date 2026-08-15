use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallKind {
    Voice,
    Video,
    Meeting,
}

impl CallKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Voice => "voice",
            Self::Video => "video",
            Self::Meeting => "meeting",
        }
    }

    pub fn allows_video(self) -> bool {
        matches!(self, Self::Video | Self::Meeting)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallState {
    Ringing,
    Active,
    Ended,
}

impl CallState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ringing => "ringing",
            Self::Active => "active",
            Self::Ended => "ended",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CallParticipantSnapshot {
    pub account_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub state: String,
    pub joined_at: Option<DateTime<Utc>>,
    pub left_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CallSnapshot {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub kind: CallKind,
    pub state: CallState,
    pub created_by_account_id: String,
    pub created_at: DateTime<Utc>,
    pub answered_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub participants: Vec<CallParticipantSnapshot>,
}

#[derive(Debug, Deserialize)]
pub struct StartCallRequest {
    pub client_operation_id: Uuid,
    pub kind: CallKind,
}

#[derive(Debug, Serialize)]
pub struct CallResponse {
    pub call: Option<CallSnapshot>,
}

#[derive(Debug, Serialize)]
pub struct CallMediaConnection {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct CallSessionResponse {
    pub call: CallSnapshot,
    pub media: CallMediaConnection,
}

#[derive(Debug, Deserialize)]
pub struct RegisterVoipPushTokenRequest {
    pub token: String,
    pub environment: String,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct RegisterPushTokenRequest {
    pub token: String,
    pub environment: String,
    #[serde(default = "enabled_by_default")]
    pub messages_enabled: bool,
    #[serde(default = "enabled_by_default")]
    pub sound_enabled: bool,
    #[serde(default = "enabled_by_default")]
    pub previews_enabled: bool,
    #[serde(default = "enabled_by_default")]
    pub badge_enabled: bool,
}
