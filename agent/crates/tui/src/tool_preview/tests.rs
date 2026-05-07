use super::{
    extract_tool_arg_string_relaxed, format_tool_call_content, format_tool_result_content,
};
use crate::tui::format_tool_call_title;
use kordi_core::types::ContentBlock;

#[test]
fn edit_results_keep_old_ui_wider_preview_limit() {
    let text = (1..=200)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let rendered = format_tool_result_content(
        "edit",
        &[ContentBlock::Text { text }],
        None,
        None,
        false,
        false,
    );
    assert!(rendered.contains("line 40"));
    assert!(rendered.contains("line 200"));
    assert!(!rendered.contains("line 100\nline 101"));
    assert!(rendered.contains("hidden"));
}

#[test]
fn grep_call_body_is_empty_because_title_shows_details() {
    let rendered = format_tool_call_content(
        "grep",
        &serde_json::json!({"pattern":"todo","path":"/tmp","glob":"*.rs"}).to_string(),
        false,
    );
    assert!(rendered.is_empty());
}

#[test]
fn bash_call_body_renders_as_fenced_code_block() {
    let rendered = format_tool_call_content(
        "bash",
        &serde_json::json!({"command":"echo hi\nprintf done","timeout": 5.0}).to_string(),
        false,
    );
    assert!(rendered.starts_with("```bash\n"));
    assert!(rendered.contains("echo hi"));
    assert!(rendered.contains("printf done"));
    assert!(rendered.ends_with("\n```") || rendered.ends_with("```"));
}

#[test]
fn bash_invalid_json_args_still_render_relaxed_fenced_command_preview() {
    let raw = "{\"command\": \"cat > /tmp/demo.py << 'PYEOF'\nprint('hi')\nPYEOF\"}";
    let rendered = format_tool_call_content("bash", raw, false);
    assert!(rendered.starts_with("```bash\n"));
    assert!(rendered.contains("cat > /tmp/demo.py << 'PYEOF'"));
    assert!(rendered.contains("print('hi')"));
    assert!(rendered.ends_with("\n```") || rendered.ends_with("```"));
}

#[test]
fn collapsed_bash_call_preview_mentions_expand_hint_when_multiline() {
    let command = (1..=12)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let rendered = format_tool_call_content(
        "bash",
        &serde_json::json!({"command": command}).to_string(),
        false,
    );
    assert!(rendered.contains("```bash"));
    assert!(rendered.contains("line 1"));
    assert!(rendered.contains("line 8"));
    assert!(!rendered.contains("line 9"));
    assert!(rendered.contains(crate::ui_hints::more_lines_expand_hint(4).as_str()));
}

#[test]
fn relaxed_arg_extraction_handles_multiline_bash_command_strings() {
    let raw = "{\"command\": \"cat > /tmp/demo.py << 'PYEOF'\nprint('hi')\nPYEOF\"}";
    let command = extract_tool_arg_string_relaxed(raw, "command").expect("command field");
    assert!(command.starts_with("cat > /tmp/demo.py << 'PYEOF'"));
    assert!(command.contains("print('hi')"));
}

#[test]
fn truncated_preview_mentions_ctrl_o_expand() {
    let text = (1..=14)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let rendered = format_tool_result_content(
        "bash",
        &[ContentBlock::Text { text }],
        None,
        None,
        false,
        false,
    );
    assert!(rendered.contains(crate::ui_hints::TOOL_EXPAND_HINT));
}

#[test]
fn bash_collapsed_preview_shows_recent_tail_lines() {
    let text = (1..=14)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let rendered = format_tool_result_content(
        "bash",
        &[ContentBlock::Text { text }],
        None,
        None,
        false,
        false,
    );
    assert!(rendered.contains("line 10"));
    assert!(rendered.contains("line 14"));
    assert!(rendered.contains("earlier lines"));
    assert!(!rendered.contains("line 9"));
}

#[test]
fn bash_preview_does_not_render_missing_exit_code_as_negative_one() {
    let rendered = format_tool_result_content(
        "bash",
        &[ContentBlock::Text { text: "ok".into() }],
        Some(serde_json::json!({ "exitCode": null })),
        None,
        false,
        false,
    );
    assert!(!rendered.contains("exit code: -1"));
    assert!(rendered.contains("ok"));
}

#[test]
fn collapsed_preview_truncates_very_long_single_line() {
    let text = format!("{} tail-marker", "x".repeat(400));
    let rendered = format_tool_result_content(
        "bash",
        &[ContentBlock::Text { text }],
        None,
        None,
        false,
        false,
    );
    assert!(rendered.contains('…'));
    assert!(!rendered.contains("tail-marker"));
}

