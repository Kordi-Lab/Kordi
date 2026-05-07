use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, Connection};

pub(super) fn canonical_bridge_message_status(delivery_state: Option<&str>) -> String {
    match delivery_state.unwrap_or("sent").trim() {
        "responded" => "complete".to_string(),
        "processing" => "processing".to_string(),
        "processing_failed" => "failed".to_string(),
        "cancelled" => "cancelled".to_string(),
        "read" => "read".to_string(),
        "delivered" => "delivered".to_string(),
        "sent" => "sent".to_string(),
        _ => "sent".to_string(),
    }
}

pub(super) fn bridge_delegated_request_ids(
    conn: &Connection,
    session_id: &str,
    conversation_id: &str,
) -> Result<HashSet<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT bridge_request_id
             FROM delegated_exchanges
             WHERE session_id = ?1
               AND bridge_request_id IS NOT NULL
               AND (bridge_conversation_id = ?2 OR bridge_conversation_id IS NULL)",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![session_id, conversation_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|err| err.to_string())?;
    let mut request_ids = HashSet::new();
    for row in rows {
        request_ids.insert(row.map_err(|err| err.to_string())?);
    }
    Ok(request_ids)
}

pub(super) fn valid_message_parent_session_id(
    message: &crate::bridge::DesktopBridgeConversationMessage,
) -> Option<String> {
    message
        .outreach
        .as_ref()
        .and_then(|outreach| outreach.parent_session_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn bridge_conversation_has_unrouted_direct_messages(
    conversation: &crate::bridge::DesktopBridgeConversation,
    handled_parent_session_message_ids: &HashSet<String>,
) -> bool {
    conversation.messages.iter().any(|message| {
        !handled_parent_session_message_ids.contains(&message.id)
            && valid_message_parent_session_id(message).is_none()
    })
}

fn outreach_has_model_task_tools(outreach: &crate::bridge::DesktopBridgeOutreachMetadata) -> bool {
    outreach.parent_session_messages.iter().any(|message| {
        message.tools.iter().any(|tool| {
            let name = tool
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_lowercase();
            name == "task_operator" || name == "update_plan"
        })
    })
}

fn merge_richer_message_outreach(
    current: &mut crate::bridge::DesktopBridgeOutreachMetadata,
    incoming: &crate::bridge::DesktopBridgeOutreachMetadata,
) {
    if !outreach_has_model_task_tools(current) && outreach_has_model_task_tools(incoming) {
        current.parent_session_messages = incoming.parent_session_messages.clone();
    }
}

fn should_restore_group_session_message_policy(
    message: &crate::bridge::DesktopBridgeConversationMessage,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    parent_session_id: &str,
) -> bool {
    let context_policy_is_missing = outreach
        .context_policy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none();
    if !context_policy_is_missing
        || !matches!(
            message.direction.as_str(),
            "inbound-response" | "outbound-response"
        )
    {
        return false;
    }

    let has_parent_message = outreach
        .parent_message_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    has_parent_message
        && (outreach
            .parent_session_kind
            .as_deref()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
            || outreach
                .parent_group_space_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
            || parent_session_id.starts_with("session:group:"))
}

pub(super) fn message_scoped_outreach_groups(
    conversation: &crate::bridge::DesktopBridgeConversation,
) -> Vec<(
    crate::bridge::DesktopBridgeOutreachMetadata,
    Vec<crate::bridge::DesktopBridgeConversationMessage>,
)> {
    let mut groups = BTreeMap::<
        String,
        (
            crate::bridge::DesktopBridgeOutreachMetadata,
            Vec<crate::bridge::DesktopBridgeConversationMessage>,
        ),
    >::new();
    let mut request_group_keys = BTreeMap::<String, String>::new();

    for message in &conversation.messages {
        let Some(mut outreach) = message.outreach.clone() else {
            continue;
        };
        let Some(parent_session_id) = outreach
            .parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
        else {
            continue;
        };
        outreach.parent_session_id = Some(parent_session_id.clone());
        if should_restore_group_session_message_policy(message, &outreach, &parent_session_id) {
            outreach.context_policy = Some("session-message".to_string());
        }
        if outreach.bridge_conversation_id.is_none() {
            outreach.bridge_conversation_id = Some(conversation.id.clone());
        }
        if outreach.bridge_request_id.is_none() {
            outreach.bridge_request_id = message.request_id.clone();
        }
        let request_key = outreach
            .bridge_request_id
            .as_deref()
            .or(message.request_id.as_deref())
            .or(outreach.parent_turn_id.as_deref())
            .or(outreach.parent_message_id.as_deref())
            .unwrap_or(message.id.as_str());
        let key = format!(
            "{}|{}|{}|{}",
            parent_session_id,
            outreach
                .context_policy
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or_default(),
            outreach.target_kind.trim(),
            request_key
        );
        if let Some(request_id) = outreach
            .bridge_request_id
            .as_deref()
            .or(message.request_id.as_deref())
        {
            request_group_keys.insert(request_id.to_string(), key.clone());
        }
        groups
            .entry(key)
            .and_modify(|(current_outreach, messages)| {
                if current_outreach.bridge_request_id.is_none() {
                    current_outreach.bridge_request_id = outreach.bridge_request_id.clone();
                }
                merge_richer_message_outreach(current_outreach, &outreach);
                if !messages.iter().any(|existing| existing.id == message.id) {
                    messages.push(message.clone());
                }
            })
            .or_insert_with(|| (outreach, vec![message.clone()]));
    }

    for message in conversation
        .messages
        .iter()
        .filter(|message| message.outreach.is_none())
    {
        let Some(group_key) = message
            .request_id
            .as_deref()
            .and_then(|request_id| request_group_keys.get(request_id))
            .cloned()
        else {
            continue;
        };
        if let Some((_outreach, messages)) = groups.get_mut(&group_key) {
            if !messages.iter().any(|existing| existing.id == message.id) {
                messages.push(message.clone());
            }
        }
    }

    groups
        .into_values()
        .map(|(outreach, mut messages)| {
            messages.sort_by(|left, right| {
                left.timestamp_ms
                    .cmp(&right.timestamp_ms)
                    .then_with(|| left.id.cmp(&right.id))
            });
            (outreach, messages)
        })
        .collect()
}

pub(super) fn outreach_status_to_exchange_status(status: &str) -> String {
    match status.trim() {
        "completed" | "complete" => "complete".to_string(),
        "failed" => "failed".to_string(),
        "cancelled" => "cancelled".to_string(),
        "timeout" => "timeout".to_string(),
        "awaitingReply" | "sending" | "processing" => "processing".to_string(),
        _ => "pending".to_string(),
    }
}

pub(super) fn outreach_context_policy_is(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    expected: &str,
) -> bool {
    outreach
        .context_policy
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

pub(super) fn outreach_is_session_relay(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach_context_policy_is(outreach, "session-relay")
}

pub(super) fn outreach_is_session_message(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach_context_policy_is(outreach, "session-message")
}

pub(super) fn outreach_is_session_invite(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach_context_policy_is(outreach, "session-invite")
}

pub(super) fn outreach_is_session_title_update(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach_context_policy_is(outreach, "session-title-update")
}

pub(super) fn outreach_is_session_update(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach_context_policy_is(outreach, "session-update")
        || outreach_is_session_title_update(outreach)
}

pub(super) fn outreach_presence_status(status: &str, peer_is_agent: bool) -> String {
    match status {
        "sending" | "awaitingReply" => "replying".to_string(),
        "failed" => "error".to_string(),
        _ if peer_is_agent => "available".to_string(),
        _ => "online".to_string(),
    }
}
