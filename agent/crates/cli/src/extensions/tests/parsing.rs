use super::*;

#[test]
fn parses_frontmatter_name_and_description() {
    let metadata =
        parse_frontmatter("---\nname: demo-skill\ndescription: Helpful skill\n---\n# Demo");
    assert_eq!(metadata.get("name"), Some(&"demo-skill".to_string()));
    assert_eq!(
        metadata.get("description"),
        Some(&"Helpful skill".to_string())
    );
}

#[tokio::test]
async fn parses_command_invocation_and_args() {
    assert_eq!(
        parse_command_invocation("/hello world"),
        Some(("hello", Some("world")))
    );
    assert_eq!(parse_command_invocation("/hello"), Some(("hello", None)));
    assert_eq!(parse_command_invocation("hello"), None);
}

#[test]
fn input_hook_action_defaults_unknown_values_to_continue() {
    assert_eq!(
        InputHookAction::from_hook_action(Some("handled")),
        InputHookAction::Handled
    );
    assert_eq!(
        InputHookAction::from_hook_action(Some("continue")),
        InputHookAction::Continue
    );
    assert_eq!(
        InputHookAction::from_hook_action(Some("other")),
        InputHookAction::Continue
    );
    assert_eq!(
        InputHookAction::from_hook_action(None),
        InputHookAction::Continue
    );
}

#[test]
fn parses_extension_menu_result_with_items() {
    let value = serde_json::json!({
        "menu": {
            "title": "Shape",
            "items": [
                { "label": "New", "detail": "Make one", "value": "new" },
                { "label": "List", "value": "list" }
            ]
        }
    });
    let outcome = parse_command_menu_result("shape", &value).expect("menu");
    match outcome {
        ExtensionCommandOutcome::Menu {
            command,
            title,
            items,
        } => {
            assert_eq!(command, "shape");
            assert_eq!(title, "Shape");
            assert_eq!(items.len(), 2);
            assert_eq!(items[0].label, "New");
            assert_eq!(items[0].detail.as_deref(), Some("Make one"));
            assert_eq!(items[0].value, "new");
            assert_eq!(items[1].label, "List");
            assert_eq!(items[1].detail, None);
            assert_eq!(items[1].value, "list");
        }
        other => panic!("expected Menu, got {other:?}"),
    }
}

#[test]
fn parses_extension_prompt_result_with_resume_token() {
    let value = serde_json::json!({
        "prompt": {
            "title": "Shape — New Agent",
            "lines": ["Give me your resources."],
            "inputLabel": "Resources",
            "inputPlaceholder": "https://...",
            "resume": "opaque-token"
        }
    });
    let outcome = parse_command_prompt_result("shape", &value).expect("prompt");
    match outcome {
        ExtensionCommandOutcome::Prompt(prompt) => {
            assert_eq!(prompt.command, "shape");
            assert_eq!(prompt.title, "Shape — New Agent");
            assert_eq!(prompt.lines, vec!["Give me your resources."]);
            assert_eq!(prompt.input_label.as_deref(), Some("Resources"));
            assert_eq!(prompt.input_placeholder.as_deref(), Some("https://..."));
            assert_eq!(prompt.resume, "opaque-token");
        }
        other => panic!("expected Prompt, got {other:?}"),
    }
}

#[test]
fn parses_dispatch_and_activate_agent_results() {
    let short_dispatch = serde_json::json!({
        "dispatch": "  build the thing  ",
        "message": "Queued"
    });
    assert_eq!(
        parse_command_dispatch_result(&short_dispatch),
        Some(ExtensionCommandOutcome::Dispatch {
            note: Some("Queued".to_string()),
            prompt: "build the thing".to_string(),
        })
    );

    let activate = serde_json::json!({
        "activate_agent": {
            "agentId": "agent-123",
            "note": "Activated"
        }
    });
    assert_eq!(
        parse_command_activate_agent_result(&activate),
        Some(ExtensionCommandOutcome::ActivateAgent {
            agent_id: "agent-123".to_string(),
            note: Some("Activated".to_string()),
        })
    );
}

#[test]
fn non_menu_result_yields_text_or_nothing() {
    assert!(parse_command_menu_result("x", &serde_json::json!({"message": "hi"})).is_none());
    assert!(parse_command_menu_result("x", &serde_json::json!({"menu": {}})).is_none());
    assert!(parse_command_menu_result("x", &serde_json::json!({"menu": {"items": []}})).is_none());
    assert_eq!(
        render_command_result(&serde_json::json!({"message": "hello"})).as_deref(),
        Some("hello")
    );
}

#[test]
fn command_outcome_into_text_formats_non_tui_fallbacks() {
    let menu_text = ExtensionCommandOutcome::Menu {
        command: "shape".to_string(),
        title: "Shape".to_string(),
        items: vec![
            ExtensionMenuItem {
                label: "New".to_string(),
                detail: Some("Create one".to_string()),
                value: "new".to_string(),
            },
            ExtensionMenuItem {
                label: "List".to_string(),
                detail: None,
                value: "list".to_string(),
            },
        ],
    }
    .into_text()
    .unwrap();
    assert!(menu_text.contains("Shape"));
    assert!(menu_text.contains("1. New — Create one"));
    assert!(menu_text.contains("2. List"));

    let dispatch_text = ExtensionCommandOutcome::Dispatch {
        note: Some("Queued".to_string()),
        prompt: "Run build".to_string(),
    }
    .into_text()
    .unwrap();
    assert_eq!(dispatch_text, "Queued\nRun build");
}

#[test]
fn plugin_tool_result_mapping_preserves_blocks_and_flags() {
    let mapped = map_tool_result(serde_json::json!({
        "content": [
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "aGVsbG8=", "mimeType": "image/png" }
        ],
        "details": { "exitCode": 0 },
        "is_error": true
    }))
    .unwrap();

    assert!(matches!(
        mapped.content.first(),
        Some(kordi_core::types::ContentBlock::Text { text }) if text == "hello"
    ));
    assert!(matches!(
        mapped.content.get(1),
        Some(kordi_core::types::ContentBlock::Image { mime_type, .. }) if mime_type == "image/png"
    ));
    assert_eq!(mapped.details, Some(serde_json::json!({ "exitCode": 0 })));
    assert!(mapped.is_error);
    assert_eq!(mapped.artifact_path, None);
}

#[test]
fn plugin_tool_result_mapping_falls_back_to_pretty_json_when_needed() {
    let mapped = map_tool_result(serde_json::json!({
        "details": { "status": "ok" },
        "unexpected": true
    }))
    .unwrap();

    assert!(matches!(
        mapped.content.first(),
        Some(kordi_core::types::ContentBlock::Text { text }) if text.contains("\"unexpected\": true")
    ));
}

#[tokio::test]
async fn empty_plugin_runtime_returns_defaults() {
    let cwd = tempdir().unwrap();
    let (tools, commands, extensions) = build_plugin_runtime(cwd.path(), false, &[]).await.unwrap();

    assert!(tools.is_empty());
    assert!(!commands.is_registered("/anything"));
    assert!(extensions.extensions.is_empty());
    assert!(extensions.registered_commands.is_empty());
    assert!(extensions.registered_tools.is_empty());
}