#[test]
fn duration_line_is_separated_from_tool_body() {
    let rendered = format_tool_result_content(
        "bash",
        &[ContentBlock::Text {
            text: "line 1\nline 2".to_string(),
        }],
        Some(serde_json::json!({
            "durationMs": 12
        })),
        None,
        false,
        false,
    );
    assert!(rendered.contains("duration: 12ms\n\nline 1"));
}

#[test]
fn read_results_do_not_embed_ansi_escape_sequences() {
    let rendered = format_tool_result_content(
        "read",
        &[ContentBlock::Text {
            text: "fn main() {\n    println!(\"hi\");\n}".to_string(),
        }],
        Some(serde_json::json!({
            "path": "/tmp/demo.rs",
            "startLine": 1,
            "endLine": 3,
            "totalLines": 3
        })),
        None,
        false,
        true,
    );
    assert!(
        !rendered.contains("\x1b["),
        "read result should stay plain text, got: {rendered:?}"
    );
}

#[test]
fn web_search_results_render_with_structured_summary_and_links() {
    let rendered = format_tool_result_content(
        "web_search",
        &[ContentBlock::Text {
            text: "Web search results for query: \"Iran United States relations news today\"\nBackend: DuckDuckGo HTML\n\nSummary:\nTop developments here.\n\nLinks:\n- [Example](https://example.com)".to_string(),
        }],
        Some(serde_json::json!({
            "query": "Iran United States relations news today",
            "backend": "duckduckgo-html",
            "cacheHit": true,
            "hitCount": 2,
            "results": [
                {
                    "kind": "Text",
                    "text": "Top developments here."
                },
                {
                    "kind": "Hits",
                    "tool_use_id": "duckduckgo",
                    "content": [
                        { "title": "AP News", "url": "https://apnews.com/story" },
                        { "title": "Reuters", "url": "https://reuters.com/world" }
                    ]
                }
            ]
        })),
        None,
        false,
        false,
    );
    assert!(rendered.contains("query: \"Iran United States relations news today\""));
    assert!(rendered.contains("2 result(s) via duckduckgo-html [cached]"));
    assert!(rendered.contains("summary:"));
    assert!(rendered.contains("links:"));
    assert!(rendered.contains("- AP News — https://apnews.com/story"));
    assert!(rendered.contains("- Reuters — https://reuters.com/world"));
}

#[test]
fn task_operator_manifest_preview_renders_summary() {
    let rendered = format_tool_result_content(
        "task_operator",
        &[ContentBlock::Text {
            text: "Task manifest accepted".to_string(),
        }],
        Some(serde_json::json!({
            "manifestId": "task_manifest_123",
            "status": "accepted",
            "tasks": [
                {
                    "taskId": "inspect_tools",
                    "title": "Inspect current tool previews",
                    "summary": "Map TUI preview paths",
                    "dependencies": [],
                    "writeScope": [],
                    "risk": "read_only",
                    "estimatedInputTokens": 1000,
                    "estimatedOutputTokens": 250
                }
            ],
            "estimate": {
                "inputTokens": 1000,
                "outputTokens": 250,
                "costMicrounits": 42
            }
        })),
        None,
        false,
        false,
    );

    assert!(rendered.contains("manifest accepted: task_manifest_123"));
    assert!(rendered.contains("1 task(s)"));
    assert!(rendered.contains("- inspect_tools: Inspect current tool previews [read_only]"));
    assert!(rendered.contains("estimate: 1000 input + 250 output tokens, 42 microunits"));
}

#[test]
fn task_operator_estimate_result_renders_tokens() {
    let rendered = format_tool_result_content(
        "task_operator",
        &[],
        Some(serde_json::json!({
            "status": "estimated",
            "estimate": {
                "inputTokens": 3000,
                "outputTokens": 1200,
                "costMicrounits": 99
            }
        })),
        None,
        false,
        false,
    );

    assert!(rendered.contains("status: estimated"));
    assert!(rendered.contains("estimate: 3000 input + 1200 output tokens, 99 microunits"));
}

