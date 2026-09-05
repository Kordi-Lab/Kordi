use super::{
    CacheMetricsSource, CompletionRequest, ProviderAuthMode, anthropic_beta_header,
    anthropic_oauth_beta_header, apply_cache_control_to_last_user_message,
    build_anthropic_request_body, build_anthropic_tools, cache_metrics_source_for_auth_mode,
    next_sse_block_delimiter, sse_block_event_name, system_text_block,
};
use serde_json::json;

fn completion_request(model: &str, thinking: Option<&str>) -> CompletionRequest {
    CompletionRequest {
        system_prompt: "Be precise".to_string(),
        messages: vec![json!({"role": "user", "content": "hello"})],
        tools: Vec::new(),
        extra_tool_schemas: Vec::new(),
        model: model.to_string(),
        max_tokens: Some(16_384),
        stream: true,
        thinking: thinking.map(ToString::to_string),
    }
}

fn request_body(
    model: &str,
    thinking: Option<&str>,
    auth_mode: ProviderAuthMode,
) -> serde_json::Value {
    let request = completion_request(model, thinking);
    build_anthropic_request_body(&request, auth_mode, request.messages.clone(), Vec::new())
}

#[test]
fn adaptive_models_emit_summarized_thinking_and_model_correct_effort() {
    for (model, thinking, expected_effort) in [
        ("claude-opus-4-6", "xhigh", "high"),
        ("claude-opus-4-6", "max", "max"),
        ("claude-opus-4-7", "xhigh", "xhigh"),
        ("claude-opus-4-7", "max", "max"),
        ("claude-opus-4-8", "xhigh", "xhigh"),
        ("claude-opus-4-8", "max", "max"),
        ("claude-sonnet-4-6", "max", "max"),
        ("claude-sonnet-5", "xhigh", "xhigh"),
        ("claude-sonnet-5", "max", "max"),
        ("claude-fable-5", "xhigh", "xhigh"),
        ("claude-fable-5", "max", "max"),
        ("claude-fable-5-1", "xhigh", "xhigh"),
        ("claude-fable-5-1", "max", "max"),
    ] {
        let body = request_body(model, Some(thinking), ProviderAuthMode::ApiKey);
        assert_eq!(
            body["thinking"],
            json!({"type": "adaptive", "display": "summarized"}),
            "{model}/{thinking}"
        );
        assert_eq!(
            body["output_config"],
            json!({"effort": expected_effort}),
            "{model}/{thinking}"
        );
    }
}

#[test]
fn current_models_with_sampling_restrictions_never_add_temperature() {
    for model in [
        "claude-fable-5",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
    ] {
        let body = request_body(model, Some("xhigh"), ProviderAuthMode::ApiKey);
        assert!(body.get("temperature").is_none(), "{model}");
    }
}

#[test]
fn explicit_off_uses_each_models_disabled_or_omitted_contract() {
    let opus = request_body("claude-opus-4-8", Some("off"), ProviderAuthMode::ApiKey);
    assert_eq!(opus["thinking"], json!({"type": "disabled"}));
    assert!(opus.get("output_config").is_none());

    let fable = request_body("claude-fable-5", Some("off"), ProviderAuthMode::ApiKey);
    assert!(fable.get("thinking").is_none());
    assert!(fable.get("output_config").is_none());

    let unknown = request_body(
        "claude-unknown-live-id",
        Some("off"),
        ProviderAuthMode::ApiKey,
    );
    assert!(unknown.get("thinking").is_none());
    assert!(unknown.get("output_config").is_none());
}

#[test]
fn budget_and_unknown_models_keep_conservative_budget_thinking() {
    for (model, thinking) in [
        ("claude-opus-4-5", "max"),
        ("claude-unknown-live-id", "xhigh"),
    ] {
        let body = request_body(model, Some(thinking), ProviderAuthMode::ApiKey);
        assert_eq!(
            body["thinking"],
            json!({"type": "enabled", "budget_tokens": 16_384}),
            "{model}"
        );
        assert_eq!(body["max_tokens"], 20_480, "{model}");
        assert!(body.get("output_config").is_none(), "{model}");
    }
}

