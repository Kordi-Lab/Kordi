//! Account memory wire types (`/v1/cloud/memory`).

use serde::{Deserialize, Serialize};

/// One account memory as the server returns it.
///
/// Group memories are shared by the group, so the list also holds memories
/// other members saved. The cache stores them like any other row: they arrive
/// with `pending_upload = 0`, so the Mac never uploads or archives them on its
/// own. The owner fields stay out of the cache; the agent only reads the text,
/// and the desktop Memory tab reads owners from the account list.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemory {
    pub memory_id: String,
    pub scope: String,
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    /// The account that saved the memory.
    #[serde(default)]
    pub owner_account_id: Option<String>,
    /// That account's display name, when it has one.
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub declaration_type: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_kind: Option<String>,
}

/// Body of `POST /v1/cloud/memory`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewRemoteMemory {
    pub scope: String,
    pub scope_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_memory_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    /// `user` or `agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_by: Option<String>,
}

/// Account memory switches as the server returns them.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemorySettings {
    pub memory_enabled: bool,
    pub exclude_sensitive: bool,
}

/// Body of `GET /v1/cloud/memory`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMemoryList {
    pub memories: Vec<RemoteMemory>,
    pub settings: RemoteMemorySettings,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MemoryRemoteError {
    /// The server cannot be reached, the person is signed out, or the server
    /// predates the memory routes. The Mac keeps working locally.
    #[error("account memory is unavailable: {0}")]
    Unavailable(String),
    /// The server guards rejected the text (422 `memory_rejected`).
    #[error("{0}")]
    Rejected(String),
    /// Memory is off for the account (409 `memory_disabled`).
    #[error("Memory is turned off for this account, so nothing was saved.")]
    Disabled,
    #[error("account memory request failed: {0}")]
    Other(String),
}
