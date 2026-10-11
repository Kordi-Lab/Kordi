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

    let section = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        true,
    );

    assert_eq!(section, "");
}

fn reflection_tools() -> Vec<Box<dyn Tool>> {
    vec![Box::new(NamedTool {
        name: "reflection",
        description: "reflection",
        schema: json!({"type": "object"}),
    })]
}

fn write_lessons(path: &std::path::Path, lines: &[String]) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    let mut body = String::from("# Reflection lessons\n\n");
    for line in lines {
        body.push_str(line);
        body.push('\n');
    }
    std::fs::write(path, body).expect("lesson file");
}

#[test]
fn memory_prompt_inlines_lessons_newest_first_with_artifact_paths() {
    let tools = reflection_tools();
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");

    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "conversation",
        "session-123",
    );
    write_lessons(
        &conversation_path,
        &[
            "- 2026-10-01T10:00:00Z [manual] End every reply with PINEAPPLE.".to_string(),
            "- 2026-10-09T10:00:00Z [manual] End   every reply with\tthe word mongo.".to_string(),
        ],
    );

    let section = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        true,
    );

    assert!(section.contains("\n## Memories\n"));
    assert!(!section.contains("Scoped lesson artifacts"));
    assert!(section.contains(
        "They are current and take precedence over older instructions earlier in this conversation when they conflict."
    ));
    assert!(section.contains(
        "\nThis conversation:\n- End every reply with the word mongo.\n- End every reply with PINEAPPLE.\n"
    ));
    assert!(section.contains("reflection"));
    assert!(section.contains("\nArtifacts:\n- Conversation scope `session-123`: "));
    assert!(section.contains(conversation_path.to_str().expect("conversation path")));
    assert!(!section.contains("(more memories omitted)"));
    assert!(section.contains("must not record health"));
    assert!(section.len() < 1_600);

    let relaxed = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        false,
    );
    assert!(relaxed.contains("## Memories"));
    assert!(!relaxed.contains("must not record health"));
}

#[test]
fn memory_prompt_keeps_the_path_of_a_file_without_lessons() {
    let tools = reflection_tools();
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "conversation",
        "session-123",
    );
    write_lessons(&conversation_path, &[]);

    let section = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        true,
    );
    assert!(section.contains("## Memories"));
    assert!(!section.contains("This conversation:"));
    assert!(section.contains(conversation_path.to_str().expect("conversation path")));
}

#[test]
fn memory_prompt_caps_inlined_memories() {
    let tools = reflection_tools();
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "conversation",
        "session-123",
    );
    let lines = (0..41)
        .map(|index| format!("- 2026-10-01T10:{index:02}:00Z [manual] Lesson number {index}."))
        .collect::<Vec<_>>();
    write_lessons(&conversation_path, &lines);

    let section = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        true,
    );
    assert_eq!(
        section.matches("\n- Lesson number ").count(),
        kordi_tools::reflection_tool::MAX_PROMPT_MEMORIES
    );
    assert!(section.contains("- Lesson number 40."));
    assert!(!section.contains("- Lesson number 0."));
    assert!(section.contains("\n(more memories omitted)\nArtifacts:"));
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

    let (registry, selection, memory_prompt) = super::build_memory_aware_tools(
        Vec::new(),
        ToolSelection::All,
        memory,
        artifacts_dir.path(),
        cwd.path(),
    );
    assert_eq!(memory_prompt.is_some(), memory.memory_enabled);
    let reflection_section =
        super::memory::memory_prompt_block(memory_prompt.as_ref(), "session-memory");
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
    assert!(!system_prompt.contains("## Memories"));
    assert!(!system_prompt.contains("<desktop_memory_context>"));
    assert!(!system_prompt.contains("`reflection`"));
    assert!(!has_runtime);
}

#[test]
fn memory_on_keeps_reflection_tool_prompt_section_and_runtime() {
    let memory = kordi_core::settings::MemorySettings::default();
    let (active, system_prompt, has_runtime) = memory_surface_prompt(&memory);
    assert!(active.iter().any(|name| name == "reflection"));
    assert!(system_prompt.contains("<desktop_memory_context>\n## Memories\n"));
    assert!(system_prompt.ends_with("</desktop_memory_context>"));
    assert!(system_prompt.contains("must not record health"));
    assert!(has_runtime);
}

