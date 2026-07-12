use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionState {
    pub storage_path: String,
    pub profile: CanonicalLocalProfile,
    pub identities: Vec<CanonicalIdentity>,
    pub sessions: Vec<CanonicalSession>,
    pub participants: Vec<CanonicalSessionParticipant>,
    pub messages: Vec<CanonicalSessionMessage>,
    pub delegated_exchanges: Vec<CanonicalDelegatedExchange>,
    pub presence: Vec<CanonicalPresence>,
    pub context_snapshots: Vec<CanonicalContextSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalProfileIdentityDelta {
    pub profile: CanonicalLocalProfile,
    pub identity: CanonicalIdentity,
    pub previous_identity_id: Option<String>,
    pub group_self_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionCatalog {
    pub storage_path: String,
    pub profile: CanonicalLocalProfile,
    pub identities: Vec<CanonicalIdentity>,
    pub sessions: Vec<CanonicalSession>,
    pub participants: Vec<CanonicalSessionParticipant>,
    pub delegated_exchanges: Vec<CanonicalDelegatedExchange>,
    pub presence: Vec<CanonicalPresence>,
    pub summaries: Vec<CanonicalSessionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionSummary {
    pub session_id: String,
    pub message_count: i64,
    pub latest_message: Option<CanonicalSessionMessage>,
    pub context_snapshot_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalMessagePage {
    pub session_id: String,
    pub messages: Vec<CanonicalSessionMessage>,
    pub oldest_sequence_num: Option<i64>,
    pub newest_sequence_num: Option<i64>,
    pub has_older: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalReadCursorDelta {
    pub session_id: String,
    pub identity_id: String,
    pub last_seen_at_ms: i64,
    pub last_read_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalMessageDeliveryDelta {
    pub message_id: String,
    pub session_id: String,
    pub status: String,
    pub delivery_state: String,
    pub delivered_recipient_ids: Vec<String>,
    pub pending_recipient_ids: Vec<String>,
    pub exhausted_recipient_ids: Vec<String>,
    pub updated_at_ms: i64,
    pub content_hash: String,
    pub session_updated_at_ms: i64,
    pub session_last_message_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCanonicalSessionFastResult {
    pub session: CanonicalSession,
    pub participants: Vec<CanonicalSessionParticipant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalLocalProfile {
    pub id: String,
    pub display_name: Option<String>,
    pub human_identity_id: Option<String>,
    pub active_agent_identity_id: Option<String>,
    pub storage_root: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalIdentity {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub owner_identity_id: Option<String>,
    pub source: String,
    pub source_host_id: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub avatar_key: String,
    pub profile_image_url: Option<String>,
    pub metadata: Option<Value>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSession {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub created_by_identity_id: String,
    pub primary_identity_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub relationship_identity_id: Option<String>,
    pub metadata: Option<Value>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_message_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionParticipant {
    pub session_id: String,
    pub identity_id: String,
    pub role: String,
    pub state: String,
    pub added_by_identity_id: Option<String>,
    pub added_at_ms: i64,
    pub last_seen_at_ms: Option<i64>,
    pub last_read_message_id: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionMessage {
    pub id: String,
    pub session_id: String,
    pub sender_identity_id: String,
    pub sender_role: String,
    pub message_kind: String,
    pub content_text: String,
    pub content: Option<Value>,
    pub parent_message_id: Option<String>,
    pub delegated_exchange_id: Option<String>,
    pub status: String,
    pub sequence_num: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub content_hash: Option<String>,
    pub source_transport: Option<String>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalDelegatedExchange {
    pub id: String,
    pub session_id: String,
    pub initiator_identity_id: String,
    pub target_identity_id: String,
    pub trigger_message_id: Option<String>,
    pub request_message_id: Option<String>,
    pub response_message_id: Option<String>,
    pub transport: String,
    pub bridge_host_id: Option<String>,
    pub bridge_conversation_id: Option<String>,
    pub bridge_request_id: Option<String>,
    pub context_policy: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalPresence {
    pub identity_id: String,
    pub status: String,
    pub session_id: Option<String>,
    pub detail: Option<String>,
    pub updated_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalContextSnapshot {
    pub id: String,
    pub profile_id: String,
    pub session_id: String,
    pub agent_identity_id: String,
    pub provider: String,
    pub model: String,
    pub prompt_hash: String,
    pub project_context_hash: Option<String>,
    pub participant_hash: String,
    pub upto_message_id: Option<String>,
    pub message_range_hash: String,
    pub summary_text: Option<String>,
    pub summary_json: Option<Value>,
    pub token_count: Option<i64>,
    pub created_at_ms: i64,
    pub invalidated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCanonicalIdentityRequest {
    pub id: Option<String>,
    pub kind: String,
    pub display_name: String,
    pub owner_identity_id: Option<String>,
    pub source: Option<String>,
    pub source_host_id: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub avatar_key: Option<String>,
    pub profile_image_url: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptCloudProfileIdentityRequest {
    pub account_id: String,
    pub display_name: String,
    pub avatar_key: Option<String>,
    pub profile_image_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCanonicalSessionRequest {
    pub id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub created_by_identity_id: String,
    pub primary_identity_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub relationship_identity_id: Option<String>,
    pub participant_identity_ids: Vec<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendCanonicalMessageRequest {
    pub id: Option<String>,
    pub session_id: String,
    pub sender_identity_id: String,
    pub sender_role: String,
    pub message_kind: String,
    pub content_text: String,
    pub content: Option<Value>,
    pub created_at_ms: Option<i64>,
    pub parent_message_id: Option<String>,
    pub delegated_exchange_id: Option<String>,
    pub status: Option<String>,
    pub source_transport: Option<String>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCanonicalMessageDeliveryRequest {
    pub message_id: String,
    pub session_id: String,
    pub status: String,
    pub delivery_state: String,
    pub delivered_recipient_ids: Vec<String>,
    pub pending_recipient_ids: Vec<String>,
    pub exhausted_recipient_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCanonicalDelegatedExchangeRequest {
    pub id: Option<String>,
    pub session_id: String,
    pub initiator_identity_id: String,
    pub target_identity_id: String,
    pub trigger_message_id: Option<String>,
    pub request_message_id: Option<String>,
    pub response_message_id: Option<String>,
    pub transport: Option<String>,
    pub bridge_host_id: Option<String>,
    pub bridge_conversation_id: Option<String>,
    pub bridge_request_id: Option<String>,
    pub context_policy: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCanonicalPresenceRequest {
    pub identity_id: String,
    pub status: String,
    pub session_id: Option<String>,
    pub detail: Option<String>,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameCanonicalSessionRequest {
    pub session_id: String,
    pub title: String,
    pub requested_by_identity_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCanonicalSessionMetadataRequest {
    pub session_id: String,
    pub metadata: Value,
    pub requested_by_identity_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCanonicalSessionParticipantsRequest {
    pub session_id: String,
    pub identity_ids: Vec<String>,
    pub added_by_identity_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCanonicalSessionParticipantRequest {
    pub session_id: String,
    pub identity_id: String,
    pub removed_by_identity_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCanonicalSessionParticipantRoleRequest {
    pub session_id: String,
    pub identity_id: String,
    pub role: String,
    pub requested_by_identity_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkCanonicalSessionReadRequest {
    pub session_id: String,
    pub identity_id: Option<String>,
    pub message_id: Option<String>,
}
