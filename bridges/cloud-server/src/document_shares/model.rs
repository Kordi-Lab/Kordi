//! Wire shapes for shared documents. Field names are camelCase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentResponse {
    pub attachment_id: String,
    pub title: String,
    pub file_name: String,
    pub format: DocumentFormat,
    pub content_type: String,
    pub size_bytes: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub author: DocumentAuthor,
    pub agent: Option<DocumentAgent>,
    pub blocks: Vec<DocumentBlock>,
    pub raw_path: Option<String>,
    pub revision: i64,
    pub reactions: Vec<DocumentReaction>,
    pub comments: Vec<DocumentComment>,
    pub share: Option<DocumentShare>,
    pub viewer: Viewer,
    pub viewer_can: ViewerCan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Markdown,
    Html,
}

impl DocumentFormat {
    pub fn default_file_name(self) -> &'static str {
        match self {
            Self::Markdown => "document.md",
            Self::Html => "document.html",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Viewer {
    Owner,
    Member,
    Public,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAuthor {
    pub account_id: String,
    pub display_name: String,
    pub kordi_id: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAgent {
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlock {
    pub id: String,
    pub source: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerCan {
    pub share: bool,
    pub react: bool,
    pub comment: bool,
    pub ask_agent: bool,
    pub edit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentShare {
    pub share_id: String,
    pub attachment_id: String,
    pub share_url: String,
    pub deep_link: String,
    pub access_mode: String,
    pub readers_can_ask_agent: bool,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentShareList {
    pub shares: Vec<DocumentShare>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReaction {
    pub reaction_id: String,
    pub block_id: String,
    pub reaction: String,
    pub actor: ReactionActor,
    pub mine: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionActor {
    pub account_id: Option<String>,
    pub reader_key: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentReactionList {
    pub reactions: Vec<DocumentReaction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentComment {
    pub comment_id: String,
    pub block_id: String,
    pub parent_comment_id: Option<String>,
    pub author: CommentAuthor,
    pub body: String,
    pub mentions_agent: bool,
    pub mine: bool,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentAuthor {
    pub account_id: Option<String>,
    pub display_name: String,
    pub kordi_id: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareRequest {
    pub session_id: Option<String>,
    pub readers_can_ask_agent: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchShareRequest {
    pub readers_can_ask_agent: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionRequest {
    pub block_id: String,
    pub reaction: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicReactionRequest {
    pub block_id: String,
    pub reaction: String,
    pub reader_key: String,
    pub reader_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentRequest {
    pub block_id: String,
    pub body: String,
    pub parent_comment_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicCommentRequest {
    pub block_id: String,
    pub body: String,
    pub reader_key: String,
    pub reader_name: String,
    pub parent_comment_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchCommentRequest {
    pub body: Option<String>,
    pub resolved: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveContentRequest {
    pub base_revision: i64,
    pub source: String,
}

/// `409 document_revision_conflict`: the error fields plus the current
/// document, so a client can rebase without another request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionConflict {
    pub error_code: &'static str,
    pub message: &'static str,
    #[serde(flatten)]
    pub document: DocumentResponse,
}

/// Optional `?readerKey=` on the public read so `mine` is set for the caller.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicReadQuery {
    pub reader_key: Option<String>,
}
