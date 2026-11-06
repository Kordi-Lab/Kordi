use super::*;

#[derive(Debug, Deserialize)]
pub struct CreateGroupInvitationRequest {
    #[serde(rename = "groupId")]
    pub group_id: String,
    #[serde(rename = "groupSpaceId")]
    pub group_space_id: String,
    #[serde(rename = "groupTitle")]
    pub group_title: String,
    /// Revoke the group's live links and make a new one, for an admin whose
    /// link leaked.
    #[serde(default)]
    pub reset: bool,
}

#[derive(Debug, Serialize)]
pub struct GroupInvitationResponse {
    #[serde(rename = "invitationId")]
    pub invitation_id: String,
    #[serde(rename = "inviteUrl")]
    pub invite_url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct GroupInvitationSummaryResponse {
    #[serde(rename = "invitationId")]
    pub invitation_id: String,
    #[serde(rename = "inviteUrl")]
    pub invite_url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct GroupInvitationListResponse {
    pub invitations: Vec<GroupInvitationSummaryResponse>,
}

#[derive(Debug, Serialize)]
pub struct GroupInvitationGroupResponse {
    pub name: String,
    #[serde(rename = "memberCount")]
    pub member_count: usize,
}

#[derive(Debug, Serialize)]
pub struct GroupInvitationPreviewResponse {
    pub inviter: AppInvitationInviterResponse,
    pub group: GroupInvitationGroupResponse,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct GroupInvitationAcceptanceResponse {
    pub status: &'static str,
    #[serde(rename = "groupId")]
    pub group_id: String,
    #[serde(rename = "groupSpaceId")]
    pub group_space_id: String,
    #[serde(rename = "groupTitle")]
    pub group_title: String,
}
