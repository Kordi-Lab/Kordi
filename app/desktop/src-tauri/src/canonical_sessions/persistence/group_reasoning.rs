use rusqlite::{params, Connection};
use serde_json::Value;

use super::super::{
    canonical_storage_root, stable_profile_id, AppendCanonicalMessageRequest,
    CanonicalSessionMessage,
};

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
            if let Some(execution) = content.get_mut("execution").and_then(Value::as_object_mut) {
                execution.remove("thinkingText");
                if let Some(steps) = execution.get_mut("steps").and_then(Value::as_array_mut) {
                    steps.retain(|step| step.get("id").and_then(Value::as_str) != Some("analysis"));
                }
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
    let previous = same_request.and_then(|message| thinking(message.content.as_ref()));
    let incoming = thinking(request.content.as_ref());
    let retained = match (previous, incoming) {
        (Some(previous), Some(incoming)) if incoming.len() >= previous.len() => incoming,
        (Some(previous), _) => previous,
        (None, Some(incoming)) => incoming,
        (None, None) => return Ok(()),
    }
    .to_string();
    let content = request.content.get_or_insert_with(|| serde_json::json!({}));
    if let Some(content) = content.as_object_mut() {
        content.insert("thinkingText".into(), Value::String(retained));
    }
    Ok(())
}
