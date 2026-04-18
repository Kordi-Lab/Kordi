use reqwest::Client;
use serde::{Deserialize, Serialize};

/// Hint about a peer's network endpoint (direct IP, reflexive, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointHint {
    pub addr: String,
    pub hint_type: String, // "lan", "stun", "direct"
}

/// Peer cryptographic keys returned by the coordination server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerKeys {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "ed25519Pubkey")]
    pub ed25519_pub: String,
    #[serde(rename = "x25519Pubkey")]
    pub x25519_pub: String,
}

#[derive(Deserialize)]
struct KeysQueryResp {
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(rename = "ed25519Pubkey")]
    ed25519_pubkey: String,
    #[serde(rename = "x25519Pubkey")]
    x25519_pubkey: String,
}

/// Project member info.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberInfo {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "agentRole")]
    pub role: Option<String>,
}

/// Client for the Bridges coordination server API.
#[derive(Debug, Clone)]
pub struct CoordClient {
    pub base_url: String,
    pub api_key: String,
    client: Client,
}

impl CoordClient {
    pub fn new(base_url: &str, api_key: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            client: Client::new(),
        }
    }

    /// Push endpoint hints for this node.
    pub async fn push_endpoint_hints(&self, hints: &[EndpointHint]) -> Result<(), String> {
        let url = format!("{}/v1/endpoints", self.base_url);
        self.client
            .put(&url)
            .bearer_auth(&self.api_key)
            .json(hints)
            .send()
            .await
            .map_err(|e| format!("push_endpoints: {}", e))?;
        Ok(())
    }

    /// Get a peer's public keys.
    pub async fn get_peer_keys(&self, peer_id: &str) -> Result<PeerKeys, String> {
        let url = format!("{}/v1/keys/{}", self.base_url, peer_id);
        self.fetch_peer_keys(&url).await
    }

    /// Get a peer's public keys scoped to a specific project membership.
    pub async fn get_peer_keys_in_project(
        &self,
        peer_id: &str,
        project_id: &str,
    ) -> Result<PeerKeys, String> {
        let url = format!(
            "{}/v1/keys/{}?project={}",
            self.base_url, peer_id, project_id
        );
        self.fetch_peer_keys(&url).await
    }

    async fn fetch_peer_keys(&self, url: &str) -> Result<PeerKeys, String> {
        let resp = self
            .client
            .get(url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("get_peer_keys: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("get_peer_keys HTTP {}", resp.status()));
        }

        let keys = resp
            .json::<KeysQueryResp>()
            .await
            .map_err(|e| format!("parse peer keys: {}", e))?;
        Ok(PeerKeys {
            node_id: keys.node_id,
            ed25519_pub: keys.ed25519_pubkey,
            x25519_pub: keys.x25519_pubkey,
        })
    }

    /// List keys for all members of a project.
    pub async fn get_project_keys(&self, project_id: &str) -> Result<Vec<PeerKeys>, String> {
        let url = format!("{}/v1/keys?project={}", self.base_url, project_id);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("get_project_keys: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("get_project_keys HTTP {}", resp.status()));
        }

        let keys = resp
            .json::<Vec<KeysQueryResp>>()
            .await
            .map_err(|e| format!("parse project keys: {}", e))?;
        Ok(keys
            .into_iter()
            .map(|k| PeerKeys {
                node_id: k.node_id,
                ed25519_pub: k.ed25519_pubkey,
                x25519_pub: k.x25519_pubkey,
            })
            .collect())
    }

    /// Get a peer's endpoint hints.
    pub async fn get_peer_endpoints(&self, peer_id: &str) -> Result<Vec<EndpointHint>, String> {
        let url = format!("{}/v1/endpoints/{}", self.base_url, peer_id);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("get_peer_endpoints: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("get_peer_endpoints HTTP {}", resp.status()));
        }

        resp.json::<Vec<EndpointHint>>()
            .await
            .map_err(|e| format!("parse endpoints: {}", e))
    }

    /// Get members of a project.
    pub async fn get_project_members(&self, project_id: &str) -> Result<Vec<MemberInfo>, String> {
        let url = format!("{}/v1/projects/{}/members", self.base_url, project_id);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("get_project_members: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("get_project_members HTTP {}", resp.status()));
        }

        resp.json::<Vec<MemberInfo>>()
            .await
            .map_err(|e| format!("parse members: {}", e))
    }

    /// Fetch and drain pending messages from the server mailbox.
    pub async fn fetch_mailbox(&self) -> Result<Vec<serde_json::Value>, String> {
        let url = format!("{}/v1/mailbox", self.base_url);
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| format!("fetch_mailbox: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("fetch_mailbox HTTP {}", resp.status()));
        }

        resp.json::<Vec<serde_json::Value>>()
            .await
            .map_err(|e| format!("parse mailbox: {}", e))
    }

    /// Relay an opaque blob to a target node via the coordination server.
    /// The server stores it in the target's mailbox for later pickup.
    pub async fn relay_message(
        &self,
        target_node_id: &str,
        blob: &str,
        project_id: Option<&str>,
    ) -> Result<(), String> {
        let url = format!("{}/v1/relay", self.base_url);
        let body = serde_json::json!({
            "targetNodeId": target_node_id,
            "blob": blob,
            "projectId": project_id,
        });
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("relay: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("relay HTTP {}", resp.status()));
        }
        Ok(())
    }
}
