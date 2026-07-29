use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{hash_hex, OpenCanonicalSessionRequest, UpsertCanonicalIdentityRequest};

pub(crate) fn stable_session_id(request: &OpenCanonicalSessionRequest) -> String {
    let seed = [
        request.kind.trim(),
        request.created_by_identity_id.trim(),
        request
            .relationship_identity_id
            .as_deref()
            .unwrap_or_default()
            .trim(),
        request
            .primary_identity_id
            .as_deref()
            .unwrap_or_default()
            .trim(),
        request.project_id.as_deref().unwrap_or_default().trim(),
    ]
    .join("|");
    format!("session:{}", hash_hex(&seed, 16))
}

pub(crate) fn identity_display_name(
    conn: &Connection,
    identity_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT display_name FROM identities WHERE id = ?1",
        params![identity_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub(crate) fn receiver_identity_ids(request: &OpenCanonicalSessionRequest) -> Vec<String> {
    let mut receiver_ids = Vec::new();
    let mut push_receiver = |identity_id: Option<&String>| {
        let Some(identity_id) = identity_id.map(String::as_str).map(str::trim) else {
            return;
        };
        if identity_id.is_empty() || identity_id == request.created_by_identity_id.trim() {
            return;
        }
        if !receiver_ids.iter().any(|existing| existing == identity_id) {
            receiver_ids.push(identity_id.to_string());
        }
    };

    push_receiver(request.primary_identity_id.as_ref());
    push_receiver(request.relationship_identity_id.as_ref());
    for participant_id in &request.participant_identity_ids {
        push_receiver(Some(participant_id));
    }

    receiver_ids
}

pub(crate) fn default_session_title(
    conn: &Connection,
    request: &OpenCanonicalSessionRequest,
) -> Result<String, String> {
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(title.to_string());
    }
    if let Some(project_name) = request
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(project_name.to_string());
    }

    if let Some(identity_id) = receiver_identity_ids(request).into_iter().next() {
        if let Some(display_name) = identity_display_name(conn, &identity_id)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Ok(display_name);
        }
        return Ok(identity_id);
    }

    Ok("New chat".to_string())
}

pub(crate) fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn validate_identity_kind(kind: &str) -> Result<String, String> {
    let normalized = kind.trim().to_lowercase();
    if matches!(normalized.as_str(), "human" | "agent") {
        Ok(normalized)
    } else {
        Err("Identity kind must be human or agent".to_string())
    }
}

pub(crate) fn validate_session_kind(kind: &str) -> Result<String, String> {
    let normalized = kind.trim().to_lowercase();
    if matches!(
        normalized.as_str(),
        "self-agent" | "direct-person" | "direct-agent" | "relationship" | "group" | "project"
    ) {
        Ok(normalized)
    } else {
        Err("Unsupported canonical session kind".to_string())
    }
}

pub(crate) fn validate_status(value: Option<String>, fallback: &str) -> String {
    value
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

pub(crate) fn json_to_db(value: &Option<Value>) -> Result<Option<String>, String> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())
}

pub(crate) fn json_from_db(value: Option<String>) -> Option<Value> {
    value.and_then(|raw| serde_json::from_str(&raw).ok())
}

pub(crate) fn canonical_identity_id(
    request: &UpsertCanonicalIdentityRequest,
    kind: &str,
) -> String {
    if let Some(id) = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return id.to_string();
    }

    if kind == "human" {
        if let Some(human_id) = request
            .human_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("human:{human_id}");
        }
        if let Some(node_id) = request
            .bridge_node_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("human:source:{node_id}");
        }
        return format!("human:local:{}", hash_hex(&request.display_name, 8));
    }

    if let Some(agent_id) = request
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("agent:{agent_id}");
    }
    if let Some(node_id) = request
        .bridge_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("agent:source:{node_id}");
    }
    format!("agent:local:{}", hash_hex(&request.display_name, 8))
}

pub(crate) fn canonical_avatar_key(
    request: &UpsertCanonicalIdentityRequest,
    kind: &str,
    id: &str,
) -> String {
    request
        .avatar_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if kind == "human" {
                request
                    .human_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            } else {
                request
                    .agent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            }
        })
        .or_else(|| {
            request
                .bridge_node_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(id)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_optional_trims_values() {
        assert_eq!(
            clean_optional(Some("  Shuyang  ".to_string())),
            Some("Shuyang".to_string()),
        );
    }
}
