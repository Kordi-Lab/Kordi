const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
const CLOUD_AGENT_CANCEL_PREFIX: &str = "kordi-cloud-agent-cancel:";
const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";

#[derive(Debug, Clone, Copy)]
pub struct CloudAgentPeerMessage<'a> {
    pub from_account_id: &'a str,
    pub body: &'a str,
}

#[derive(Debug, Clone)]
pub struct CloudAgentFallbackCandidate<'a> {
    pub owner_display_name: Option<&'a str>,
    pub owner_account_id: &'a str,
    pub request_body: &'a str,
    pub request_message_id: &'a str,
    pub peer_messages: Vec<CloudAgentPeerMessage<'a>>,
}

pub fn normalized_agent_mention(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn owner_agent_keys(owner_name: &str) -> Vec<String> {
    let normalized_owner = normalized_agent_mention(
        &owner_name
            .replace("'s Kordi", "")
            .replace(" Kordi", "")
            .replace("Kordi", ""),
    );
    if normalized_owner.is_empty() {
        return Vec::new();
    }
    vec![
        format!("{normalized_owner}kordi"),
        format!("{normalized_owner}skordi"),
    ]
}

fn mention_tokens(text: &str) -> Vec<String> {
    let chars = text.char_indices().collect::<Vec<_>>();
    let mut out = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if ch != '@' {
            index += 1;
            continue;
        }
        let mut end = text.len();
        let mut next_index = index + 1;
        while next_index < chars.len() {
            let (candidate_byte, candidate) = chars[next_index];
            if candidate.is_whitespace()
                || candidate == ','
                || candidate == ':'
                || candidate == ';'
                || candidate == '!'
                || candidate == '?'
            {
                end = candidate_byte;
                break;
            }
            next_index += 1;
        }
        if end > byte_index + 1 {
            out.push(text[byte_index + 1..end].to_string());
        }
        index = next_index;
    }
    out
}

pub fn message_mentions_named_agent(text: &str, owner_name: &str) -> bool {
    let keys = owner_agent_keys(owner_name);
    if keys.is_empty() {
        return false;
    }
    mention_tokens(text).into_iter().any(|token| {
        let normalized = normalized_agent_mention(&token);
        if keys.iter().any(|key| key == &normalized) {
            return true;
        }
        let mut parts = text.split('@');
        let _before = parts.next();
        parts.any(|part| {
            let normalized_part = normalized_agent_mention(part);
            keys.iter().any(|key| normalized_part.starts_with(key))
        })
    })
}

pub fn encode_cloud_agent_response(request_id: &str, text: &str, delivery_state: &str) -> String {
    let envelope = serde_json::json!({
        "kind": "agent-response",
        "requestId": request_id,
        "text": text,
        "deliveryState": delivery_state,
    });
    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        serde_json::to_vec(&envelope).unwrap_or_default(),
    );
    format!("{CLOUD_AGENT_RESPONSE_PREFIX}{encoded}")
}

pub fn is_cloud_agent_response_body(body: &str) -> bool {
    body.starts_with(CLOUD_AGENT_RESPONSE_PREFIX)
}

fn cloud_agent_response_request_id(body: &str) -> Option<String> {
    let encoded = body.strip_prefix(CLOUD_AGENT_RESPONSE_PREFIX)?;
    let decoded = base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        encoded,
    )
    .ok()?;
    let envelope = serde_json::from_slice::<serde_json::Value>(&decoded).ok()?;
    if envelope.get("kind").and_then(|kind| kind.as_str()) != Some("agent-response") {
        return None;
    }
    envelope
        .get("requestId")
        .and_then(|request_id| request_id.as_str())
        .map(str::to_string)
}

pub fn is_cloud_agent_control_body(body: &str) -> bool {
    body.starts_with(CLOUD_AGENT_RESPONSE_PREFIX)
        || body.starts_with(CLOUD_AGENT_CANCEL_PREFIX)
        || body.starts_with(CLOUD_GROUP_PREFIX)
        || serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| {
                value
                    .get("kind")
                    .and_then(|kind| kind.as_str())
                    .map(str::to_string)
            })
            .is_some_and(|kind| kind == "group-message")
}

