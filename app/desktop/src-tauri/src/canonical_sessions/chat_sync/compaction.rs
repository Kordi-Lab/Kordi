use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentResponseProjection {
    kind: String,
    request_id: String,
    text: String,
    delivery_state: Option<String>,
}

fn agent_response_projection(message: &Value) -> Option<AgentResponseProjection> {
    let body = message
        .get("content")?
        .get("blocks")?
        .as_array()?
        .iter()
        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
        .get("text")?
        .as_str()?;
    let decoded = URL_SAFE_NO_PAD
        .decode(body.strip_prefix(CLOUD_AGENT_RESPONSE_PREFIX)?)
        .ok()?;
    let response: AgentResponseProjection = serde_json::from_slice(&decoded).ok()?;
    (response.kind == "agent-response" && !response.request_id.trim().is_empty())
        .then_some(response)
}

pub(super) fn compact_agent_response_snapshots(messages: Vec<Value>) -> Vec<Value> {
    let mut selected = HashMap::<(String, String, String), (usize, bool, usize, i64)>::new();
    let mut response_keys = Vec::with_capacity(messages.len());
    for (index, message) in messages.iter().enumerate() {
        let Some(response) = agent_response_projection(message) else {
            response_keys.push(None);
            continue;
        };
        let key = (
            message
                .get("conversation_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            message
                .get("sender_account_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            response.request_id.trim().to_string(),
        );
        let terminal = response.delivery_state.as_deref() != Some("processing");
        let text_len = response.text.len();
        let sequence = message
            .get("conversation_sequence")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let replace = selected.get(&key).is_none_or(
            |(_, existing_terminal, existing_text_len, existing_sequence)| {
                (terminal && !existing_terminal)
                    || (terminal == *existing_terminal
                        && (terminal || text_len >= *existing_text_len)
                        && sequence >= *existing_sequence)
            },
        );
        if replace {
            selected.insert(key.clone(), (index, terminal, text_len, sequence));
        }
        response_keys.push(Some(key));
    }
    messages
        .into_iter()
        .enumerate()
        .filter_map(|(index, message)| {
            let keep = response_keys[index]
                .as_ref()
                .is_none_or(|key| selected.get(key).is_some_and(|value| value.0 == index));
            keep.then_some(message)
        })
        .collect()
}

pub(super) fn compact_startup_snapshots(
    messages: Vec<Value>,
    direct_conversation_ids: &HashSet<String>,
) -> Vec<Value> {
    let mut latest_by_conversation = HashMap::<String, (usize, i64)>::new();
    let mut latest_route_by_conversation = HashMap::<String, (usize, i64)>::new();
    let mut kept = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let conversation_id = message
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if direct_conversation_ids.contains(&conversation_id) {
            kept.push(index);
            continue;
        }
        let sequence = message
            .get("conversation_sequence")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        if latest_by_conversation
            .get(&conversation_id)
            .is_none_or(|(_, current)| sequence >= *current)
        {
            latest_by_conversation.insert(conversation_id.clone(), (index, sequence));
        }
        if message.get("kind").and_then(Value::as_str) == Some("agent-model-change")
            && latest_route_by_conversation
                .get(&conversation_id)
                .is_none_or(|(_, current)| sequence >= *current)
        {
            latest_route_by_conversation.insert(conversation_id, (index, sequence));
        }
    }
    kept.extend(
        latest_by_conversation
            .into_values()
            .chain(latest_route_by_conversation.into_values())
            .map(|(index, _)| index),
    );
    kept.sort_unstable();
    kept.dedup();
    let mut messages = messages.into_iter().map(Some).collect::<Vec<_>>();
    kept.into_iter()
        .filter_map(|index| messages.get_mut(index).and_then(Option::take))
        .collect()
}
