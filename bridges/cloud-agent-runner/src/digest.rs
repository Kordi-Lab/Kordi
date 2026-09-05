//! Read-only report agent. No sandbox is created and no mutation tool is reachable.
use crate::{
    client::{CloudAgentRun, ProviderAuthMaterial},
    model_loop::{
        CloudModelProvider, ModelLoopError, ModelProviderResponse, OpenAiProviderConfig,
        MAX_MODEL_CALLS, MAX_TOOL_CALLS,
    },
};
use serde_json::{json, Value};

pub fn tools() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{"name":"search_sessions","description":"List authorized sessions in the frozen digest input.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"additionalProperties":false}}}),
        json!({"type":"function","function":{"name":"read_session","description":"Read authorized source messages for one listed session.","parameters":{"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"],"additionalProperties":false}}}),
    ]
}
pub fn observe(input: &Value, name: &str, args: &Value) -> Value {
    let Some(sources) = input.get("sources").and_then(Value::as_array) else {
        return json!({"error":"Observation snapshot unavailable"});
    };
    match name {
        "search_sessions" => {
            let q = args
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let mut sessions = std::collections::BTreeMap::new();
            for source in sources {
                let id = source
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let title = source
                    .get("sessionTitle")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if title.to_lowercase().contains(&q) {
                    sessions.insert(id, json!({"sessionId":id,"title":title}));
                }
            }
            json!({"sessions":sessions.values().collect::<Vec<_>>()})
        }
        "read_session" => {
            let Some(id) = args.get("sessionId").and_then(Value::as_str) else {
                return json!({"error":"sessionId required"});
            };
            let messages: Vec<_> = sources
                .iter()
                .filter(|s| s.get("sessionId").and_then(Value::as_str) == Some(id))
                .collect();
            if messages.is_empty() {
                json!({"error":"Session unavailable in authorized input"})
            } else {
                json!({"sources":messages})
            }
        }
        _ => {
            json!({"error":"Tool unavailable. Only search_sessions and read_session are allowed."})
        }
    }
}
pub async fn run<P: CloudModelProvider + Sync>(
    provider: &P,
    run: &CloudAgentRun,
    material: ProviderAuthMaterial,
) -> Result<String, ModelLoopError> {
    let input: Value = serde_json::from_str(&run.prompt)
        .map_err(|_| ModelLoopError::Provider("Invalid digest observation snapshot".into()))?;
    if input.get("sources").and_then(Value::as_array).is_none() {
        return Err(ModelLoopError::Provider(
            "Session observation unavailable".into(),
        ));
    }
    let mut auth = OpenAiProviderConfig::from_material(&material)?;
    auth.apply_runtime_route(&run.runtime_route, &material.provider);
    let mut context = input.clone();
    context
        .as_object_mut()
        .ok_or(ModelLoopError::LimitExceeded)?
        .remove("sources");
    let mut messages = vec![
        json!({"role":"system","content":run.system_prompt}),
        json!({"role":"user","content":format!("Prepare the rolling digest. Discover and read the sources using your observation tools. Context: {context}")}),
    ];
    let catalog = tools();
    let mut used = 0;
    for _ in 0..MAX_MODEL_CALLS {
        match provider.next_response(&auth, &messages, &catalog).await? {
            ModelProviderResponse::FinalText(text) => return Ok(text),
            ModelProviderResponse::ToolCalls(calls) => {
                if calls.is_empty() {
                    return Err(ModelLoopError::LimitExceeded);
                }
                for call in calls {
                    used += 1;
                    if used > MAX_TOOL_CALLS {
                        return Err(ModelLoopError::LimitExceeded);
                    }
                    messages.push(json!({"role":"assistant","tool_calls":[{"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}}]}));
                    messages.push(json!({"role":"tool","tool_call_id":call.id,"name":call.name,"content":observe(&input,&call.name,&call.arguments).to_string()}));
                }
            }
        }
    }
    Err(ModelLoopError::LimitExceeded)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observations_are_confined_to_the_frozen_scope() {
        let input = json!({"sources":[{"id":"m1","sessionId":"s1","sessionTitle":"Planning","text":"A message"}]});
        assert_eq!(tools().len(), 2);
        assert!(observe(&input, "bash", &json!({"command":"read secrets"}))
            .get("error")
            .is_some());
        assert!(
            observe(&input, "read_session", &json!({"sessionId":"other"}))
                .get("error")
                .is_some()
        );
        assert_eq!(
            observe(&input, "read_session", &json!({"sessionId":"s1"}))["sources"][0]["id"],
            "m1"
        );
        assert_eq!(
            observe(&input, "search_sessions", &json!({"query":"missing"}))["sessions"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}
