use super::*;

#[derive(Debug, Clone)]
pub struct CloudSession {
    pub token_id: String,
    pub account_id: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthStartQuery {
    #[serde(rename = "redirectAfter")]
    pub redirect_after: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OAuthStartResponse {
    #[serde(rename = "authUrl")]
    pub auth_url: String,
}

#[derive(Debug, Serialize)]
pub struct AuthCapabilitiesResponse {
    pub password: bool,
    #[serde(rename = "oauthProviders")]
    pub oauth_providers: Vec<&'static str>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AccountResponse {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "primaryEmail")]
    pub primary_email: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "passwordSet")]
    pub password_set: bool,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub account: AccountResponse,
    pub session: SessionResponse,
}

#[derive(Debug, Serialize)]
pub struct PublicProfileResponse {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "isContact")]
    pub is_contact: bool,
    #[serde(rename = "isSelf")]
    pub is_self: bool,
}

#[derive(Debug, Deserialize)]
pub struct AddContactRequest {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContactSummary {
    #[serde(rename = "contactId", skip_serializing_if = "Option::is_none")]
    pub contact_id: Option<String>,
    #[serde(rename = "contactKind", skip_serializing_if = "Option::is_none")]
    pub contact_kind: Option<String>,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub locked: bool,
    #[serde(rename = "targetCloudAgentId", skip_serializing_if = "Option::is_none")]
    pub target_cloud_agent_id: Option<String>,
    #[serde(
        rename = "targetCloudAgentName",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_cloud_agent_name: Option<String>,
    #[serde(
        rename = "targetCloudAgentOwnerAccountId",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_cloud_agent_owner_account_id: Option<String>,
    #[serde(
        rename = "targetCloudAgentOwnerName",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_cloud_agent_owner_name: Option<String>,
    #[serde(rename = "supportTicketEnabled")]
    pub support_ticket_enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ContactsListResponse {
    pub contacts: Vec<ContactSummary>,
}

#[derive(Debug, Deserialize)]
pub struct SendContactRequestBody {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContactRequestSummary {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "fromAccountId")]
    pub from_account_id: String,
    #[serde(rename = "toAccountId")]
    pub to_account_id: String,
    pub status: String,
    pub direction: String, // "incoming" | "outgoing", relative to the caller
    pub message: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "decidedAt")]
    pub decided_at: Option<String>,
    /// Counterpart profile (the from-account for incoming, the
    /// to-account for outgoing). Empty when the row predates the
    /// account being looked up (shouldn't happen with FK + cascade
    /// but defensive nonetheless).
    pub counterpart: Option<ContactSummary>,
}

#[derive(Debug, Serialize)]
pub struct ContactRequestListResponse {
    pub requests: Vec<ContactRequestSummary>,
}

#[derive(Debug, Serialize)]
pub struct ContactRequestResponse {
    pub request: ContactRequestSummary,
    #[serde(rename = "helloMessage", skip_serializing_if = "Option::is_none")]
    pub hello_message: Option<MessageSummary>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageAttachmentRequest {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    pub name: String,
    pub kind: String,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<i64>,
    #[serde(rename = "previewUrl")]
    pub preview_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
    pub body: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "clientCreatedAt")]
    pub client_created_at: Option<String>,
    #[serde(rename = "clientMessageId")]
    pub client_message_id: Option<String>,
    #[serde(default)]
    pub attachments: Vec<SendMessageAttachmentRequest>,
}

#[derive(Debug, Deserialize)]
pub struct MarkMessagesReadRequest {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MessageAttachmentSummary {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    pub name: String,
    pub kind: String,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<i64>,
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[serde(rename = "previewUrl")]
    pub preview_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MessageSummary {
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "fromAccountId")]
    pub from_account_id: String,
    #[serde(rename = "toAccountId")]
    pub to_account_id: String,
    pub body: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "deliveredAt")]
    pub delivered_at: Option<String>,
    #[serde(rename = "readAt")]
    pub read_at: Option<String>,
    /// Direction relative to the caller — "outgoing" if the caller sent
    /// the message, "incoming" otherwise. Saves the client a comparison.
    pub direction: String,
    pub attachments: Vec<MessageAttachmentSummary>,
}

#[derive(Debug, Serialize)]
pub struct MessageListResponse {
    pub messages: Vec<MessageSummary>,
    /// Durable peer-level read boundary for the caller. The desktop keeps
    /// older history in its local cache than this endpoint returns, so it
    /// needs the cursor to reconcile cached rows outside the response window.
    #[serde(rename = "peerReadAt")]
    pub peer_read_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MessageBodyLookupRequest {
    #[serde(rename = "messageIds")]
    pub message_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MessageBodyLookupSummary {
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct MessageBodyLookupResponse {
    pub messages: Vec<MessageBodyLookupSummary>,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub message: MessageSummary,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
    /// Optional cap, default 200, max 500.
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CloudSyncQuery {
    /// Last successfully applied sync event id. `0` means from the beginning.
    pub cursor: Option<i64>,
    /// Optional cap, default 500, max 1000.
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CloudSyncEventSummary {
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: Option<String>,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub payload: serde_json::Value,
    #[serde(rename = "occurredAt")]
    pub occurred_at: String,
}

#[derive(Debug, Serialize)]
pub struct CloudSyncResponse {
    pub cursor: String,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    pub events: Vec<CloudSyncEventSummary>,
}

#[derive(Debug, Serialize)]
pub struct CloudSessionVisibilityResponse {
    #[serde(rename = "hiddenSessionIds")]
    pub hidden_session_ids: Vec<String>,
    #[serde(rename = "deletedSessionIds")]
    pub deleted_session_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCloudSessionPinRequest {
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub scope: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CloudSessionPinSummary {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sharedMessageId")]
    pub shared_message_id: Option<String>,
    #[serde(rename = "privateMessageId")]
    pub private_message_id: Option<String>,
    #[serde(rename = "effectiveMessageId")]
    pub effective_message_id: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CloudSessionPinResponse {
    pub pin: CloudSessionPinSummary,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCloudSessionTitleRequest {
    pub title: String,
    #[serde(rename = "titleSource")]
    pub title_source: String,
    #[serde(rename = "titleRevision")]
    pub title_revision: i64,
    #[serde(rename = "titlePolicyVersion")]
    pub title_policy_version: i64,
    #[serde(rename = "titleGeneratedFromMessageId")]
    pub title_generated_from_message_id: Option<String>,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct CloudSessionTitleSummary {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub title: String,
    #[serde(rename = "titleSource")]
    pub title_source: String,
    #[serde(rename = "titleRevision")]
    pub title_revision: i64,
    #[serde(rename = "titlePolicyVersion")]
    pub title_policy_version: i64,
    #[serde(rename = "titleGeneratedFromMessageId")]
    pub title_generated_from_message_id: Option<String>,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
    #[serde(rename = "updatedByAccountId")]
    pub updated_by_account_id: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct CloudSessionTitleResponse {
    #[serde(rename = "sessionTitle")]
    pub session_title: CloudSessionTitleSummary,
}

#[derive(Debug, Serialize)]
pub struct PresenceContactsResponse {
    pub accounts: Vec<crate::presence::AccountPresenceSummary>,
}

#[derive(Debug, Serialize)]
pub(super) struct ErrorBody {
    #[serde(rename = "errorCode")]
    pub(super) error_code: &'static str,
    pub(super) message: String,
}
