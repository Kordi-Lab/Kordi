use base64::Engine;
use serde_json::Value;

use super::constants::{is_agent_like_runtime, BRIDGE_MESSAGE_TYPE_RAW};
use crate::canonical_sessions::{
    render_multi_participant_identity_context, session_exists, write_identity_context_markdown,
    IdentityContextParticipant, IdentityContextPermissions, IdentityContextRequest,
    IdentityContextRole,
};

use super::{
    default_display_name, default_owner_name, now_ms, DesktopBridgeHostConfig,
    DesktopBridgeIdentitySnapshot, DesktopBridgeMessageAttachment, DesktopBridgeOutreachMetadata,
    DesktopBridgePromptIdentity, DesktopBridgeSessionParticipant,
};

const MAX_BRIDGE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_PAYLOAD_IDENTITY_PARTICIPANTS: usize = 50;
const MAX_PAYLOAD_IDENTITY_FIELD_CHARS: usize = 240;
const PAYLOAD_FALLBACK_SELF_IDENTITY_ID: &str = "unknown:bridge-agent-target";

#[derive(Clone)]
pub(super) struct ParsedMailboxEvent {
    pub(super) from_node_id: String,
    pub(super) from_display_name: Option<String>,
    pub(super) from_owner_name: Option<String>,
    pub(super) from_runtime: Option<String>,
    pub(super) from_human_id: Option<String>,
    pub(super) from_agent_id: Option<String>,
    pub(super) message_type: String,
    pub(super) payload: Value,
    pub(super) request_id: Option<String>,
    pub(super) project_id: Option<String>,
    pub(super) sent_at_ms: Option<i64>,
}

pub(super) fn mailbox_payload_text(payload: &Value) -> String {
    payload
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| payload.get("question").and_then(|value| value.as_str()))
        .or_else(|| payload.get("topic").and_then(|value| value.as_str()))
        .or_else(|| payload.get("content").and_then(|value| value.as_str()))
        .map(ToString::to_string)
        .unwrap_or_else(|| payload.to_string())
}

fn event_parent_session_id(event: &ParsedMailboxEvent) -> Option<String> {
    event
        .payload
        .get("sessionThread")
        .and_then(|thread| thread.get("parentSessionId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn sanitize_agent_response_for_event(
    event: &ParsedMailboxEvent,
    response_text: &str,
) -> String {
    let extra_labels = [
        event.from_owner_name.clone(),
        event.from_display_name.clone(),
    ]
    .into_iter()
    .flatten()
    .map(|label| label.trim().to_string())
    .filter(|label| !label.is_empty())
    .collect::<Vec<_>>();
    crate::canonical_sessions::sanitize_shared_agent_response_text(
        event_parent_session_id(event).as_deref(),
        response_text,
        &extra_labels,
    )
    .or_else(|_| {
        crate::canonical_sessions::sanitize_shared_agent_response_text(
            None,
            response_text,
            &extra_labels,
        )
    })
    .unwrap_or_else(|_| response_text.trim().to_string())
}

fn attachment_string_field<'a>(attachment: &'a Value, key: &str) -> Option<&'a str> {
    attachment
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn mailbox_payload_attachments(
    payload: &Value,
) -> Result<Vec<DesktopBridgeMessageAttachment>, String> {
    let Some(items) = payload
        .get("attachments")
        .and_then(|value| value.as_array())
    else {
        return Ok(Vec::new());
    };

    let mut attachments = Vec::new();
    for item in items {
        let name = attachment_string_field(item, "name").unwrap_or("attachment.bin");
        let decoded = attachment_string_field(item, "dataBase64")
            .map(|data| {
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|err| format!("Invalid bridge attachment data for {name}: {err}"))
            })
            .transpose()?;
        if decoded
            .as_ref()
            .is_some_and(|data| data.len() > MAX_BRIDGE_ATTACHMENT_BYTES)
        {
            return Err(format!(
                "Bridge attachment is too large: {name} exceeds {} MB",
                MAX_BRIDGE_ATTACHMENT_BYTES / 1024 / 1024
            ));
        }
        let stored = decoded
            .as_ref()
            .map(|data| crate::chat::store_chat_attachment_bytes(name, data))
            .transpose()?;

        let kind = attachment_string_field(item, "kind")
            .map(ToString::to_string)
            .or_else(|| stored.as_ref().map(|attachment| attachment.kind.clone()))
            .unwrap_or_else(|| "file".to_string());
        let stored_name = name.to_string();
        let format_label = attachment_string_field(item, "formatLabel")
            .map(ToString::to_string)
            .or_else(|| {
                stored
                    .as_ref()
                    .and_then(|attachment| attachment.format_label.clone())
            });
        let mime_type = attachment_string_field(item, "mimeType")
            .map(ToString::to_string)
            .or_else(|| {
                stored
                    .as_ref()
                    .and_then(|attachment| attachment.mime_type.clone())
            });
        let size_bytes = item
            .get("sizeBytes")
            .and_then(|value| value.as_u64())
            .or_else(|| stored.as_ref().and_then(|attachment| attachment.size_bytes));
        let local_path = stored.map(|attachment| attachment.path);

        attachments.push(DesktopBridgeMessageAttachment {
            kind,
            name: stored_name,
            format_label,
            mime_type,
            size_bytes,
            local_path,
        });
    }

    Ok(attachments)
}

