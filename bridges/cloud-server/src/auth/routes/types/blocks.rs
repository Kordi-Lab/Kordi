use super::*;

/// One account the caller blocked. The list is private to the blocker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedAccountSummary {
    pub account_id: String,
    pub kordi_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub blocked_at: String,
}

#[derive(Debug, Serialize)]
pub struct BlockListResponse {
    pub blocks: Vec<BlockedAccountSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockResponse {
    pub block: BlockedAccountSummary,
    /// Whether the block ended an accepted contact relationship.
    pub removed_contact: bool,
}

/// `POST /v1/cloud/contacts` answer when the add became a contact request.
#[derive(Debug, Serialize)]
pub struct ContactRequestPendingResponse {
    pub status: &'static str,
    pub request: ContactRequestSummary,
}
