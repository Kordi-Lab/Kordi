use super::request::{
    convert_messages_for_codex, convert_tools_for_codex, sanitize_messages_for_codex,
};
use serde_json::json;

#[test]
fn convert_tools_for_codex_prefers_hosted_web_search_over_custom_function() {
    let tools = vec![
        json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search with custom DuckDuckGo fallback",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch a URL",
                "parameters": {"type": "object", "properties": {"url": {"type": "string"}}}
            }
        }),
    ];

    let converted = convert_tools_for_codex(&tools);

    assert_eq!(converted.len(), 2);
    assert_eq!(converted[0], json!({"type": "web_search"}));
    assert_eq!(converted[1]["type"], "function");
    assert_eq!(converted[1]["name"], "web_fetch");
    assert!(
        converted
            .iter()
            .all(|tool| tool.get("name") != Some(&json!("web_search")))
    );
}

#[test]
fn sanitize_messages_for_codex_drops_orphan_tool_results() {
    let messages = vec![
        json!({
            "role": "assistant",
            "tool_calls": [{
                "id": "call_a|item_a",
                "type": "function",
                "function": {"name": "read", "arguments": "{}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_a|item_a",
            "content": "ok"
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_missing|item_x",
            "content": "orphan"
        }),
        json!({"role": "user", "content": "next"}),
    ];

    let sanitized = sanitize_messages_for_codex(&messages);
    assert_eq!(sanitized.len(), 3);
    assert_eq!(sanitized[1]["tool_call_id"], "call_a|item_a");
}

#[test]
fn convert_messages_for_codex_preserves_user_image_blocks() {
    let messages = vec![json!({
        "role": "user",
        "content": [
            {"type": "text", "text": "describe this"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "abcd"
                }
            }
        ]
    })];

    let converted = convert_messages_for_codex(&messages);
    assert_eq!(converted.len(), 1);
    let content = converted[0]["content"].as_array().expect("content array");
    assert_eq!(content[0]["type"], "input_text");
    assert_eq!(content[1]["type"], "input_image");
    assert_eq!(content[1]["detail"], "high");
    assert_eq!(content[1]["image_url"], "data:image/png;base64,abcd");
}

#[test]
fn convert_messages_for_codex_flattens_structured_tool_output_blocks() {
    let messages = vec![
        json!({
            "role": "assistant",
            "tool_calls": [{
                "id": "call_a|item_a",
                "type": "function",
                "function": {"name": "read", "arguments": "{}"}
            }]
        }),
        json!({
            "role": "tool",
            "tool_call_id": "call_a|item_a",
            "content": [
                {"type": "text", "text": "first line"},
                {
                    "type": "image",
                    "source": {"media_type": "image/png", "data": "abcd"}
                },
                {"type": "text", "text": "second line"}
            ]
        }),
    ];

    let converted = convert_messages_for_codex(&messages);
    assert_eq!(converted.len(), 2);
    assert_eq!(converted[1]["type"], "function_call_output");
    assert_eq!(converted[1]["call_id"], "call_a");
    assert_eq!(
        converted[1]["output"],
        "first line\n[tool returned image result: image/png]\nsecond line"
    );
}

#[test]
fn sanitize_messages_for_codex_resets_pending_tool_calls_after_user_turn() {
    let messages = vec![
        json!({
            "role": "assistant",
            "tool_calls": [{
                "id": "call_a|item_a",
                "type": "function",
                "function": {"name": "read", "arguments": "{}"}
            }]
        }),
        json!({"role": "user", "content": "continue"}),
        json!({
            "role": "tool",
            "tool_call_id": "call_a|item_a",
            "content": "stale tool output"
        }),
    ];

    let sanitized = sanitize_messages_for_codex(&messages);
    assert_eq!(sanitized.len(), 2);
    assert_eq!(sanitized[1]["role"], "user");
}
#[test]
fn runtime_identity_remains_at_the_tail_for_every_provider() {
    let mut history = vec![json!({"role":"user","content":"before"}), json!({"role":"assistant","content":"answer"})];
    let before = convert_messages_for_codex(&history);
    history.push(json!({"role":"developer","content":"Owner B; requester A"}));
    history.push(json!({"role":"user","content":"Who are you?"}));
    let after = convert_messages_for_codex(&history);
    assert_eq!(&after[..before.len()], before.as_slice());
    assert_eq!(after[2]["role"], "developer");
    let openai = crate::transforms::convert_messages_for_openai(&history);
    assert_eq!(openai[2]["role"], "developer");
    let anthropic = crate::transforms::convert_messages_for_anthropic(&history);
    assert_eq!(anthropic[2]["content"], "Owner B; requester A");
    let google = crate::google::convert_messages_google(&history);
    assert_eq!(google[2]["parts"][0]["text"], "Owner B; requester A");
    let request = crate::CompletionRequest {
        system_prompt: "Stable Agent policy".into(), messages: history[..2].to_vec(),
        tools: vec![json!({"type":"function","function":{"name":"read","parameters":{"type":"object"}}})],
        extra_tool_schemas: vec![], model: "gpt-5.4".into(), max_tokens: None, stream: true, thinking: Some("medium".into()),
    };
    let mut before = super::build_codex_request_body(&request);
    let mut after = super::build_codex_request_body(&crate::CompletionRequest { messages: history, ..request });
    let previous_input = before.as_object_mut().unwrap().remove("input").unwrap();
    let next_input = after.as_object_mut().unwrap().remove("input").unwrap();
    assert_eq!(&next_input.as_array().unwrap()[..previous_input.as_array().unwrap().len()], previous_input.as_array().unwrap().as_slice());
    assert_eq!(serde_json::to_vec(&before).unwrap(), serde_json::to_vec(&after).unwrap());
}
