use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub node_id: String,
    pub display_name: Option<String>,
    pub runtime: Option<String>,
    pub endpoint: Option<String>,
    pub public_key: String,
    pub owner_principal_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
    pub node_id: String,
    pub display_name: Option<String>,
    pub runtime: Option<String>,
    pub endpoint: Option<String>,
    pub public_key: Option<String>,
    pub owner_name: Option<String>,
    pub trust_status: String,
    pub last_seen_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub project_id: String,
    pub slug: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub project_path: Option<String>,
    pub owner_principal_id: Option<String>,
    pub status: String,
    pub created_at: String,
}
