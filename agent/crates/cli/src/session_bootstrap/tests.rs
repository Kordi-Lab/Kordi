//! Session bootstrap option, selection, and prompt-construction regressions.

use super::{
    SessionBootstrapOptions, prompt_label_for_cli, resolve_startup_session_id,
    resolve_thinking_level, resolve_tool_selection_for_runtime,
};
use crate::tool_registry::{ToolSelection, ToolSelectionPreference, build_tool_defs};
use async_trait::async_trait;
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::error::KordiResult;
use kordi_tools::{Tool, ToolContext, ToolResult};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct CliOverrides {
    system_prompt_template: Option<String>,
    system_prompt: Option<String>,
    append_system_prompt: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    extensions: Vec<String>,
    session: Option<String>,
    continue_session: bool,
    resume: bool,
    messages: Vec<String>,
}

fn make_cli(overrides: CliOverrides) -> crate::Cli {
    crate::Cli {
        command: None,
        cwd: None,
        provider: overrides.provider,
        model: overrides.model,
        api_key: None,
        system_prompt: overrides.system_prompt,
        append_system_prompt: overrides.append_system_prompt,
        system_prompt_template: overrides.system_prompt_template,
        list_templates: false,
        thinking: overrides.thinking,
        print: false,
        r#continue: overrides.continue_session,
        resume: overrides.resume,
        no_session: false,
        session: overrides.session,
        tools: None,
        no_tools: false,
        list_models: None,
        models: None,
        extensions: overrides.extensions,
        verbose: false,
        messages: overrides.messages,
    }
}

struct NamedTool {
    name: &'static str,
    description: &'static str,
    schema: Value,
}

#[async_trait]
impl Tool for NamedTool {
    fn name(&self) -> &str {
        self.name
    }

    fn description(&self) -> &str {
        self.description
    }

    fn parameters_schema(&self) -> Value {
        self.schema.clone()
    }

    async fn execute(
        &self,
        _params: Value,
        _ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        unreachable!("execution is not needed for bootstrap tests")
    }
}

#[test]
fn prompt_label_uses_template_name_when_present() {
    let cli = make_cli(CliOverrides {
        system_prompt_template: Some("research".to_string()),
        ..Default::default()
    });
    assert_eq!(prompt_label_for_cli(&cli), "research");
}

#[test]
fn prompt_label_uses_custom_for_explicit_system_prompt() {
    let cli = make_cli(CliOverrides {
        system_prompt: Some("custom prompt".to_string()),
        ..Default::default()
    });
    assert_eq!(prompt_label_for_cli(&cli), "custom");
}

#[test]
fn prompt_label_uses_default_append_when_only_append_prompt_is_set() {
    let cli = make_cli(CliOverrides {
        append_system_prompt: Some("appendix".to_string()),
        ..Default::default()
    });
    assert_eq!(prompt_label_for_cli(&cli), "default+append");
}

#[test]
fn session_bootstrap_options_maps_cli_values() {
    let cli = make_cli(CliOverrides {
        provider: Some("openai".to_string()),
        model: Some("gpt-test".to_string()),
        thinking: Some("high".to_string()),
        extensions: vec!["ext-a".to_string(), "ext-b".to_string()],
        session: Some("abc123".to_string()),
        continue_session: true,
        resume: true,
        messages: vec!["hello".to_string(), "world".to_string()],
        append_system_prompt: Some("appendix".to_string()),
        ..Default::default()
    });

    let options = SessionBootstrapOptions::from(&cli);
    assert_eq!(options.provider.as_deref(), Some("openai"));
    assert_eq!(options.model.as_deref(), Some("gpt-test"));
    assert_eq!(options.thinking.as_deref(), Some("high"));
    assert_eq!(options.extensions, vec!["ext-a", "ext-b"]);
    assert_eq!(options.session.as_deref(), Some("abc123"));
    assert!(options.continue_session);
    assert!(options.resume);
    assert_eq!(options.messages, vec!["hello", "world"]);
    assert_eq!(options.prompt_label, "default+append");
    assert_eq!(options.tool_selection, ToolSelectionPreference::UseSettings);
}

#[test]
fn local_openai_providers_default_to_no_tools_when_settings_do_not_opt_in() {
    assert_eq!(
        resolve_tool_selection_for_runtime(
            &ToolSelectionPreference::UseSettings,
            None,
            "lm-studio",
        ),
        ToolSelection::None
    );
    assert_eq!(
        resolve_tool_selection_for_runtime(&ToolSelectionPreference::UseSettings, None, "ollama"),
        ToolSelection::None
    );
    assert_eq!(
        resolve_tool_selection_for_runtime(&ToolSelectionPreference::UseSettings, None, "openai"),
        ToolSelection::All
    );
    assert_eq!(
        resolve_tool_selection_for_runtime(
            &ToolSelectionPreference::UseSettings,
            Some(&["read".to_string()]),
            "lm-studio",
        ),
        ToolSelection::Only(vec!["read".to_string()])
    );
    assert_eq!(
        resolve_tool_selection_for_runtime(
            &ToolSelectionPreference::Only(vec!["bash".to_string()]),
            None,
            "lm-studio",
        ),
        ToolSelection::Only(vec!["bash".to_string()])
    );
}

#[test]
fn resolve_thinking_level_prefers_requested_value() {
    assert_eq!(
        resolve_thinking_level(Some("high"), Some(ThinkingLevel::Low), Some("medium")),
        ThinkingLevel::High
    );
}

