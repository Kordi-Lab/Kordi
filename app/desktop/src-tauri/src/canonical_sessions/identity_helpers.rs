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

fn is_self_reference_name(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("me") || value.trim().eq_ignore_ascii_case("you")
}

pub(crate) fn sanitize_remote_peer_display_name(display_name: &str, fallback: &str) -> String {
    let trimmed = display_name.trim();
    if !trimmed.is_empty() && !is_self_reference_name(trimmed) {
        return trimmed.to_string();
    }
    let fallback_trimmed = fallback.trim();
    if !fallback_trimmed.is_empty() {
        return fallback_trimmed.to_string();
    }
    "Bridge user".to_string()
}

fn has_third_person_possessive_scope(value: &str) -> bool {
    let trimmed = value.trim();
    let Some(possessive_index) = trimmed.find("'s ").or_else(|| trimmed.find("’s ")) else {
        return false;
    };
    let owner = trimmed[..possessive_index].trim();
    !owner.is_empty() && !is_self_reference_name(owner)
}

pub(crate) fn shared_agent_display_name(
    conn: &Connection,
    identity_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT agent.display_name, owner.display_name
         FROM identities agent
         LEFT JOIN identities owner ON owner.id = agent.owner_identity_id
         WHERE agent.id = ?1 AND agent.kind = 'agent'",
        params![identity_id],
        |row| {
            let agent_name: String = row.get(0)?;
            let owner_name: Option<String> = row.get(1)?;
            Ok(owner_name
                .map(|owner| {
                    let prefix = format!("{}'s ", owner);
                    if agent_name.starts_with(&prefix)
                        || has_third_person_possessive_scope(&agent_name)
                    {
                        agent_name.clone()
                    } else {
                        format!("{}{}", prefix, agent_name)
                    }
                })
                .unwrap_or(agent_name))
        },
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

    for identity_id in receiver_identity_ids(request) {
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
            return format!("human:bridge-node:{node_id}");
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
        return format!("agent:bridge-node:{node_id}");
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

    #[test]
    fn sanitize_remote_peer_display_name_keeps_real_names() {
        assert_eq!(
            sanitize_remote_peer_display_name("Kordi User 2", "kh_abc"),
            "Kordi User 2",
        );
        assert_eq!(
            sanitize_remote_peer_display_name("  Alice  ", "kh_abc"),
            "Alice",
        );
    }

    #[test]
    fn sanitize_remote_peer_display_name_swaps_self_references_for_fallback() {
        assert_eq!(
            sanitize_remote_peer_display_name("Me", "kh_c04229d839ab"),
            "kh_c04229d839ab",
        );
        assert_eq!(sanitize_remote_peer_display_name("you", "kh_abc"), "kh_abc",);
        assert_eq!(sanitize_remote_peer_display_name("ME", "kh_abc"), "kh_abc",);
    }

    #[test]
    fn sanitize_remote_peer_display_name_falls_back_to_generic_when_empty() {
        assert_eq!(sanitize_remote_peer_display_name("Me", ""), "Bridge user");
        assert_eq!(sanitize_remote_peer_display_name("", ""), "Bridge user");
    }
}
