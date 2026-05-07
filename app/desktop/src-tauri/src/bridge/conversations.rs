use base64::Engine as _;
use sha2::{Digest, Sha256};

use super::constants::{
    is_agent_like_runtime, BRIDGE_DELIVERY_STATE_RESPONDED, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    PEER_TYPING_WINDOW_MS,
};
use super::{
    bridge_conversation_id, format_time_label, format_time_label_with_seconds, now_ms,
    DesktopBridgeConversation, DesktopBridgeConversationMessage, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore,
};

fn is_person_runtime(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("person")
}

fn scoped_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> String {
    let base = bridge_conversation_id(host_id, peer_node_id, project_id);
    if is_person_runtime(peer_runtime) {
        format!("{base}:person")
    } else {
        base
    }
}

fn bridge_session_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..12])
}

fn canonical_session_id_for_record(record: &DesktopBridgeConversationRecord) -> String {
    if is_person_runtime(&record.peer_runtime) {
        if let Some(identity) = &record.identity {
            if let Some(remote_human_id) = identity
                .remote_human_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let mut participants = [identity.local_human_id.trim(), remote_human_id];
                participants.sort_unstable();
                return format!(
                    "session:bridge:humans:{}",
                    bridge_session_hash(&participants.join("|"))
                );
            }
        }
        return crate::canonical_sessions::canonical_bridge_session_id(&record.id);
    }

    // Conversation-level outreach is mutable latest-state routing metadata. It must never
    // become the visible canonical conversation id; otherwise a direct transport chat can
    // overwrite a stable parent shared session as a direct-agent session on the next sync.
    crate::canonical_sessions::canonical_bridge_session_id(&record.id)
}

fn conversation_matches(
    conversation: &DesktopBridgeConversationRecord,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: Option<&str>,
) -> bool {
    conversation.host_id == host_id
        && conversation.peer_node_id == peer_node_id
        && conversation.project_id.as_deref() == project_id
        && peer_runtime
            .map(|runtime| {
                is_person_runtime(&conversation.peer_runtime) == is_person_runtime(runtime)
            })
            .unwrap_or(true)
}

fn is_terminal_agent_request_delivery_state(state: &str) -> bool {
    matches!(
        state.trim().to_ascii_lowercase().as_str(),
        BRIDGE_DELIVERY_STATE_RESPONDED
            | "cancelled"
            | "failed"
            | "processing_failed"
            | "no_response"
    )
}

pub(super) fn upsert_bridge_conversation<'a>(
    store: &'a mut DesktopBridgeConversationStore,
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
) -> &'a mut DesktopBridgeConversationRecord {
    let conversation_id =
        scoped_conversation_id(host_id, peer_node_id, project_id.as_deref(), &peer_runtime);
    let maybe_index = store.conversations.iter().position(|conversation| {
        conversation.id == conversation_id
            || conversation_matches(
                conversation,
                host_id,
                peer_node_id,
                project_id.as_deref(),
                Some(&peer_runtime),
            )
    });
    let index = if let Some(index) = maybe_index {
        index
    } else {
        store.conversations.push(DesktopBridgeConversationRecord {
            id: conversation_id,
            host_id: host_id.to_string(),
            peer_node_id: peer_node_id.to_string(),
            peer_display_name: peer_display_name.clone(),
            peer_owner_name: peer_owner_name.clone(),
            peer_runtime: peer_runtime.clone(),
            project_id: project_id.clone(),
            project_name: project_name.clone(),
            unread_count: 0,
            updated_at_ms: now_ms(),
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            outreach: None,
            identity: None,
            messages: Vec::new(),
        });
        store.conversations.len() - 1
    };

    let conversation = &mut store.conversations[index];
    if peer_display_name.is_some() {
        conversation.peer_display_name = peer_display_name;
    }
    if peer_owner_name.is_some() {
        conversation.peer_owner_name = peer_owner_name;
    }
    if !peer_runtime.trim().is_empty() {
        conversation.peer_runtime = peer_runtime;
    }
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
    conversation
}