#[test]
fn resolve_thinking_level_uses_resumed_explicit_value_before_settings_default() {
    assert_eq!(
        resolve_thinking_level(None, Some(ThinkingLevel::Low), Some("high")),
        ThinkingLevel::Low
    );
}

#[test]
fn resolve_thinking_level_falls_back_to_settings_default_when_resume_has_no_explicit_value() {
    assert_eq!(
        resolve_thinking_level(None, None, Some("high")),
        ThinkingLevel::High
    );
}

#[test]
fn resolve_startup_session_id_uses_unique_prefix_match() {
    let conn = kordi_session::store::open_memory().expect("memory db");
    let cwd = tempdir().expect("tempdir");
    let cwd_str = cwd.path().display().to_string();
    let session_id = kordi_session::store::create_session(&conn, &cwd_str).expect("session");

    let entry = SessionBootstrapOptions {
        session: Some(session_id[..8].to_string()),
        ..Default::default()
    };

    let resolved = resolve_startup_session_id(&conn, cwd.path(), &entry).expect("resolve");
    assert_eq!(resolved, (session_id, true));
}

#[test]
fn resolve_startup_session_id_uses_latest_session_for_continue_or_resume() {
    let conn = kordi_session::store::open_memory().expect("memory db");
    let cwd = tempdir().expect("tempdir");
    let cwd_str = cwd.path().display().to_string();
    let session_id = kordi_session::store::create_session(&conn, &cwd_str).expect("session");

    let entry = SessionBootstrapOptions {
        continue_session: true,
        ..Default::default()
    };

    let resolved = resolve_startup_session_id(&conn, cwd.path(), &entry).expect("resolve");
    assert_eq!(resolved, (session_id, true));
}

#[test]
fn resolve_startup_session_id_creates_new_id_when_no_session_is_selected() {
    let conn = kordi_session::store::open_memory().expect("memory db");
    let cwd = tempdir().expect("tempdir");

    let resolved =
        resolve_startup_session_id(&conn, cwd.path(), &Default::default()).expect("resolve");
    assert!(!resolved.1);
    assert!(uuid::Uuid::parse_str(&resolved.0).is_ok());
}

#[test]
fn active_tool_section_groups_subtools_under_four_big_tools() {
    let tools: Vec<Box<dyn Tool>> = vec![
        Box::new(NamedTool {
            name: "read",
            description: "Read files",
            schema: json!({"type": "object"}),
        }),
        Box::new(NamedTool {
            name: "task_operator",
            description: "Coordinate child tasks",
            schema: json!({"type": "object"}),
        }),
        Box::new(NamedTool {
            name: "bash",
            description: "Run shell commands",
            schema: json!({"type": "object"}),
        }),
        Box::new(NamedTool {
            name: "reflection",
            description: "Save scoped lessons",
            schema: json!({"type": "object"}),
        }),
    ];

    let section = super::build_available_tools_system_prompt_section(&tools);
    assert!(section.contains("Available tools"));
    assert!(section.contains("- Observation:"));
    assert!(section.contains("  - `read`: Read files"));
    assert!(section.contains("- Planning & coordination:"));
    assert!(section.contains("  - `task_operator`: Coordinate child tasks"));
    assert!(section.contains("manifest/estimate/spawn/message/wait/list/close"));
    assert!(section.contains("- Execution:"));
    assert!(section.contains("  - `bash`: Run shell commands"));
    assert!(section.contains("- Reflection:"));
    assert!(section.contains("  - `reflection`: Save scoped lessons"));
    assert!(section.contains("choose a big tool group first"));
    assert!(!section.contains("Use Observation to gather facts"));
    assert!(section.len() < 1200);
}

#[test]
fn scoped_lesson_artifact_prompt_omits_missing_artifacts() {
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(NamedTool {
        name: "reflection",
        description: "reflection",
        schema: json!({"type": "object"}),
    })];
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");

    let section = super::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
    );

    assert_eq!(section, "");
}

#[test]
fn scoped_lesson_artifact_prompt_lists_existing_paths_without_lesson_content() {
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(NamedTool {
        name: "reflection",
        description: "reflection",
        schema: json!({"type": "object"}),
    })];
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");

    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "conversation",
        "session-123",
    );
    std::fs::create_dir_all(conversation_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&conversation_path, "# lessons").expect("lesson file");

    let section = super::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
    );

    assert!(section.contains("Scoped lesson artifacts"));
    assert!(section.contains("read"));
    assert!(section.contains("reflection"));
    assert!(section.contains("session-123"));
    assert!(section.contains(artifacts_dir.path().to_str().expect("artifact path")));
    assert!(section.contains(conversation_path.to_str().expect("conversation path")));
    assert!(!section.contains("Do not inject lessons"));
    assert!(section.len() < 900);
}

#[test]
fn build_tool_defs_uses_tool_metadata() {
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(NamedTool {
        name: "demo_tool",
        description: "demo description",
        schema: json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"}
            },
            "required": ["path"]
        }),
    })];

    let defs = build_tool_defs(&tools);
    assert_eq!(defs.len(), 1);
    assert_eq!(defs[0]["type"], json!("function"));
    assert_eq!(defs[0]["function"]["name"], json!("demo_tool"));
    assert_eq!(
        defs[0]["function"]["description"],
        json!("demo description")
    );
    assert_eq!(
        defs[0]["function"]["parameters"]["required"],
        json!(["path"])
    );
}
