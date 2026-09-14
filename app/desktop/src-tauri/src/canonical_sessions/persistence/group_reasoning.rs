use rusqlite::{params, Connection};
use serde_json::Value;

use super::super::{
    canonical_storage_root, stable_profile_id, AppendCanonicalMessageRequest,
    CanonicalSessionMessage,
};

fn public_tool(tool: &Value) -> bool {
    tool.get("name").and_then(Value::as_str) == Some("task_operator")
        && tool
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with("background-session:"))
}

fn thinking(content: Option<&Value>) -> Option<&str> {
    let content = content?;
    content
        .get("thinkingText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .or_else(|| {
            content
                .get("execution")?
                .get("thinkingText")?
                .as_str()
                .filter(|text| !text.trim().is_empty())
        })
}

pub(super) fn normalize(
    conn: &Connection,
    existing: Option<&CanonicalSessionMessage>,
    request: &mut AppendCanonicalMessageRequest,
) -> Result<(), String> {
    if request.message_kind != "agent-turn"
        || !request
            .source_transport
            .as_deref()
            .is_some_and(|source| source.starts_with("cloud-group-agent"))
    {
        return Ok(());
    }
    let owner: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM identities agent JOIN local_profile profile
         ON agent.owner_identity_id=profile.human_identity_id
         WHERE agent.id=?1 AND agent.kind='agent' AND profile.id=?2)",
            params![
                request.sender_identity_id,
                stable_profile_id(&canonical_storage_root())
            ],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !owner {
        // Public group records must not retain owner-only reasoning, even if
        // an old client supplied an incorrect sender-role hint.
        if let Some(content) = request.content.as_mut().and_then(Value::as_object_mut) {
            content.remove("thinkingText");
            content.remove("execution");
            if let Some(tools) = content.get_mut("tools").and_then(Value::as_array_mut) {
                tools.retain(public_tool);
            }
        }
        return Ok(());
    }
    let same_request = existing.filter(|message| {
        message.session_id == request.session_id
            && message.sender_identity_id == request.sender_identity_id
            && message.message_kind == "agent-turn"
            && message.parent_message_id.is_some()
            && message.parent_message_id == request.parent_message_id
    });
    let previous_content = same_request.and_then(|message| message.content.as_ref());
    let previous = thinking(previous_content);
    let incoming = thinking(request.content.as_ref());
    let retained = match (previous, incoming) {
        (Some(previous), Some(incoming)) if incoming.len() >= previous.len() => Some(incoming),
        (Some(previous), _) => Some(previous),
        (None, incoming) => incoming,
    }
    .map(str::to_string);
    // A public echo carries only shared task links, never the owner's tool trace.
    // Preserve that trace independently of reasoning: many turns only use tools.
    let previous_tools = previous_content
        .and_then(|content| content.get("tools"))
        .and_then(Value::as_array)
        .filter(|tools| tools.iter().any(|tool| !public_tool(tool)));
    let incoming_tools = request
        .content
        .as_ref()
        .and_then(|content| content.get("tools"))
        .and_then(Value::as_array);
    let public_or_empty = incoming_tools.is_none_or(|tools| tools.iter().all(public_tool));
    let retained_tools = previous_tools.filter(|_| public_or_empty).cloned();
    if retained.is_none() && retained_tools.is_none() {
        return Ok(());
    }
    let content = request.content.get_or_insert_with(|| serde_json::json!({}));
    if let Some(content) = content.as_object_mut() {
        if let Some(thinking) = retained {
            content.insert("thinkingText".into(), Value::String(thinking));
        }
        if let Some(tools) = retained_tools {
            content.insert("tools".into(), Value::Array(tools));
        }
    }
    Ok(())
}
