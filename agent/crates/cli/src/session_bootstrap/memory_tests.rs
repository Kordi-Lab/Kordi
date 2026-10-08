//! Memory switch and scoped memory prompt regressions for session bootstrap.

use super::tests::NamedTool;
use crate::tool_registry::ToolSelection;
use kordi_tools::Tool;
use serde_json::json;
use tempfile::tempdir;

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
        true,
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
        true,
    );

    assert!(section.contains("Scoped lesson artifacts"));
    assert!(section.contains("read"));
    assert!(section.contains("reflection"));
    assert!(section.contains("session-123"));
    assert!(section.contains(artifacts_dir.path().to_str().expect("artifact path")));
    assert!(section.contains(conversation_path.to_str().expect("conversation path")));
    assert!(!section.contains("Do not inject lessons"));
    assert!(section.contains("must not record health"));
    assert!(section.len() < 900);

    let relaxed = super::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        false,
    );
    assert!(relaxed.contains("Scoped lesson artifacts"));
    assert!(!relaxed.contains("must not record health"));
}

fn memory_surface_prompt(
    memory: &kordi_core::settings::MemorySettings,
) -> (Vec<String>, String, bool) {
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "conversation",
        "session-memory",
    );
    std::fs::create_dir_all(conversation_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&conversation_path, "# lessons").expect("lesson file");

    let (registry, selection, reflection_section) = super::build_memory_aware_tools(
        Vec::new(),
        ToolSelection::All,
        memory,
        artifacts_dir.path(),
        "session-memory",
        cwd.path(),
    );
    let active = registry
        .active_tools()
        .iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();
    let rebuilt =
        crate::tool_registry::ToolRegistry::from_builtin_and_extensions(Vec::new(), selection);
    assert_eq!(
        rebuilt
            .active_tools()
            .iter()
            .any(|tool| tool.name() == "reflection"),
        memory.memory_enabled,
        "the stored selection must keep the memory switch on reload"
    );
    let system_prompt = format!(
        "base{}{}",
        super::build_available_tools_system_prompt_section(registry.active_tools()),
        reflection_section
    );
    let conn = std::sync::Arc::new(tokio::sync::Mutex::new(
        kordi_session::store::open_memory().expect("memory db"),
    ));
    let runtime = super::reflection_runtime_for_settings(
        memory,
        conn,
        artifacts_dir.path().to_path_buf(),
        crate::memory_remote::empty_memory_remote_slot(),
    );
    (active, system_prompt, runtime.is_some())
}

#[test]
fn memory_off_removes_reflection_tool_prompt_section_and_runtime() {
    let memory = kordi_core::settings::MemorySettings {
        memory_enabled: false,
        exclude_sensitive: true,
    };
    let (active, system_prompt, has_runtime) = memory_surface_prompt(&memory);
    assert!(!active.iter().any(|name| name == "reflection"));
    assert!(active.iter().any(|name| name == "read"));
    assert!(!system_prompt.contains("Scoped lesson artifacts"));
    assert!(!system_prompt.contains("`reflection`"));
    assert!(!has_runtime);
}

#[test]
fn memory_on_keeps_reflection_tool_prompt_section_and_runtime() {
    let memory = kordi_core::settings::MemorySettings::default();
    let (active, system_prompt, has_runtime) = memory_surface_prompt(&memory);
    assert!(active.iter().any(|name| name == "reflection"));
    assert!(system_prompt.contains("Scoped lesson artifacts"));
    assert!(system_prompt.contains("must not record health"));
    assert!(has_runtime);
}

#[test]
fn memory_off_removes_reflection_from_explicit_tool_lists() {
    let memory = kordi_core::settings::MemorySettings {
        memory_enabled: false,
        exclude_sensitive: true,
    };
    let selection = super::apply_memory_setting_to_tool_selection(
        ToolSelection::Only(vec!["read".to_string(), "reflection".to_string()]),
        &memory,
    );
    assert_eq!(selection, ToolSelection::Only(vec!["read".to_string()]));
    assert_eq!(
        super::apply_memory_setting_to_tool_selection(ToolSelection::None, &memory),
        ToolSelection::None
    );
}