pub(super) fn parse_mailbox_payload(blob: &str) -> Option<serde_json::Value> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(blob)
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn labels_match(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

pub(super) fn conversation_title(record: &DesktopBridgeConversationRecord) -> String {
    if record.peer_runtime.trim().eq_ignore_ascii_case("person") {
        return record
            .peer_owner_name
            .clone()
            .or_else(|| record.peer_display_name.clone())
            .unwrap_or_else(|| record.peer_node_id.clone());
    }

    if is_agent_like_runtime(&record.peer_runtime) {
        let owner = record
            .peer_owner_name
            .clone()
            .filter(|value| !value.trim().is_empty());
        let agent = record
            .peer_display_name
            .clone()
            .filter(|value| !value.trim().is_empty());

        return match (owner, agent) {
            (Some(owner), Some(agent)) if labels_match(&owner, &agent) => owner,
            (_owner, Some(agent)) => agent,
            (Some(owner), None) => owner,
            (None, None) => record.peer_node_id.clone(),
        };
    }

    record
        .peer_display_name
        .clone()
        .or_else(|| record.peer_owner_name.clone())
        .unwrap_or_else(|| record.peer_node_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::{
        DesktopBridgeConversationMessageRecord, DesktopBridgeIdentitySnapshot,
        DesktopBridgeOutreachMetadata,
    };

    fn test_outreach(parent_session_id: &str) -> DesktopBridgeOutreachMetadata {
        DesktopBridgeOutreachMetadata {
            target_kind: "bridge-agent".to_string(),
            parent_session_id: Some(parent_session_id.to_string()),
            parent_session_title: Some("Shared humans".to_string()),
            parent_session_kind: None,
            parent_group_space_id: None,
            parent_session_participants: Vec::new(),
            parent_session_messages: Vec::new(),
            initiator_identity: None,
            self_target_identity: None,
            parent_turn_id: None,
            parent_message_id: None,
            bridge_host_id: "bridge_host".to_string(),
            bridge_conversation_id: None,
            bridge_request_id: Some("bridge_req".to_string()),
            delivery_state: None,
            target_node_id: "kd_remote".to_string(),
            target_human_id: Some("kh_remote".to_string()),
            target_agent_id: Some("ka_remote".to_string()),
            target_display_name: "Remote Kordi".to_string(),
            target_owner_name: Some("Remote".to_string()),
            target_runtime: Some("kordi-desktop".to_string()),
            request_text: "hello".to_string(),
            trigger_text: Some("@Remote Kordi hello".to_string()),
            context_text: None,
            context_policy: Some("recent-window".to_string()),
            project_id: None,
            project_name: None,
            status: "completed".to_string(),
            created_at_ms: 1,
            updated_at_ms: 2,
            completed_at_ms: Some(2),
            error: None,
        }
    }

    fn test_record(peer_runtime: &str) -> DesktopBridgeConversationRecord {
        DesktopBridgeConversationRecord {
            id: "bridge:host:kd_remote".to_string(),
            host_id: "host".to_string(),
            peer_node_id: "kd_remote".to_string(),
            peer_display_name: Some("Remote Kordi".to_string()),
            peer_owner_name: Some("Remote".to_string()),
            peer_runtime: peer_runtime.to_string(),
            project_id: None,
            project_name: None,
            unread_count: 0,
            updated_at_ms: 2,
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            outreach: Some(test_outreach("session:bridge:humans:parent")),
            identity: Some(DesktopBridgeIdentitySnapshot {
                bridge_host_id: "host".to_string(),
                local_human_id: "kh_local".to_string(),
                local_human_name: "Local".to_string(),
                local_agent_id: Some("ka_local".to_string()),
                local_agent_name: Some("Local Kordi".to_string()),
                local_agent_node_id: Some("kd_local".to_string()),
                remote_human_id: Some("kh_remote".to_string()),
                remote_human_name: Some("Remote".to_string()),
                remote_human_node_id: Some("kd_remote".to_string()),
                remote_agent_id: Some("ka_remote".to_string()),
                remote_agent_name: Some("Remote Kordi".to_string()),
                remote_agent_node_id: Some("kd_remote".to_string()),
                remote_agent_runtime: Some("kordi-desktop".to_string()),
            }),
            messages: Vec::new(),
        }
    }

    #[test]
    fn agent_conversation_outreach_parent_does_not_become_canonical_session_id() {
        let record = test_record("kordi-desktop");
        assert_eq!(
            canonical_session_id_for_record(&record),
            crate::canonical_sessions::canonical_bridge_session_id(&record.id)
        );
        assert_ne!(
            canonical_session_id_for_record(&record),
            "session:bridge:humans:parent"
        );
    }

    #[test]
    fn person_conversation_uses_stable_human_pair_session_id() {
        let mut record = test_record("person");
        record.id = "bridge:host:kd_remote:person".to_string();
        let session_id = canonical_session_id_for_record(&record);
        assert!(session_id.starts_with("session:bridge:humans:"));
        assert_ne!(session_id, "session:bridge:humans:parent");
    }

    #[test]
    fn agent_conversation_cancelled_request_is_not_awaiting_reply() {
        let mut record = test_record("kordi-desktop");
        record
            .messages
            .push(DesktopBridgeConversationMessageRecord {
                id: "bridge_msg_cancelled".to_string(),
                direction: BRIDGE_MESSAGE_DIRECTION_OUTBOUND.to_string(),
                sender: Some("Local".to_string()),
                text: "test test".to_string(),
                timestamp_ms: 1,
                request_id: Some("bridge_req_cancelled".to_string()),
                delivery_state: Some("cancelled".to_string()),
                outreach: None,
                attachments: Vec::new(),
            });

        let state = build_conversation_state(&record);

        assert!(!state.awaiting_reply);
    }
}

pub(super) fn build_conversation_state(
    record: &DesktopBridgeConversationRecord,
) -> DesktopBridgeConversation {
    let messages: Vec<DesktopBridgeConversationMessage> = record
        .messages
        .iter()
        .map(|message| DesktopBridgeConversationMessage {
            id: message.id.clone(),
            direction: message.direction.clone(),
            sender: message.sender.clone(),
            text: message.text.clone(),
            time_label: format_time_label(message.timestamp_ms),
            timestamp_ms: message.timestamp_ms,
            request_id: message.request_id.clone(),
            delivery_state: message.delivery_state.clone(),
            outreach: message.outreach.clone(),
            attachments: message.attachments.clone(),
        })
        .collect();
    let subtitle = messages
        .last()
        .map(|message| message.text.clone())
        .unwrap_or_default();
    let awaiting_reply = is_agent_like_runtime(&record.peer_runtime)
        && record
            .messages
            .iter()
            .rev()
            .find(|message| message.direction == BRIDGE_MESSAGE_DIRECTION_OUTBOUND)
            .and_then(|message| message.delivery_state.clone())
            .map(|state| !is_terminal_agent_request_delivery_state(&state))
            .unwrap_or(false);
    let peer_typing = record
        .peer_last_typing_at_ms
        .map(|timestamp| now_ms().saturating_sub(timestamp) <= PEER_TYPING_WINDOW_MS)
        .unwrap_or(false);
    let peer_last_heartbeat_label = record
        .peer_last_heartbeat_at_ms
        .map(format_time_label_with_seconds);
    DesktopBridgeConversation {
        id: record.id.clone(),
        canonical_session_id: canonical_session_id_for_record(record),
        host_id: record.host_id.clone(),
        peer_node_id: record.peer_node_id.clone(),
        peer_display_name: record.peer_display_name.clone(),
        peer_owner_name: record.peer_owner_name.clone(),
        peer_runtime: record.peer_runtime.clone(),
        project_id: record.project_id.clone(),
        project_name: record.project_name.clone(),
        title: conversation_title(record),
        subtitle,
        unread_count: record.unread_count,
        updated_at_ms: record.updated_at_ms,
        updated_at_label: format_time_label(record.updated_at_ms),
        awaiting_reply,
        peer_typing,
        peer_last_heartbeat_label,
        outreach: record.outreach.clone(),
        identity: record.identity.clone(),
        messages,
    }
}
