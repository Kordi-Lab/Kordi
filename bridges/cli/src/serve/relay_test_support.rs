use sha2::{Digest, Sha256};

use super::ServerState;

#[derive(Default)]
pub(super) struct RegisteredNodePolicy<'a> {
    human_id: Option<&'a str>,
    agent_id: Option<&'a str>,
    human_visibility: Option<&'a str>,
    contact_approval: Option<&'a str>,
    agent_reachability: Option<&'a str>,
}

impl<'a> RegisteredNodePolicy<'a> {
    pub(super) fn human(
        human_id: &'a str,
        visibility: &'a str,
        approval: &'a str,
        reachability: &'a str,
    ) -> Self {
        Self {
            human_id: Some(human_id),
            human_visibility: Some(visibility),
            contact_approval: Some(approval),
            agent_reachability: Some(reachability),
            ..Self::default()
        }
    }

    pub(super) fn agent(human_id: &'a str, agent_id: &'a str, reachability: &'a str) -> Self {
        Self {
            human_id: Some(human_id),
            agent_id: Some(agent_id),
            human_visibility: Some("private"),
            contact_approval: Some("approval-required"),
            agent_reachability: Some(reachability),
        }
    }
}

pub(super) fn seed_registered_node(state: &ServerState, node_id: &str, api_key: &str) {
    seed_registered_node_with_policy(state, node_id, api_key, RegisteredNodePolicy::default());
}

pub(super) fn seed_registered_node_with_policy(
    state: &ServerState,
    node_id: &str,
    api_key: &str,
    policy: RegisteredNodePolicy<'_>,
) {
    let conn = state.open_connection().unwrap();
    let mut hash = Sha256::new();
    hash.update(api_key.as_bytes());
    let api_key_hash = hex::encode(hash.finalize());
    conn.execute(
        "INSERT OR IGNORE INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, human_id, agent_id, api_key_hash, human_visibility_policy, contact_approval_policy, agent_reachability_policy, created_at) VALUES (?1, 'ed25519', 'x25519', ?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            node_id,
            policy.human_id,
            policy.agent_id,
            api_key_hash,
            policy.human_visibility,
            policy.contact_approval,
            policy.agent_reachability,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .unwrap();
}
