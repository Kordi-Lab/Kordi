use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Direct,
    Group,
    Ai,
}

impl ConversationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Group => "group",
            Self::Ai => "ai",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MemberSnapshot {
    pub account_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
    pub membership_state: String,
    pub version: i32,
    pub last_delivered_sequence: i64,
    pub last_read_sequence: i64,
    pub joined_at: DateTime<Utc>,
    pub left_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConversationPreferencesSnapshot {
    pub conversation_id: Uuid,
    pub account_id: String,
    pub personal_title: Option<String>,
    pub version: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConversationSnapshot {
    pub id: Uuid,
    pub kind: ConversationKind,
    pub shared_title: Option<String>,
    pub version: i32,
    pub created_by_account_id: String,
    pub legacy_session_id: Option<String>,
    pub forked_from_session_id: Option<String>,
    pub forked_from_message_id: Option<String>,
    pub latest_message_sequence: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub members: Vec<MemberSnapshot>,
    pub preferences: ConversationPreferencesSnapshot,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MessageSnapshot {
    pub id: Uuid,
    pub client_message_id: Uuid,
    pub conversation_id: Uuid,
    pub conversation_sequence: i64,
    pub sender_account_id: String,
    pub kind: String,
    pub content: Value,
    pub reply_to_message_id: Option<Uuid>,
    pub attachment_ids: Vec<String>,
    pub version: i32,
    pub generation_status: Option<String>,
    pub provider_response_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub reactions: Vec<ReactionSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ReactionSnapshot {
    pub reaction: String,
    pub account_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ConversationCursorSnapshot {
    pub conversation_id: Uuid,
    pub account_id: String,
    pub last_delivered_sequence: i64,
    pub last_read_sequence: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateConversationRequest {
    pub client_operation_id: Uuid,
    pub kind: ConversationKind,
    pub shared_title: Option<String>,
    /// Stable client-side session identity used to converge independently
    /// created devices onto one durable conversation. This is an opaque key;
    /// it is never used as the message ordering primitive.
    pub client_session_id: String,
    #[serde(default)]
    pub member_account_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SendMessageRequest {
    pub client_message_id: Uuid,
    #[serde(default = "default_message_kind")]
    pub kind: String,
    pub content: Value,
    pub reply_to_message_id: Option<Uuid>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UpdateReactionRequest {
    pub reaction: String,
}

fn default_message_kind() -> String {
    "text".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UpdateConversationTitleRequest {
    pub client_operation_id: Uuid,
    pub expected_version: i32,
    pub shared_title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UpdatePersonalTitleRequest {
    pub client_operation_id: Uuid,
    pub expected_preferences_version: i32,
    pub personal_title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AddConversationMembersRequest {
    pub client_operation_id: Uuid,
    #[serde(default)]
    pub member_account_ids: Vec<String>,
    /// When true, member_account_ids is the complete desired active snapshot
    /// (the caller is always retained). Missing current members are removed.
    #[serde(default)]
    pub replace: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdvanceConversationCursorRequest {
    pub client_operation_id: Uuid,
    pub sequence: i64,
}

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    pub before_sequence: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SyncQuery {
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct SyncEventSnapshot {
    pub stream_seq: i64,
    pub event_id: Uuid,
    pub protocol_version: i32,
    #[serde(rename = "type")]
    pub event_type: String,
    pub critical: bool,
    pub conversation_id: Option<Uuid>,
    pub entity_id: Option<Uuid>,
    pub entity_version: Option<i32>,
    pub occurred_at: DateTime<Utc>,
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct ConversationResponse {
    pub conversation: ConversationSnapshot,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub message: MessageSnapshot,
}

#[derive(Debug, Serialize)]
pub struct ConversationPreferencesResponse {
    pub preferences: ConversationPreferencesSnapshot,
}

#[derive(Debug, Serialize)]
pub struct CursorResponse {
    pub cursor: ConversationCursorSnapshot,
}

#[derive(Debug, Serialize)]
pub struct HistoryResponse {
    pub messages: Vec<MessageSnapshot>,
    pub next_before_sequence: Option<i64>,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct SyncResponse {
    pub protocol_version: i32,
    pub events: Vec<SyncEventSnapshot>,
    pub next_cursor: String,
    pub last_stream_seq: i64,
    pub has_more: bool,
    pub server_time: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct BootstrapResponse {
    pub protocol_version: i32,
    pub conversations: Vec<ConversationSnapshot>,
    pub latest_messages: Vec<MessageSnapshot>,
    pub next_cursor: String,
    pub last_stream_seq: i64,
    pub server_time: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RealtimeTicketResponse {
    pub ticket: String,
    pub device_id: String,
    pub expires_at: DateTime<Utc>,
}
