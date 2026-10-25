//! Request bodies per Claude model for off, minimal, medium, max and default.
//! Each expectation is what OMP sends, except the differences documented in
//! `capabilities.rs`.

use serde_json::{Value, json};

use crate::anthropic::build_anthropic_request_body;
use crate::{CompletionRequest, ProviderAuthMode};

const BASE_MAX_TOKENS: u32 = 16_384;

fn request_body(model: &str, thinking: Option<&str>) -> Value {
    let request = CompletionRequest {
        system_prompt: "Be precise".to_string(),
        messages: vec![json!({"role": "user", "content": "hello"})],
        tools: Vec::new(),
        extra_tool_schemas: Vec::new(),
        model: model.to_string(),
        max_tokens: Some(BASE_MAX_TOKENS),
        stream: true,
        thinking: thinking.map(ToString::to_string),
    };
    build_anthropic_request_body(
        &request,
        ProviderAuthMode::ApiKey,
        request.messages.clone(),
        Vec::new(),
    )
}

/// The thinking, `output_config` and `max_tokens` fields of a request body.
fn fields(model: &str, thinking: Option<&str>) -> (Value, Value, Value) {
    let body = request_body(model, thinking);
    (
        body.get("thinking").cloned().unwrap_or(Value::Null),
        body.get("output_config").cloned().unwrap_or(Value::Null),
        body["max_tokens"].clone(),
    )
}

fn adaptive(display: bool, effort: &str) -> (Value, Value, Value) {
    let thinking = if display {
        json!({"type": "adaptive", "display": "summarized"})
    } else {
        json!({"type": "adaptive"})
    };
    (thinking, json!({"effort": effort}), json!(BASE_MAX_TOKENS))
}

fn budget(tokens: u32, max_tokens: u32, effort: Option<&str>) -> (Value, Value, Value) {
    (
        json!({"type": "enabled", "budget_tokens": tokens, "display": "summarized"}),
        effort.map_or(Value::Null, |effort| json!({"effort": effort})),
        json!(max_tokens),
    )
}

fn only_thinking(thinking: Value) -> (Value, Value, Value) {
    (thinking, Value::Null, json!(BASE_MAX_TOKENS))
}

fn none() -> (Value, Value, Value) {
    (Value::Null, Value::Null, json!(BASE_MAX_TOKENS))
}

/// Expected fields at off, minimal, medium and max; default always sends none.
type Row = (&'static [&'static str], [(Value, Value, Value); 4]);

fn rows() -> Vec<Row> {
    let disabled = || only_thinking(json!({"type": "disabled"}));
    vec![
        (
            &["claude-sonnet-5-5"],
            [
                // Exactly `{type: "between_tools"}`: no display, no effort.
                only_thinking(json!({"type": "between_tools"})),
                adaptive(true, "low"),
                adaptive(true, "medium"),
                adaptive(true, "max"),
            ],
        ),
        (
            &["claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"],
            [
                (
                    Value::Null,
                    json!({"effort": "low"}),
                    json!(BASE_MAX_TOKENS),
                ),
                adaptive(true, "low"),
                adaptive(true, "medium"),
                adaptive(true, "max"),
            ],
        ),
        (
            &[
                "claude-haiku-5-5",
                "claude-opus-4-7",
                "claude-opus-4-8",
                "claude-opus-5",
                "claude-sonnet-5",
            ],
            [
                disabled(),
                adaptive(true, "low"),
                adaptive(true, "medium"),
                adaptive(true, "max"),
            ],
        ),
        (
            // No `display`, which these models reject; they summarize by default.
            &["claude-opus-4-6", "claude-sonnet-4-6"],
            [
                disabled(),
                adaptive(false, "low"),
                adaptive(false, "medium"),
                adaptive(false, "max"),
            ],
        ),
        (
            &[
                "claude-haiku-4-5",
                "claude-haiku-4-5-20251001",
                "claude-sonnet-4-5",
                "claude-sonnet-4-5-20250929",
            ],
            [
                disabled(),
                budget(1_024, BASE_MAX_TOKENS, None),
                budget(8_192, BASE_MAX_TOKENS, None),
                budget(32_768, 36_864, None),
            ],
        ),
        (
            // A 32K output ceiling bounds the xhigh budget.
            &["claude-opus-4-1", "claude-opus-4-1-20250805"],
            [
                disabled(),
                budget(1_024, BASE_MAX_TOKENS, None),
                budget(8_192, BASE_MAX_TOKENS, None),
                budget(28_000, 32_000, None),
            ],
        ),
        (
            // Budget plus effort, with effort capped at high.
            &["claude-opus-4-5", "claude-opus-4-5-20251101"],
            [
                disabled(),
                budget(1_024, BASE_MAX_TOKENS, Some("low")),
                budget(8_192, BASE_MAX_TOKENS, Some("medium")),
                budget(32_768, 36_864, Some("high")),
            ],
        ),
    ]
}

#[test]
fn every_claude_model_sends_the_omp_matching_body_at_each_level() {
    let mut covered = Vec::new();
    for (models, expected) in rows() {
        for model in models {
            for (level, expected) in ["off", "minimal", "medium", "max"].iter().zip(&expected) {
                assert_eq!(&fields(model, Some(level)), expected, "{model} {level}");
            }
            for default in [Some("default"), Some("auto"), None] {
                assert_eq!(fields(model, default), none(), "{model} {default:?}");
            }
            covered.push(*model);
        }
    }
    covered.sort_unstable();
    let mut known = super::super::capabilities::ANTHROPIC_SUBSCRIPTION_MODEL_IDS.to_vec();
    known.sort_unstable();
    assert_eq!(covered, known, "every known Claude model has a row");
}

#[test]
fn between_tools_never_carries_display_or_a_high_effort() {
    let body = request_body("claude-sonnet-5-5", Some("off"));
    assert_eq!(body["thinking"], json!({"type": "between_tools"}));
    assert!(body.get("output_config").is_none());
    for level in ["low", "high", "xhigh", "max"] {
        let body = request_body("claude-sonnet-5-5", Some(level));
        assert_eq!(body["thinking"]["type"], "adaptive", "{level}");
        assert_eq!(body["output_config"]["effort"], level, "{level}");
    }
}

#[test]
fn opus_5_5_off_lowers_effort_and_never_disables_thinking() {
    let body = request_body("claude-opus-5-5", Some("off"));
    assert!(body.get("thinking").is_none());
    assert_eq!(body["output_config"], json!({"effort": "low"}));
    assert!(!body.to_string().contains("budget_tokens"));
    assert!(!body.to_string().contains("disabled"));
}

#[test]
fn unknown_models_keep_conservative_budget_thinking() {
    assert_eq!(fields("claude-unknown-live-id", Some("off")), none());
    assert_eq!(
        fields("claude-unknown-live-id", Some("xhigh")),
        (
            json!({"type": "enabled", "budget_tokens": 16_384}),
            Value::Null,
            json!(20_480)
        )
    );
}
