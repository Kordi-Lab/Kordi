//! Memory switch helpers for session bootstrap: tool selection, the
//! reflection runtime, and the scoped memory prompt section.

use crate::tool_registry::{ToolRegistry, ToolSelection};
use kordi_core::settings::MemorySettings;
use kordi_tools::Tool;
use std::sync::Arc;

/// Apply the memory switch to a tool selection. When memory is off the
/// `reflection` tool is removed before the registry is built, so neither the
/// tool nor its prompt section reaches the model. Stored memories are kept.
pub(crate) fn apply_memory_setting_to_tool_selection(
    selection: ToolSelection,
    memory: &MemorySettings,
) -> ToolSelection {
    if memory.memory_enabled {
        selection
    } else {
        selection.without("reflection")
    }
}

/// Build the reflection runtime for a session, or `None` when memory is off.
pub(crate) fn reflection_runtime_for_settings(
    memory: &MemorySettings,
    conn: Arc<tokio::sync::Mutex<rusqlite::Connection>>,
    artifacts_dir: std::path::PathBuf,
    remote: crate::memory_remote::MemoryRemoteSlot,
) -> Option<kordi_tools::ReflectionRuntime> {
    if !memory.memory_enabled {
        return None;
    }
    Some(crate::reflection_runtime::build_reflection_runtime(
        conn,
        artifacts_dir,
        crate::reflection_runtime::ReflectionGuards {
            exclude_sensitive: memory.exclude_sensitive,
            protected_texts: Vec::new(),
        },
        remote,
    ))
}

/// Build the tool registry and the scoped memory prompt section together so
/// both follow the memory switch.
pub(crate) fn build_memory_aware_tools(
    extension_tools: Vec<Box<dyn Tool>>,
    selection: ToolSelection,
    memory: &MemorySettings,
    artifacts_dir: &std::path::Path,
    session_id: &str,
    cwd: &std::path::Path,
) -> (ToolRegistry, ToolSelection, String) {
    let selection = apply_memory_setting_to_tool_selection(selection, memory);
    let registry = ToolRegistry::from_builtin_and_extensions(extension_tools, selection.clone());
    let section = if memory.memory_enabled {
        build_reflection_lesson_artifacts_system_prompt_section(
            registry.active_tools(),
            artifacts_dir,
            session_id,
            cwd,
            memory.exclude_sensitive,
        )
    } else {
        String::new()
    };
    (registry, selection, section)
}

/// The group id behind a group session id (`session:group:<id>`), which is
/// the scope id of that group's memories.
pub(crate) fn group_scope_id_for_session(session_id: &str) -> Option<String> {
    session_id
        .strip_prefix("session:group:")
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

pub(crate) fn build_reflection_lesson_artifacts_system_prompt_section(
    tools: &[Box<dyn Tool>],
    artifacts_dir: &std::path::Path,
    session_id: &str,
    cwd: &std::path::Path,
    exclude_sensitive: bool,
) -> String {
    if !tools.iter().any(|tool| tool.name() == "reflection") {
        return String::new();
    }

    let project_root = kordi_core::config::project_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let project_scope_id = project_root.display().to_string();
    let conversation_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir,
        "conversation",
        session_id,
    );
    let project_path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts_dir,
        "project",
        &project_scope_id,
    );

    let mut artifact_lines = Vec::new();
    if conversation_path.exists() {
        artifact_lines.push(format!(
            "- Conversation scope `{session_id}`: {}",
            conversation_path.display()
        ));
    }
    if project_path.exists() {
        artifact_lines.push(format!(
            "- Project scope `{project_scope_id}`: {}",
            project_path.display()
        ));
    }

    if let Some(group_scope_id) = group_scope_id_for_session(session_id) {
        let group_path = crate::reflection_runtime::reflection_lesson_artifact_path(
            artifacts_dir,
            "group",
            &group_scope_id,
        );
        if group_path.exists() {
            artifact_lines.push(format!(
                "- Group scope `{group_scope_id}`: {}",
                group_path.display()
            ));
        }
    }

    if artifact_lines.is_empty() {
        return String::new();
    }

    let sensitive_rule = if exclude_sensitive {
        " Memories must not record health, finances, relationships, identity attributes, credentials, or other people's private details."
    } else {
        ""
    };
    format!(
        "\n\n## Scoped lesson artifacts\nMemory content lives in files, not this prompt. Use `read` on the relevant artifact before relying on prior memories; after corrections, repeated failures, or outcomes, report the update and call `reflection` to save a concise memory.{sensitive_rule}\n{}",
        artifact_lines.join("\n"),
    )
}
