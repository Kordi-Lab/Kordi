use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;

pub(super) fn agent_id(content: &Value, kind: &str, owner: &str) -> Option<String> {
    let default_id = format!("cloud-agent:{owner}");
    for block in content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if block.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(raw) = block.get("text").and_then(Value::as_str) else {
            continue;
        };
        let Some((prefix, encoded)) = raw.split_once(':') else {
            continue;
        };
        if !matches!(prefix, "kordi-cloud-group" | "kordi-cloud-agent-response") {
            continue;
        }
        let Some(envelope) = URL_SAFE_NO_PAD
            .decode(encoded)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            continue;
        };
        if prefix == "kordi-cloud-agent-response" && envelope["kind"] == "agent-response" {
            return Some(default_id);
        }
        let message = &envelope["message"];
        if envelope["kind"] != "group-message"
            || message["senderKind"] != "agent"
            || message["senderAccountId"].as_str() != Some(owner)
        {
            continue;
        }
        return Some(
            message["senderAgentId"]
                .as_str()
                .map(str::trim)
                .filter(|id| !id.is_empty() && *id != "cloud-local-agent")
                .unwrap_or(&default_id)
                .to_string(),
        );
    }
    (kind == "assistant").then_some(default_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn source_identity_uses_the_actual_sender_not_the_mentioned_agent() {
        let message = json!({"kind":"group-message","message":{
            "senderKind":"agent","senderAccountId":"owner","senderAgentId":"cloud_agent_research",
            "targetCloudAgentId":"cloud_agent_other","senderDisplayName":"Research"
        }});
        let content = json!({"blocks":[{"type":"text","text":format!("kordi-cloud-group:{}",URL_SAFE_NO_PAD.encode(message.to_string()))}]});
        assert_eq!(
            agent_id(&content, "text", "owner").as_deref(),
            Some("cloud_agent_research")
        );
        assert_eq!(agent_id(&content, "text", "another-owner"), None);
        assert_eq!(agent_id(&json!({"blocks":[]}), "text", "owner"), None);
        assert_eq!(
            agent_id(&json!({"blocks":[]}), "assistant", "owner").as_deref(),
            Some("cloud-agent:owner")
        );
        let response = json!({"blocks":[{"type":"text","text":format!("kordi-cloud-agent-response:{}",URL_SAFE_NO_PAD.encode(r#"{"kind":"agent-response","text":"Done"}"#))}]});
        assert_eq!(
            agent_id(&response, "text", "owner").as_deref(),
            Some("cloud-agent:owner")
        );
    }
}