pub fn should_start_direct_fallback(candidate: &CloudAgentFallbackCandidate<'_>) -> bool {
    if candidate.owner_account_id.trim().is_empty()
        || candidate.request_message_id.trim().is_empty()
    {
        return false;
    }
    if is_cloud_agent_control_body(candidate.request_body) {
        return false;
    }
    let Some(owner_display_name) = candidate
        .owner_display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    if !message_mentions_named_agent(candidate.request_body, owner_display_name) {
        return false;
    }
    !candidate.peer_messages.iter().any(|message| {
        message.from_account_id == candidate.owner_account_id
            && cloud_agent_response_request_id(message.body)
                .as_deref()
                .is_some_and(|request_id| request_id == candidate.request_message_id)
    })
}

pub fn local_execution_paused_message(owner_display_name: Option<&str>) -> String {
    let owner = owner_display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("the owner");
    format!(
        "I can answer read-only questions from the server, but local execution is paused until {owner} reconnects."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn decode_cloud_agent_response_for_tests(body: &str) -> serde_json::Value {
        let encoded = body.trim_start_matches(CLOUD_AGENT_RESPONSE_PREFIX);
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap();
        serde_json::from_slice(&decoded).unwrap()
    }

    #[test]
    fn named_owner_mention_targets_remote_agent() {
        assert!(message_mentions_named_agent(
            "can @Alice Kordi summarize this?",
            "Alice"
        ));
        assert!(message_mentions_named_agent(
            "can @Alice's Kordi summarize this?",
            "Alice"
        ));
        assert!(message_mentions_named_agent(
            "can @alice.kordi summarize this?",
            "Alice"
        ));
    }

    #[test]
    fn first_person_mentions_do_not_target_remote_owner() {
        assert!(!message_mentions_named_agent(
            "@my kordi summarize this",
            "Alice"
        ));
        assert!(!message_mentions_named_agent(
            "@kordi summarize this",
            "Alice"
        ));
    }

    #[test]
    fn existing_agent_response_suppresses_duplicate_fallback() {
        let response = encode_cloud_agent_response("msg_request", "already handled", "failed");
        let request = CloudAgentFallbackCandidate {
            owner_display_name: Some("Alice"),
            request_body: "@Alice Kordi summarize this",
            request_message_id: "msg_request",
            peer_messages: vec![CloudAgentPeerMessage {
                from_account_id: "acct_alice",
                body: &response,
            }],
            owner_account_id: "acct_alice",
        };

        assert!(!should_start_direct_fallback(&request));
    }

    #[test]
    fn previous_agent_response_for_different_request_does_not_suppress_new_fallback() {
        let old_response = encode_cloud_agent_response("msg_old_request", "old answer", "complete");
        let request = CloudAgentFallbackCandidate {
            owner_display_name: Some("Alice"),
            request_body: "@Alice Kordi are you still there?",
            request_message_id: "msg_new_request",
            peer_messages: vec![CloudAgentPeerMessage {
                from_account_id: "acct_alice",
                body: &old_response,
            }],
            owner_account_id: "acct_alice",
        };

        assert!(should_start_direct_fallback(&request));
    }

    #[test]
    fn encodes_agent_response_envelope_for_fallback_reply() {
        let body =
            encode_cloud_agent_response("msg_request", "local execution is paused", "failed");
        assert!(body.starts_with("kordi-cloud-agent-response:"));
        let envelope = decode_cloud_agent_response_for_tests(&body);
        assert_eq!(envelope["kind"], "agent-response");
        assert_eq!(envelope["requestId"], "msg_request");
        assert_eq!(envelope["text"], "local execution is paused");
        assert_eq!(envelope["deliveryState"], "failed");
    }

    #[test]
    fn group_control_payload_is_not_direct_fallback_request() {
        let request = CloudAgentFallbackCandidate {
            owner_display_name: Some("Alice"),
            request_body: r#"{"kind":"group-message","message":{"text":"@Alice Kordi"}}"#,
            request_message_id: "msg_request",
            peer_messages: vec![],
            owner_account_id: "acct_alice",
        };

        assert!(!should_start_direct_fallback(&request));
    }
}