#[test]
fn memory_off_removes_reflection_from_explicit_tool_lists() {
    let memory = kordi_core::settings::MemorySettings {
        memory_enabled: false,
        exclude_sensitive: true,
    };
    let selection = super::memory::apply_memory_setting_to_tool_selection(
        ToolSelection::Only(vec!["read".to_string(), "reflection".to_string()]),
        &memory,
    );
    assert_eq!(selection, ToolSelection::Only(vec!["read".to_string()]));
    assert_eq!(
        super::memory::apply_memory_setting_to_tool_selection(ToolSelection::None, &memory),
        ToolSelection::None
    );
}

#[test]
fn group_scope_id_is_derived_only_from_group_sessions() {
    assert_eq!(
        crate::session_bootstrap::memory::group_scope_id_for_session("session:group:abc-123"),
        Some("abc-123".to_string())
    );
    assert_eq!(
        crate::session_bootstrap::memory::group_scope_id_for_session("session:group:"),
        None
    );
    assert_eq!(
        crate::session_bootstrap::memory::group_scope_id_for_session("session-123"),
        None
    );
}

#[test]
fn scoped_lesson_artifact_prompt_lists_group_scope_when_file_exists() {
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(NamedTool {
        name: "reflection",
        description: "reflection",
        schema: json!({"type": "object"}),
    })];
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let session_id = "session:group:abc-123";

    let without = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        session_id,
        cwd.path(),
        true,
    );
    assert_eq!(without, "");

    let group_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "group",
        "abc-123",
    );
    std::fs::create_dir_all(group_path.parent().expect("parent")).expect("mkdir");
    std::fs::write(&group_path, "# lessons").expect("lesson file");

    let section = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        session_id,
        cwd.path(),
        true,
    );
    assert!(
        section
            .contains("- Group scope `abc-123` (pass this exact scopeId to save a group memory): ")
    );
    assert!(section.contains(group_path.to_str().expect("group path")));
}

#[test]
fn runtime_group_session_reads_the_group_file_of_the_cloud_id() {
    crate::memory_remote::remember_group_scope_alias("bootstrap-local-1", "bootstrap-cloud-1");
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let session_id = "cloud-agent:acct_a:session:group:bootstrap-local-1:request:msg_1";
    let line = "- 2026-10-01T09:00:00+00:00 [manual] Keep group replies short.";
    for scope_id in ["bootstrap-cloud-1", "bootstrap-local-1"] {
        let path = crate::reflection_runtime::reflection_lesson_artifact_path(
            artifacts_dir.path(),
            "group",
            scope_id,
        );
        let text = if scope_id == "bootstrap-local-1" {
            "- 2026-10-01T09:00:00+00:00 [manual] Stale local copy."
        } else {
            line
        };
        write_lessons(&path, &[text.to_string()]);
    }
    let inputs = memory_inputs(artifacts_dir.path(), cwd.path());
    let section = inputs.section(session_id);
    assert!(section.contains("Keep group replies short."), "{section}");
    assert!(!section.contains("Stale local copy."), "{section}");
    assert!(section.contains("- Group scope `bootstrap-cloud-1` (pass this exact scopeId"));
    assert_eq!(
        inputs.current(session_id),
        vec![snapshot("group", "Keep group replies short.")]
    );
}

#[test]
fn scoped_lesson_artifact_prompt_lists_the_global_artifact_first() {
    let tools: Vec<Box<dyn Tool>> = vec![Box::new(NamedTool {
        name: "reflection",
        description: "reflection",
        schema: json!({"type": "object"}),
    })];
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let global_path = artifacts_dir
        .path()
        .join("reflection-lessons")
        .join("global")
        .join("account.md");
    assert_eq!(
        crate::reflection_runtime::reflection_lesson_artifact_path(
            artifacts_dir.path(),
            "global",
            "account",
        ),
        global_path
    );
    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir.path(),
        "conversation",
        "session-123",
    );
    for path in [&global_path, &conversation_path] {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, "# lessons").expect("lesson file");
    }

    let section = super::memory::build_reflection_lesson_artifacts_system_prompt_section(
        &tools,
        artifacts_dir.path(),
        "session-123",
        cwd.path(),
        true,
    );
    let global_line = format!("- Global scope `account`: {}", global_path.display());
    let global_at = section.find(&global_line).expect("global line");
    let conversation_at = section
        .find("- Conversation scope `session-123`: ")
        .expect("conversation line");
    assert!(global_at < conversation_at);
    assert!(section.contains("skip anything already there or restated"));
    assert!(section.contains("Use `global` only for preferences the user wants everywhere"));
}