fn clean_payload_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn truncate_payload_identity_field(value: String) -> String {
    let mut chars = value.chars();
    let truncated = chars
        .by_ref()
        .take(MAX_PAYLOAD_IDENTITY_FIELD_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn clean_payload_identity_string(value: Option<&str>) -> Option<String> {
    clean_payload_string(value).map(truncate_payload_identity_field)
}

fn synthetic_identity_id(kind: &str, display_name: &str) -> String {
    let kind = clean_payload_string(Some(kind)).unwrap_or_else(|| "identity".to_string());
    let slug = display_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    truncate_payload_identity_field(format!(
        "unknown:{kind}:{}",
        if slug.is_empty() { "unnamed" } else { &slug }
    ))
}

fn prompt_identity_to_role(
    identity: DesktopBridgePromptIdentity,
    identity_id_override: Option<&str>,
) -> Option<IdentityContextRole> {
    let display_name = clean_payload_identity_string(Some(&identity.display_name))?;
    let kind = clean_payload_identity_string(Some(&identity.kind))
        .unwrap_or_else(|| "identity".to_string());
    let identity_id = identity_id_override
        .map(ToString::to_string)
        .or_else(|| {
            identity
                .identity_id
                .and_then(|value| clean_payload_identity_string(Some(&value)))
        })
        .unwrap_or_else(|| synthetic_identity_id(&kind, &display_name));
    Some(IdentityContextRole {
        identity_id,
        display_name,
        kind,
        owner_identity_id: identity
            .owner_identity_id
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        owner_display_name: identity
            .owner_display_name
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        locality: None,
    })
}

fn participant_to_identity_context(
    participant: DesktopBridgeSessionParticipant,
) -> Option<IdentityContextParticipant> {
    let display_name = clean_payload_identity_string(Some(&participant.display_name))?;
    let kind = participant
        .kind
        .and_then(|value| clean_payload_identity_string(Some(&value)))
        .or_else(|| participant.agent_id.as_ref().map(|_| "agent".to_string()))
        .or_else(|| participant.human_id.as_ref().map(|_| "human".to_string()))
        .unwrap_or_else(|| "participant".to_string());
    let identity_id = participant
        .identity_id
        .and_then(|value| clean_payload_identity_string(Some(&value)))
        .or_else(|| {
            participant.agent_id.as_ref().and_then(|id| {
                clean_payload_identity_string(Some(id))
                    .map(|id| truncate_payload_identity_field(format!("agent:{id}")))
            })
        })
        .or_else(|| {
            participant.human_id.as_ref().and_then(|id| {
                clean_payload_identity_string(Some(id))
                    .map(|id| truncate_payload_identity_field(format!("human:{id}")))
            })
        })
        .unwrap_or_else(|| synthetic_identity_id(&kind, &display_name));
    Some(IdentityContextParticipant {
        identity_id,
        display_name,
        kind,
        role: participant
            .role
            .and_then(|value| clean_payload_identity_string(Some(&value)))
            .unwrap_or_default(),
        owner_identity_id: participant
            .owner_identity_id
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        owner_display_name: participant
            .owner_display_name
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        bridge_node_id: participant
            .bridge_node_id
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        human_id: participant
            .human_id
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        agent_id: participant
            .agent_id
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        runtime: participant
            .runtime
            .and_then(|value| clean_payload_identity_string(Some(&value))),
        locality: None,
    })
}

fn payload_identity_context_request(
    thread: &Value,
    payload: &Value,
) -> Option<IdentityContextRequest> {
    let self_identity = thread
        .get("selfTarget")
        .cloned()
        .and_then(|value| serde_json::from_value::<DesktopBridgePromptIdentity>(value).ok())
        .and_then(|identity| {
            prompt_identity_to_role(identity, Some(PAYLOAD_FALLBACK_SELF_IDENTITY_ID))
        })?;
    let requester = thread
        .get("initiator")
        .cloned()
        .and_then(|value| serde_json::from_value::<DesktopBridgePromptIdentity>(value).ok())
        .and_then(|identity| prompt_identity_to_role(identity, None));
    let participants = thread
        .get("participants")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_PAYLOAD_IDENTITY_PARTICIPANTS)
                .filter_map(|item| {
                    serde_json::from_value::<DesktopBridgeSessionParticipant>(item.clone()).ok()
                })
                .filter_map(participant_to_identity_context)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let context_policy = payload
        .get("contextPolicy")
        .or_else(|| thread.get("contextPolicy"))
        .and_then(|value| value.as_str())
        .and_then(|value| clean_payload_identity_string(Some(value)))
        .unwrap_or_else(|| "request-window".to_string());

    Some(IdentityContextRequest {
        permissions: IdentityContextPermissions {
            reply_as_identity_id: self_identity.identity_id.clone(),
            allowed_targets: Vec::new(),
            reach_out_allowed: false,
            context_policy,
            requires_approval: false,
        },
        self_identity: self_identity.clone(),
        requester,
        target: Some(self_identity),
        participants,
        session_id: thread
            .get("parentSessionId")
            .and_then(|value| value.as_str())
            .and_then(|value| clean_payload_identity_string(Some(value))),
        session_kind: thread
            .get("parentSessionKind")
            .and_then(|value| value.as_str())
            .and_then(|value| clean_payload_identity_string(Some(value))),
        project_name: thread
            .get("projectName")
            .and_then(|value| value.as_str())
            .and_then(|value| clean_payload_identity_string(Some(value))),
    })
}

fn payload_identity_agent_prompt(
    identity_request: &IdentityContextRequest,
    request: &str,
    context: Option<&str>,
) -> String {
    let mut lines = vec![
        "You are the Bridge target agent for this shared Kordi request.".to_string(),
        "Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to.".to_string(),
    ];
    match write_identity_context_markdown(identity_request, None, None) {
        Ok(path) => {
            lines.push(String::new());
            lines.push(format!("Session identity file: {}", path.display()));
            lines.push("If this is your first turn in this shared session, read this file before answering. Do not read it again until a visible participant/identity event says the identity file changed.".to_string());
        }
        Err(_) => {
            lines.push(String::new());
            lines.push(render_multi_participant_identity_context(identity_request));
        }
    }
    if let Some(context) = context {
        lines.push(String::new());
        lines.push("Context supplied by requester:".to_string());
        lines.push(context.to_string());
    }
    lines.push(String::new());
    lines.push("Request:".to_string());
    lines.push(request.trim().to_string());
    lines.join("\n")
}

pub(super) fn mailbox_payload_agent_prompt_text(payload: &Value) -> String {
    let request = mailbox_payload_text(payload);
    let context = payload
        .get("contextText")
        .or_else(|| payload.get("context"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(thread) = payload.get("sessionThread") {
        let parent_session_id = thread
            .get("parentSessionId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let target_display_name = thread
            .get("targetDisplayName")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Kordi");
        let parent_session_exists = parent_session_id
            .map(|session_id| session_exists(session_id).unwrap_or(false))
            .unwrap_or(false);
        if parent_session_exists {
            if let Ok(prompt) = crate::canonical_sessions::bridge_agent_parent_session_prompt(
                parent_session_id,
                target_display_name,
                None,
                request.trim(),
                context,
            ) {
                return prompt;
            }
        }
        if let Some(identity_request) = payload_identity_context_request(thread, payload) {
            return payload_identity_agent_prompt(&identity_request, request.trim(), context);
        }
        if let Ok(prompt) = crate::canonical_sessions::bridge_agent_parent_session_prompt(
            parent_session_id,
            target_display_name,
            None,
            request.trim(),
            context,
        ) {
            return prompt;
        }
    }

    if request.trim_start().starts_with("Context:\n") {
        return request;
    }

    match context {
        Some(context) => format!("Context:\n{context}\n\nRequest:\n{}", request.trim()),
        None => request,
    }
}

fn parse_event_timestamp_ms(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
                .or_else(|| {
                    value.as_str().and_then(|text| {
                        let trimmed = text.trim();
                        trimmed.parse::<i64>().ok().or_else(|| {
                            chrono::DateTime::parse_from_rfc3339(trimmed)
                                .ok()
                                .map(|timestamp| timestamp.timestamp_millis())
                        })
                    })
                })
        })
        .filter(|value| *value > 0)
}

pub(super) fn parse_bridge_event_payload(parsed: &Value) -> Option<ParsedMailboxEvent> {
    let from_node_id = parsed
        .get("from")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if from_node_id.is_empty() {
        return None;
    }

    Some(ParsedMailboxEvent {
        from_node_id,
        from_display_name: parsed
            .get("fromDisplayName")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_owner_name: parsed
            .get("fromOwnerName")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_runtime: parsed
            .get("fromRuntime")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_human_id: parsed
            .get("fromHumanId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_agent_id: parsed
            .get("fromAgentId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        message_type: parsed
            .get("messageType")
            .and_then(|value| value.as_str())
            .unwrap_or(BRIDGE_MESSAGE_TYPE_RAW)
            .to_string(),
        payload: parsed.get("payload").cloned().unwrap_or(Value::Null),
        request_id: parsed
            .get("requestId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        project_id: parsed
            .get("projectId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        sent_at_ms: parse_event_timestamp_ms(parsed.get("sentAtMs"))
            .or_else(|| {
                parse_event_timestamp_ms(
                    parsed
                        .get("payload")
                        .and_then(|payload| payload.get("sentAtMs")),
                )
            })
            .or_else(|| parse_event_timestamp_ms(parsed.get("timestamp"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct BridgeEventsStorageGuard {
        storage_root: std::path::PathBuf,
    }

    impl BridgeEventsStorageGuard {
        fn new(test_name: &str) -> Self {
            let storage_root = std::env::temp_dir().join(format!(
                "kordi-bridge-events-{test_name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            crate::canonical_sessions::set_canonical_sessions_test_db_path(Some(
                storage_root.join("canonical-sessions.sqlite3"),
            ));
            Self { storage_root }
        }
    }

    impl Drop for BridgeEventsStorageGuard {
        fn drop(&mut self) {
            crate::canonical_sessions::set_canonical_sessions_test_db_path(None);
            let _ = std::fs::remove_dir_all(&self.storage_root);
        }
    }

    fn identity_markdown_from_prompt(prompt: &str) -> String {
        let path_line = prompt
            .lines()
            .find(|line| line.starts_with("Session identity file:"))
            .unwrap_or_else(|| panic!("missing identity file path line\n{prompt}"));
        let path = path_line
            .trim_start_matches("Session identity file:")
            .trim();
        std::fs::read_to_string(path).unwrap_or_else(|err| {
            panic!("failed to read identity Markdown file {path}: {err}\n{prompt}")
        })
    }

    #[test]
    fn payload_identity_prompt_does_not_trust_remote_self_target_identity_id() {
        let _guard = BridgeEventsStorageGuard::new("payload-only-malicious-self");
        let prompt = mailbox_payload_agent_prompt_text(&serde_json::json!({
            "message": "Help with this issue",
            "sessionThread": {
                "parentSessionId": "session:payload-only-malicious-self",
                "parentSessionKind": "group",
                "selfTarget": {
                    "identityId": "human:mallory",
                    "displayName": "Local Kordi",
                    "kind": "agent",
                    "ownerIdentityId": "human:alice",
                    "ownerDisplayName": "Alice"
                }
            }
        }));

        let markdown = identity_markdown_from_prompt(&prompt);
        assert!(markdown.contains("- replyAs: unknown:bridge-agent-target only"));
        assert!(markdown.contains("- identityId: unknown:bridge-agent-target"));
        assert!(!markdown.contains("- replyAs: human:mallory only"));
    }

    #[test]
    fn payload_identity_prompt_keeps_valid_participants_after_malformed_entries() {
        let _guard = BridgeEventsStorageGuard::new("payload-only-malformed-participants");
        let prompt = mailbox_payload_agent_prompt_text(&serde_json::json!({
            "message": "Help with this issue",
            "sessionThread": {
                "parentSessionId": "session:payload-only-malformed-participants",
                "selfTarget": {
                    "identityId": "agent:remote-claimed-self",
                    "displayName": "Local Kordi",
                    "kind": "agent"
                },
                "participants": [
                    {
                        "identityId": "agent:malformed",
                        "kind": "agent",
                        "role": "member"
                    },
                    {
                        "identityId": "agent:valid-one",
                        "displayName": "Valid Participant One",
                        "kind": "agent",
                        "role": "member"
                    },
                    {
                        "identityId": "human:valid-two",
                        "displayName": "Valid Participant Two",
                        "kind": "human",
                        "role": "requester"
                    }
                ]
            }
        }));

        let markdown = identity_markdown_from_prompt(&prompt);
        assert!(markdown.contains("Valid Participant One"));
        assert!(markdown.contains("Valid Participant Two"));
        assert!(!markdown.contains("agent:malformed"));
    }

    #[test]
    fn payload_identity_prompt_caps_remote_participants() {
        let _guard = BridgeEventsStorageGuard::new("payload-only-many-participants");
        let participants = (0..60)
            .map(|index| {
                serde_json::json!({
                    "identityId": format!("agent:p{index:02}"),
                    "displayName": format!("Remote Participant {index:02}"),
                    "kind": "agent",
                    "role": "member"
                })
            })
            .collect::<Vec<_>>();

        let prompt = mailbox_payload_agent_prompt_text(&serde_json::json!({
            "message": "Help with this issue",
            "sessionThread": {
                "parentSessionId": "session:payload-only-many-participants",
                "selfTarget": {
                    "identityId": "agent:remote-claimed-self",
                    "displayName": "Local Kordi",
                    "kind": "agent"
                },
                "participants": participants
            }
        }));

        let markdown = identity_markdown_from_prompt(&prompt);
        assert!(markdown.contains("Remote Participant 49"));
        assert!(!markdown.contains("Remote Participant 50"));
        assert!(!markdown.contains("Remote Participant 59"));
    }

    #[test]
    fn canonical_parent_prompt_ignores_malformed_payload_participants() {
        let _guard = BridgeEventsStorageGuard::new("canonical-parent-malformed-payload");
        let session_id = format!("session:bridge-parent-{}", uuid::Uuid::new_v4());

        crate::canonical_sessions::desktop_canonical_upsert_identity(
            crate::canonical_sessions::UpsertCanonicalIdentityRequest {
                id: Some("human:alice".to_string()),
                kind: "human".to_string(),
                display_name: "Alice".to_string(),
                owner_identity_id: None,
                source: Some("local".to_string()),
                source_host_id: None,
                bridge_node_id: None,
                human_id: Some("alice".to_string()),
                agent_id: None,
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("seed Alice");
        crate::canonical_sessions::desktop_canonical_upsert_identity(
            crate::canonical_sessions::UpsertCanonicalIdentityRequest {
                id: Some("agent:alice-kordi".to_string()),
                kind: "agent".to_string(),
                display_name: "Alice's Kordi".to_string(),
                owner_identity_id: Some("human:alice".to_string()),
                source: Some("local".to_string()),
                source_host_id: None,
                bridge_node_id: None,
                human_id: None,
                agent_id: Some("alice-kordi".to_string()),
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("seed Alice's Kordi");
        crate::canonical_sessions::desktop_canonical_upsert_identity(
            crate::canonical_sessions::UpsertCanonicalIdentityRequest {
                id: Some("human:bob".to_string()),
                kind: "human".to_string(),
                display_name: "Bob".to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some("bob-node".to_string()),
                human_id: Some("bob".to_string()),
                agent_id: None,
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("seed Bob");
        crate::canonical_sessions::desktop_canonical_upsert_identity(
            crate::canonical_sessions::UpsertCanonicalIdentityRequest {
                id: Some("agent:bob-kordi".to_string()),
                kind: "agent".to_string(),
                display_name: "Bob's Kordi".to_string(),
                owner_identity_id: Some("human:bob".to_string()),
                source: Some("bridge".to_string()),
                source_host_id: Some("bridge-host".to_string()),
                bridge_node_id: Some("bob-agent-node".to_string()),
                human_id: None,
                agent_id: Some("bob-kordi".to_string()),
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("seed Bob's Kordi");
        crate::canonical_sessions::desktop_canonical_open_or_create_session(
            crate::canonical_sessions::OpenCanonicalSessionRequest {
                id: Some(session_id.clone()),
                kind: "group".to_string(),
                title: Some("Alice and Bob".to_string()),
                status: Some("active".to_string()),
                created_by_identity_id: "human:alice".to_string(),
                primary_identity_id: Some("agent:alice-kordi".to_string()),
                project_id: None,
                project_name: None,
                relationship_identity_id: None,
                participant_identity_ids: vec![
                    "human:alice".to_string(),
                    "agent:alice-kordi".to_string(),
                    "human:bob".to_string(),
                    "agent:bob-kordi".to_string(),
                ],
                metadata: None,
            },
        )
        .expect("seed parent session");

        let prompt = mailbox_payload_agent_prompt_text(&serde_json::json!({
            "message": "Help with this canonical session",
            "sessionThread": {
                "parentSessionId": session_id,
                "targetDisplayName": "Bob's Kordi",
                "selfTarget": {
                    "identityId": "agent:payload-claimed-self",
                    "displayName": "Payload Kordi",
                    "kind": "agent"
                },
                "participants": [
                    {
                        "identityId": "agent:malformed-payload",
                        "kind": "agent",
                        "role": "member"
                    },
                    {
                        "identityId": "agent:payload-intruder",
                        "displayName": "Payload Intruder",
                        "kind": "agent",
                        "role": "member"
                    }
                ]
            }
        }));

        let markdown = identity_markdown_from_prompt(&prompt);
        assert!(markdown.contains("- replyAs: agent:bob-kordi only"));
        assert!(markdown.contains("- identityId: agent:bob-kordi"));
        assert!(!markdown.contains("Payload Intruder"));
        assert!(!markdown.contains("Payload Kordi"));
    }

    #[test]
    fn payload_identity_prompt_truncates_remote_scalar_fields() {
        let _guard = BridgeEventsStorageGuard::new("payload-only-huge-fields");
        let huge_display_name = "A".repeat(300);
        let expected_truncated_display_name = format!("{}…", "A".repeat(240));

        let prompt = mailbox_payload_agent_prompt_text(&serde_json::json!({
            "message": "Help with this issue",
            "sessionThread": {
                "parentSessionId": "session:payload-only-huge-fields",
                "selfTarget": {
                    "identityId": "agent:remote-claimed-self",
                    "displayName": huge_display_name,
                    "kind": "agent"
                }
            }
        }));

        let markdown = identity_markdown_from_prompt(&prompt);
        assert!(markdown.contains(&format!("- displayName: {expected_truncated_display_name}")));
        assert!(!markdown.contains(&"A".repeat(241)));
    }

    #[test]
    fn parse_bridge_event_payload_reads_sender_timestamp() {
        let event = parse_bridge_event_payload(&serde_json::json!({
            "from": "peer-node",
            "messageType": "raw",
            "requestId": "bridge_req_1",
            "sentAtMs": 1_777_000_001_234i64,
            "payload": { "message": "hello" },
        }))
        .expect("parse event");

        assert_eq!(event.sent_at_ms, Some(1_777_000_001_234));
    }

    #[test]
    fn parse_bridge_event_payload_uses_server_timestamp_as_legacy_fallback() {
        let event = parse_bridge_event_payload(&serde_json::json!({
            "from": "peer-node",
            "messageType": "raw",
            "requestId": "bridge_req_legacy",
            "timestamp": "2026-05-04T08:29:04.729656386+00:00",
            "payload": { "message": "legacy hello" },
        }))
        .expect("parse event");

        assert_eq!(event.sent_at_ms, Some(1_777_883_344_729));
    }
}

pub(super) fn sender_name_for_runtime(
    runtime: &str,
    display_name: Option<&str>,
    owner_name: Option<&str>,
    fallback: &str,
) -> String {
    if runtime.trim().eq_ignore_ascii_case("person") {
        owner_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                display_name
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| fallback.to_string())
    } else {
        display_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                owner_name
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| fallback.to_string())
    }
}

pub(super) fn identity_snapshot_for_event(
    host: &DesktopBridgeHostConfig,
    event: &ParsedMailboxEvent,
    peer_runtime: &str,
) -> DesktopBridgeIdentitySnapshot {
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let is_agent = is_agent_like_runtime(peer_runtime);
    let remote_human_name = event.from_owner_name.clone().or_else(|| {
        (!is_agent)
            .then(|| event.from_display_name.clone())
            .flatten()
    });
    let remote_agent_name = is_agent.then(|| {
        event
            .from_display_name
            .clone()
            .or_else(|| event.from_owner_name.clone())
            .unwrap_or_else(|| event.from_node_id.clone())
    });

    DesktopBridgeIdentitySnapshot {
        bridge_host_id: host.id.clone(),
        local_human_id: host
            .human_id
            .clone()
            .unwrap_or_else(|| format!("host:{}", host.id)),
        local_human_name: host.owner.clone().unwrap_or_else(default_owner_name),
        local_agent_id: active_agent.map(|agent| agent.id.clone()),
        local_agent_name: active_agent.map(|agent| agent.label.clone()),
        local_agent_node_id: active_agent.map(|agent| agent.node_id.clone()),
        remote_human_id: event.from_human_id.clone(),
        remote_human_name,
        remote_human_node_id: Some(event.from_node_id.clone()),
        remote_agent_id: is_agent.then(|| event.from_agent_id.clone()).flatten(),
        remote_agent_name,
        remote_agent_node_id: is_agent.then(|| event.from_node_id.clone()),
        remote_agent_runtime: is_agent.then(|| peer_runtime.to_string()),
    }
}

pub(super) fn outreach_metadata_for_event(
    host: &DesktopBridgeHostConfig,
    event: &ParsedMailboxEvent,
    peer_runtime: &str,
) -> Option<DesktopBridgeOutreachMetadata> {
    let thread = event.payload.get("sessionThread")?;
    let parent_session_id = thread
        .get("parentSessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let target_kind = thread
        .get("targetKind")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("bridge-agent")
        .to_string();
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let local_human_id = host
        .human_id
        .clone()
        .unwrap_or_else(|| format!("host:{}", host.id));
    let local_owner_name = host.owner.clone().unwrap_or_else(default_owner_name);
    let target_agent_id = (target_kind == "bridge-agent")
        .then(|| active_agent.map(|agent| agent.id.clone()))
        .flatten();
    let target_display_name = thread
        .get("targetDisplayName")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            if target_kind == "bridge-agent" {
                active_agent.map(|agent| agent.label.clone())
            } else {
                Some(local_owner_name.clone())
            }
        })
        .unwrap_or_else(default_display_name);
    let context_policy = event
        .payload
        .get("contextPolicy")
        .or_else(|| thread.get("contextPolicy"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let is_session_transport = context_policy.as_deref().is_some_and(|value| {
        value.eq_ignore_ascii_case("session-relay")
            || value.eq_ignore_ascii_case("session-message")
            || value.eq_ignore_ascii_case("session-invite")
            || value.eq_ignore_ascii_case("session-update")
    });
    let now = now_ms();

    Some(DesktopBridgeOutreachMetadata {
        target_kind: target_kind.clone(),
        parent_session_id: Some(parent_session_id),
        parent_session_title: thread
            .get("parentSessionTitle")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_session_kind: thread
            .get("parentSessionKind")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_group_space_id: thread
            .get("parentGroupSpaceId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_session_participants: thread
            .get("participants")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        parent_session_messages: thread
            .get("messages")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        initiator_identity: thread
            .get("initiator")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        self_target_identity: thread
            .get("selfTarget")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        permission_policy_hash: thread
            .get("permissionPolicyHash")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        participant_graph_hash: thread
            .get("participantGraphHash")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_turn_id: thread
            .get("parentTurnId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_message_id: thread
            .get("parentMessageId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        bridge_host_id: host.id.clone(),
        bridge_conversation_id: None,
        bridge_request_id: event.request_id.clone(),
        delivery_state: event
            .payload
            .get("deliveryState")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        target_node_id: host.node_id.clone(),
        target_human_id: Some(local_human_id),
        target_agent_id,
        target_display_name,
        target_owner_name: Some(local_owner_name),
        target_runtime: if target_kind == "bridge-agent" {
            active_agent.map(|agent| agent.runtime.clone())
        } else {
            Some("person".to_string())
        }
        .or_else(|| Some(peer_runtime.to_string())),
        request_text: mailbox_payload_text(&event.payload),
        trigger_text: thread
            .get("triggerText")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        context_text: event
            .payload
            .get("contextText")
            .or_else(|| event.payload.get("context"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        context_policy,
        project_id: event.project_id.clone(),
        project_name: thread
            .get("projectName")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        status: if is_session_transport {
            "completed"
        } else {
            "processing"
        }
        .to_string(),
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: is_session_transport.then_some(now),
        error: None,
    })
}