#[test]
fn fable_51_tool_continuation_uses_adaptive_thinking_on_both_auth_routes() {
    let messages = vec![
        json!({"role": "user", "content": "Read the file"}),
        json!({"role": "assistant", "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": {"name": "read", "arguments": "{\"path\":\"README.md\"}"}
        }]}),
        json!({"role": "tool", "tool_call_id": "call_1", "content": "File contents"}),
    ];
    for auth in [ProviderAuthMode::ApiKey, ProviderAuthMode::OAuth] {
        for thinking in [
            "off", "default", "minimal", "low", "medium", "high", "xhigh", "max",
        ] {
            let request = completion_request("claude-fable-5-1", Some(thinking));
            let body = build_anthropic_request_body(
                &request,
                auth,
                super::convert_messages_for_anthropic(&messages),
                Vec::new(),
            );
            assert_eq!(body["model"], "claude-fable-5-1");
            assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
            assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "call_1");
            assert!(body.get("tool_choice").is_none());
            assert!(body.get("temperature").is_none());
            if matches!(thinking, "off" | "default") {
                assert!(body.get("thinking").is_none());
            } else {
                assert_eq!(body["thinking"]["type"], "adaptive");
                assert!(body["thinking"].get("budget_tokens").is_none());
                assert_eq!(
                    body["output_config"]["effort"],
                    if thinking == "minimal" {
                        "low"
                    } else {
                        thinking
                    }
                );
            }
        }
    }
}

#[test]
fn oauth_identity_is_prepended_without_changing_api_key_system_blocks() {
    let oauth = request_body("claude-opus-4-8", Some("default"), ProviderAuthMode::OAuth);
    assert_eq!(
        oauth["system"][0]["text"],
        "You are Claude Code, Anthropic's official CLI for Claude."
    );
    assert_eq!(oauth["system"][1]["text"], "Be precise");

    let api_key = request_body("claude-opus-4-8", Some("default"), ProviderAuthMode::ApiKey);
    assert_eq!(api_key["system"].as_array().map(Vec::len), Some(1));
    assert_eq!(api_key["system"][0]["text"], "Be precise");
    assert!(api_key.get("thinking").is_none());
}

#[test]
fn anthropic_tools_prefer_hosted_web_search_over_custom_function() {
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
                "name": "read",
                "description": "Read a file",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
            }
        }),
    ];

    let (converted, hosted_web_search) = build_anthropic_tools(&tools, &[]);

    assert!(hosted_web_search);
    assert_eq!(converted.len(), 2);
    assert_eq!(converted[0]["type"], "web_search_20250305");
    assert_eq!(converted[0]["name"], "web_search");
    assert_eq!(converted[1]["name"], "read");
    assert_eq!(
        converted
            .iter()
            .filter(|tool| tool["name"] == "web_search")
            .count(),
        1,
    );
}

#[test]
fn anthropic_beta_headers_enable_web_search_only_when_hosted_search_is_present() {
    assert_eq!(
        anthropic_beta_header(false),
        "fine-grained-tool-streaming-2025-05-14"
    );
    assert_eq!(
        anthropic_beta_header(true),
        "fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05"
    );
    assert_eq!(
        anthropic_oauth_beta_header(true),
        "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05"
    );
}

#[test]
fn api_key_uses_official_cache_metrics_and_oauth_uses_estimates() {
    assert_eq!(
        cache_metrics_source_for_auth_mode(&ProviderAuthMode::ApiKey),
        CacheMetricsSource::Official
    );
    assert_eq!(
        cache_metrics_source_for_auth_mode(&ProviderAuthMode::OAuth),
        CacheMetricsSource::Estimated
    );
}

#[test]
fn parses_lf_and_crlf_sse_block_boundaries() {
    assert_eq!(
        next_sse_block_delimiter("event: ping\n\nrest"),
        Some((11, 2))
    );
    assert_eq!(
        next_sse_block_delimiter("event: ping\r\n\r\nrest"),
        Some((11, 4))
    );
    assert_eq!(
        sse_block_event_name("event: error\r\ndata: boom"),
        Some("error")
    );
}

#[test]
fn system_blocks_include_ephemeral_cache_control() {
    let block = system_text_block("system prompt");
    assert_eq!(block["type"], "text");
    assert_eq!(block["text"], "system prompt");
    assert_eq!(block["cache_control"], json!({ "type": "ephemeral" }));
}

#[test]
fn adds_cache_control_to_last_user_message_text_block() {
    let mut messages = vec![
        json!({"role": "assistant", "content": "previous"}),
        json!({"role": "user", "content": [{"type": "text", "text": "hello"}]}),
    ];

    apply_cache_control_to_last_user_message(&mut messages);

    assert_eq!(
        messages[1]["content"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
}

#[test]
fn converts_string_user_message_into_cacheable_text_block() {
    let mut messages = vec![json!({"role": "user", "content": "hello"})];

    apply_cache_control_to_last_user_message(&mut messages);

    assert_eq!(messages[0]["content"][0]["type"], "text");
    assert_eq!(messages[0]["content"][0]["text"], "hello");
    assert_eq!(
        messages[0]["content"][0]["cache_control"],
        json!({ "type": "ephemeral" })
    );
}