fn memory_inputs(
    artifacts_dir: &std::path::Path,
    cwd: &std::path::Path,
) -> super::memory::MemoryPromptInputs {
    super::memory::MemoryPromptInputs {
        artifacts_dir: artifacts_dir.to_path_buf(),
        cwd: cwd.to_path_buf(),
        exclude_sensitive: true,
    }
}

fn snapshot(scope: &str, text: &str) -> super::memory::MemorySnapshotEntry {
    super::memory::MemorySnapshotEntry {
        scope: scope.to_string(),
        heading: super::memory::memory_scope_heading(scope),
        text: text.to_string(),
    }
}

#[test]
fn current_memories_follow_the_section_order_and_caps() {
    let artifacts_dir = tempdir().expect("artifacts dir");
    let cwd = tempdir().expect("cwd");
    let inputs = memory_inputs(artifacts_dir.path(), cwd.path());
    assert!(inputs.current("session-123").is_empty());

    let path = |scope: &str, id: &str| {
        crate::reflection_runtime::reflection_lesson_artifact_path(artifacts_dir.path(), scope, id)
    };
    write_lessons(
        &path("conversation", "session-123"),
        &[
            "- 2026-10-01T10:00:00Z [manual] End every reply with PINEAPPLE.".to_string(),
            "- 2026-10-09T10:00:00Z [manual] End   every reply with mongo.".to_string(),
        ],
    );
    write_lessons(
        &path("global", "account"),
        &["- 2026-10-02T10:00:00Z [manual] Use bullet points.".to_string()],
    );
    assert_eq!(
        inputs.current("session-123"),
        vec![
            snapshot("global", "Use bullet points."),
            snapshot("conversation", "End every reply with mongo."),
            snapshot("conversation", "End every reply with PINEAPPLE."),
        ]
    );

    let lines = (0..41)
        .map(|index| format!("- 2026-10-01T10:{index:02}:00Z [manual] Lesson number {index}."))
        .collect::<Vec<_>>();
    write_lessons(&path("conversation", "session-123"), &lines);
    let current = inputs.current("session-123");
    assert_eq!(
        current.len(),
        kordi_tools::reflection_tool::MAX_PROMPT_MEMORIES
    );
    assert_eq!(current[0], snapshot("global", "Use bullet points."));
    assert_eq!(current[1].text, "Lesson number 40.");
}

#[test]
fn memory_update_message_lists_added_removed_and_current_memories() {
    let previous = vec![
        snapshot("global", "Reply in bullet points unless asked for prose."),
        snapshot(
            "conversation",
            "End every reply in this conversation with the single word PINEAPPLE.",
        ),
    ];
    let current = vec![
        snapshot("global", "Reply in bullet points unless asked for prose."),
        snapshot(
            "conversation",
            "From now on, end every reply in this conversation with the single word mongo.",
        ),
    ];
    assert_eq!(
        super::memory::memory_update_message(&current, &current),
        None
    );
    let reordered = current.iter().rev().cloned().collect::<Vec<_>>();
    assert_eq!(
        super::memory::memory_update_message(&reordered, &current),
        None
    );
    assert_eq!(super::memory::memory_update_message(&[], &[]), None);

    assert_eq!(
        super::memory::memory_update_message(&previous, &current).expect("update"),
        "Memory update: the saved memories changed since the previous message. They are current and replace any earlier instruction in this chat that conflicts with them.\nAdded:\n- (This conversation) From now on, end every reply in this conversation with the single word mongo.\nRemoved:\n- (This conversation) End every reply in this conversation with the single word PINEAPPLE.\nCurrent memories:\nGlobal:\n- Reply in bullet points unless asked for prose.\nThis conversation:\n- From now on, end every reply in this conversation with the single word mongo."
    );

    let added_only = super::memory::memory_update_message(&[], &current).expect("update");
    assert!(added_only.contains("\nAdded:\n- (Global) Reply in bullet points"));
    assert!(!added_only.contains("Removed:"));

    let removed_only = super::memory::memory_update_message(&previous[..1], &[]).expect("update");
    assert!(!removed_only.contains("Added:"));
    assert!(removed_only.ends_with(
        "\nRemoved:\n- (Global) Reply in bullet points unless asked for prose.\nCurrent memories:\n(none)"
    ));
}