#[test]
fn task_operator_runtime_previews_spawn_wait_timeout_and_completion() {
    let spawn_call = serde_json::json!({
        "action": "spawn",
        "taskName": "research_docs",
        "message": "Inspect the docs and summarize the relevant files.",
        "writeScope": ["docs"]
    })
    .to_string();
    let title = format_tool_call_title("task_operator", &spawn_call);
    let call_body = format_tool_call_content("task_operator", &spawn_call, false);
    assert_eq!(title, "TaskOperator(spawn research_docs)");
    assert!(call_body.contains("spawn: research_docs"));
    assert!(call_body.contains("write scope: docs"));

    let spawn_result = format_tool_result_content(
        "task_operator",
        &[],
        Some(serde_json::json!({
            "status": "running",
            "target": "/root/research_docs",
            "message": "Task agent running: /root/research_docs",
            "tasks": []
        })),
        None,
        false,
        false,
    );
    assert!(spawn_result.contains("status: running"));
    assert!(spawn_result.contains("target: /root/research_docs"));

    let wait_timeout = format_tool_result_content(
        "task_operator",
        &[],
        Some(serde_json::json!({
            "status": "timed_out",
            "message": "No task completed before timeout",
            "tasks": []
        })),
        None,
        false,
        false,
    );
    assert!(wait_timeout.contains("status: timed_out"));
    assert!(wait_timeout.contains("No task completed before timeout"));

    let completed = format_tool_result_content(
        "task_operator",
        &[],
        Some(serde_json::json!({
            "status": "listed",
            "tasks": [
                {
                    "path": "/root/research_docs",
                    "title": "research_docs",
                    "status": "completed",
                    "summary": "Found the relevant docs.",
                    "writeScope": []
                }
            ]
        })),
        None,
        false,
        false,
    );
    assert!(completed.contains("/root/research_docs [completed]"));
    assert!(completed.contains("Found the relevant docs."));
}

#[test]
fn task_operator_policy_warning_is_visible() {
    let rendered = format_tool_result_content(
        "task_operator",
        &[],
        Some(serde_json::json!({
            "workflowPolicy": "advisory",
            "warning": "operator tool used before planning",
            "status": "timed_out",
            "message": "No task completed before timeout"
        })),
        None,
        false,
        false,
    );

    assert!(rendered.contains("workflow warning: operator tool used before planning"));
    assert!(rendered.contains("status: timed_out"));
}

#[test]
fn reflection_advisory_is_visible_on_tool_results() {
    let rendered = format_tool_result_content(
        "bash",
        &[ContentBlock::Text {
            text: "Error: command failed".to_string(),
        }],
        Some(serde_json::json!({
            "exitCode": 1,
            "reflectionAdvisory": "Consider using reflection to save a concise scoped lesson."
        })),
        None,
        true,
        false,
    );

    assert!(rendered.contains("reflection advisory:"));
    assert!(rendered.contains("concise scoped lesson"));
}

#[test]
fn reflection_preview_renders_saved_scope_and_artifact() {
    let call = serde_json::json!({
        "scope": "project",
        "scopeId": "/Users/example/kordi",
        "source": "repeated_failure",
        "lesson": "Inspect exact assertion output before editing after repeated Rust failures."
    })
    .to_string();
    let title = format_tool_call_title("reflection", &call);
    let call_body = format_tool_call_content("reflection", &call, false);
    assert!(title.starts_with("Reflection(project/repeated_failure:"));
    assert!(call_body.contains("scope: project"));
    assert!(call_body.contains("lesson:"));

    let rendered = format_tool_result_content(
        "reflection",
        &[ContentBlock::Text {
            text: "Reflection lesson saved".to_string(),
        }],
        Some(serde_json::json!({
            "status": "saved",
            "lessonId": "lesson_123",
            "scope": "project",
            "scopeId": "/Users/example/kordi",
            "artifactPath": "/Users/example/kordi/.kordi/reflection-lessons/project/kordi.md"
        })),
        Some("/Users/example/kordi/.kordi/reflection-lessons/project/kordi.md".to_string()),
        false,
        false,
    );

    assert!(rendered.contains("lesson saved"));
    assert!(rendered.contains("scope: project"));
    assert!(rendered.contains("lesson id: lesson_123"));
    assert!(
        rendered
            .contains("artifact: /Users/example/kordi/.kordi/reflection-lessons/project/kordi.md")
    );
}

#[test]
fn web_fetch_results_render_with_content_and_citation_sections() {
    let rendered = format_tool_result_content(
        "web_fetch",
        &[ContentBlock::Text {
            text: "SECURITY NOTICE\n\nSource: Web Fetch\nURL: https://tokio.rs/tokio/topics/shutdown\n\n---\nFetched body text here.\n\nCitation:\n- [Tokio Shutdown](https://tokio.rs/tokio/topics/shutdown)".to_string(),
        }],
        Some(serde_json::json!({
            "finalUrl": "https://tokio.rs/tokio/topics/shutdown",
            "title": "Tokio Shutdown",
            "contentType": "text/html",
            "extractionSource": "main",
            "truncated": false,
            "citationMarkdown": "- [Tokio Shutdown](https://tokio.rs/tokio/topics/shutdown)"
        })),
        None,
        false,
        false,
    );
    assert!(rendered.contains("title: Tokio Shutdown"));
    assert!(rendered.contains("url: https://tokio.rs/tokio/topics/shutdown"));
    assert!(rendered.contains("text/html | extraction=main"));
    assert!(rendered.contains("content:"));
    assert!(rendered.contains("Fetched body text here."));
    assert!(rendered.contains("citation:"));
    assert!(rendered.contains("- [Tokio Shutdown](https://tokio.rs/tokio/topics/shutdown)"));
}
