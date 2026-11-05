//! A scripted model for the deterministic layer. Each fixture pass carries the
//! replies a good model gives; placeholders in tool arguments are filled from
//! the snapshot and the previous tool result, the way a model reads them:
//!
//! - `$conversationId`, `$eventId`, `$revision`, `$option:<index>`
//! - `$member:<key>` (participant id) and `$newMessageIds`
//! - `$participants:<organizer key>` (every member, that one the organizer)

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use async_trait::async_trait;
use kordi_cloud_agent_runner::model_loop::{
    CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall, OpenAiProviderConfig,
};
use serde_json::{json, Value};

pub struct StubProvider {
    steps: Mutex<VecDeque<Value>>,
    /// Member key to (account id, display name).
    members: BTreeMap<String, (String, String)>,
    calls: Mutex<usize>,
}

impl StubProvider {
    pub fn new(steps: Vec<Value>, members: BTreeMap<String, (String, String)>) -> Self {
        Self {
            steps: Mutex::new(steps.into()),
            members,
            calls: Mutex::new(0),
        }
    }
}

/// What a step's placeholders resolve against.
struct Context {
    snapshot: Value,
    card: Value,
}

impl Context {
    fn from_messages(messages: &[Value]) -> Self {
        let snapshot = messages
            .iter()
            .find(|message| message["role"] == "user")
            .and_then(|message| message["content"].as_str())
            .and_then(|content| content.split_once("Snapshot: "))
            .and_then(|(_, json)| serde_json::from_str(json).ok())
            .unwrap_or(Value::Null);
        // The newest card the model knows: the last successful tool result,
        // else the snapshot's open card.
        let card = messages
            .iter()
            .rev()
            .filter(|message| message["role"] == "tool")
            .filter_map(|message| message["content"].as_str())
            .filter_map(|content| serde_json::from_str::<Value>(content).ok())
            .find(|value| value.get("eventId").is_some())
            .unwrap_or_else(|| snapshot["openCard"].clone());
        Self { snapshot, card }
    }
}

fn resolve(
    value: &Value,
    context: &Context,
    members: &BTreeMap<String, (String, String)>,
) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| resolve(item, context, members))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), resolve(item, context, members)))
                .collect(),
        ),
        Value::String(text) if text.starts_with('$') => placeholder(text, context, members),
        other => other.clone(),
    }
}

fn placeholder(
    text: &str,
    context: &Context,
    members: &BTreeMap<String, (String, String)>,
) -> Value {
    let (name, argument) = text[1..].split_once(':').unwrap_or((&text[1..], ""));
    match name {
        "conversationId" => context.snapshot["conversation"]["id"].clone(),
        "eventId" => context.card["eventId"].clone(),
        "revision" => context.card["revision"].clone(),
        "option" => argument
            .parse::<usize>()
            .ok()
            .and_then(|index| context.card["options"].get(index))
            .map(|option| option["id"].clone())
            .unwrap_or(Value::Null),
        "member" => members
            .get(argument)
            .map(|(account, _)| json!(account))
            .unwrap_or(Value::Null),
        "participants" => Value::Array(
            members
                .iter()
                .map(|(key, (account, name))| {
                    json!({"participantId": account, "displayName": name,
                        "organizer": key == argument})
                })
                .collect(),
        ),
        "newMessageIds" => Value::Array(
            context.snapshot["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|message| message["isNew"] == true && message["fromSystemAgent"] != true)
                .map(|message| message["messageId"].clone())
                .collect(),
        ),
        _ => json!(text),
    }
}

#[async_trait]
impl CloudModelProvider for StubProvider {
    async fn next_response(
        &self,
        _auth: &OpenAiProviderConfig,
        messages: &[Value],
        _tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let step = self.steps.lock().expect("stub steps").pop_front();
        let mut calls = self.calls.lock().expect("stub call count");
        *calls += 1;
        let Some(step) = step else {
            return Ok(ModelProviderResponse::FinalText(
                json!({"message": null, "hooksHandled": []}).to_string(),
            ));
        };
        if let Some(error) = step["error"].as_str() {
            return Err(ModelLoopError::Provider(error.to_string()));
        }
        if let Some(tool_calls) = step["toolCalls"].as_array() {
            let context = Context::from_messages(messages);
            let calls = tool_calls
                .iter()
                .enumerate()
                .map(|(index, arguments)| ModelToolCall {
                    id: format!("stub_{}_{index}", *calls),
                    name: arguments["tool"]
                        .as_str()
                        .unwrap_or(kordi_cloud_agent_runner::system_agent_tool::NAME)
                        .to_string(),
                    arguments: {
                        let mut arguments = resolve(arguments, &context, &self.members);
                        if let Some(map) = arguments.as_object_mut() {
                            map.remove("tool");
                        }
                        arguments
                    },
                })
                .collect();
            return Ok(ModelProviderResponse::ToolCalls(calls));
        }
        let text = match &step["final"] {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        Ok(ModelProviderResponse::FinalText(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_follow_the_newest_card_the_model_has_seen() {
        let snapshot = json!({
            "conversation": {"id": "conv-1"},
            "openCard": {"eventId": "plan-old", "revision": 2, "options": []},
            "messages": [
                {"messageId": "m1", "isNew": false},
                {"messageId": "m2", "isNew": true, "fromSystemAgent": false},
                {"messageId": "m3", "isNew": true, "fromSystemAgent": true},
            ],
        });
        let messages = vec![
            json!({"role": "user", "content": format!("Review this. Snapshot: {snapshot}")}),
            json!({"role": "tool", "content": json!({"eventId": "plan-new", "revision": 5,
                "options": [{"id": "opt_1"}, {"id": "opt_2"}]}).to_string()}),
            json!({"role": "tool", "content": json!({"error": "stale"}).to_string()}),
        ];
        let members = BTreeMap::from([
            (
                "maya".to_string(),
                ("acct_m".to_string(), "Maya".to_string()),
            ),
            (
                "theo".to_string(),
                ("acct_t".to_string(), "Theo".to_string()),
            ),
        ]);
        let context = Context::from_messages(&messages);
        let resolved = resolve(
            &json!({"conversationId": "$conversationId", "eventId": "$eventId",
                "revision": "$revision", "optionId": "$option:1", "confirmedBy": "$member:maya",
                "sourceMessageIds": "$newMessageIds", "participants": "$participants:theo",
                "title": "$literal"}),
            &context,
            &members,
        );
        assert_eq!(resolved["conversationId"], "conv-1");
        assert_eq!(resolved["eventId"], "plan-new");
        assert_eq!(resolved["revision"], 5);
        assert_eq!(resolved["optionId"], "opt_2");
        assert_eq!(resolved["confirmedBy"], "acct_m");
        assert_eq!(resolved["sourceMessageIds"], json!(["m2"]));
        assert_eq!(resolved["participants"][1]["organizer"], true);
        assert_eq!(resolved["title"], "$literal");
    }
}
