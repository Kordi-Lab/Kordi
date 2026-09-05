use super::{build_responses_request_body, should_use_responses_api};
use crate::{CompletionRequest, ProviderAuthMode, RequestOptions};
use serde_json::json;
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

fn request_options(base_url: &str) -> RequestOptions {
    RequestOptions {
        provider: "openai".to_string(),
        api_key: "test-key".to_string(),
        auth_mode: ProviderAuthMode::ApiKey,
        auth_account_id: None,
        base_url: base_url.to_string(),
        headers: HashMap::new(),
        cancel: CancellationToken::new(),
        retry_callback: None,
        max_retries: 0,
        retry_base_delay_ms: 0,
        max_retry_delay_ms: 0,
    }
}

fn completion_request(model: &str) -> CompletionRequest {
    CompletionRequest {
        system_prompt: "system prompt".to_string(),
        messages: vec![],
        tools: vec![],
        extra_tool_schemas: vec![],
        model: model.to_string(),
        max_tokens: Some(1024),
        stream: true,
        thinking: Some("medium".to_string()),
    }
}

#[test]
fn uses_responses_api_for_gpt5_on_standard_openai_base() {
    let request = completion_request("gpt-5.4");
    let options = request_options("https://api.openai.com/v1");
    assert!(should_use_responses_api(&request, &options));
}

#[test]
fn does_not_use_responses_api_for_nonstandard_openai_compatible_bases() {
    let request = completion_request("gpt-5.4");
    let options = request_options("https://openrouter.ai/api/v1");
    assert!(!should_use_responses_api(&request, &options));
}

#[test]
fn gpt_6_routes_tools_and_continuations_through_responses() {
    let mut request = completion_request("gpt-6-astra");
    assert!(should_use_responses_api(
        &request,
        &request_options("https://api.openai.com/v1")
    ));
    assert!(!should_use_responses_api(
        &request,
        &request_options("https://openrouter.ai/api/v1")
    ));
    request.tools = vec![json!({"type": "function", "function": {
        "name": "read", "parameters": {"type": "object"}
    }})];
    request.thinking = Some("off".to_string());
    let body = build_responses_request_body(
        &request,
        vec![
            json!({"role": "user", "content": "Read the file"}),
            json!({"role": "assistant", "tool_calls": [{
                "id": "call_1", "function": {"name": "read", "arguments": "{}"}
            }]}),
            json!({"role": "tool", "tool_call_id": "call_1", "content": "File contents"}),
        ],
    );
    assert_eq!(body["model"], "gpt-6-astra");
    assert_eq!(body["reasoning"]["effort"], "low");
    assert_eq!(body["tools"][0]["name"], "read");
    assert_eq!(body["input"][1]["type"], "function_call");
    assert_eq!(body["input"][2]["type"], "function_call_output");
    assert_eq!(body["input"][2]["call_id"], "call_1");
    assert!(body.get("temperature").is_none());
}

#[test]
fn responses_body_prefers_hosted_web_search_over_custom_function() {
    let mut request = completion_request("gpt-5.4");
    request.tools = vec![
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

    let body = build_responses_request_body(&request, vec![]);
    let tools = body["tools"].as_array().expect("tools array");

    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0], json!({"type": "web_search"}));
    assert_eq!(tools[1]["type"], "function");
    assert_eq!(tools[1]["name"], "web_fetch");
    assert!(
        tools
            .iter()
            .all(|tool| tool.get("name") != Some(&json!("web_search")))
    );
}

#[test]
fn responses_body_converts_chat_style_tools_and_system_messages() {
    let mut request = completion_request("gpt-5.4");
    request.tools = vec![json!({
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read a file",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
        }
    })];
    let messages = vec![json!({"role": "system", "content": "be helpful"})];

    let body = build_responses_request_body(&request, messages);
    assert_eq!(body["input"][0]["role"], "system");
    assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "read");
    assert!(body["tools"][0].get("function").is_none());
    assert_eq!(body["tool_choice"], "auto");
    assert_eq!(body["parallel_tool_calls"], false);
    assert_eq!(body["reasoning"]["effort"], "medium");
    assert_eq!(body["max_output_tokens"], 1024);
    assert_eq!(body["prompt_cache_key"], "kordi:gpt-5.4");
}

#[test]
fn responses_body_omits_reasoning_for_default_thinking() {
    let mut request = completion_request("gpt-5.4");
    request.thinking = Some("default".to_string());
    let body = build_responses_request_body(&request, vec![]);
    assert!(body.get("reasoning").is_none());

    request.thinking = Some("off".to_string());
    let body = build_responses_request_body(&request, vec![]);
    assert_eq!(body["reasoning"]["effort"], "none");
}

#[test]
fn responses_body_preserves_gpt_56_max_reasoning() {
    let mut request = completion_request("gpt-5.6-terra");
    request.thinking = Some("max".to_string());
    let body = build_responses_request_body(&request, vec![]);
    assert_eq!(body["reasoning"]["effort"], "max");

    request.thinking = Some("xhigh".to_string());
    let body = build_responses_request_body(&request, vec![]);
    assert_eq!(body["reasoning"]["effort"], "xhigh");

    request.thinking = Some("minimal".to_string());
    let body = build_responses_request_body(&request, vec![]);
    assert_eq!(body["reasoning"]["effort"], "minimal");
}
