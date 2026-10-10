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

/// Inputs that rebuild the memory prompt section from the lesson files. The
/// bootstrap keeps them on the session setup so a cached desktop session can
/// refresh the section at the start of every turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MemoryPromptInputs {
    pub artifacts_dir: std::path::PathBuf,
    pub cwd: std::path::PathBuf,
    pub exclude_sensitive: bool,
}

impl MemoryPromptInputs {
    /// The `## Memories` section for `session_id`, or an empty string when no
    /// lesson file exists for any of its scopes.
    pub(crate) fn section(&self, session_id: &str) -> String {
        memory_prompt_section_from_files(
            &self.artifacts_dir,
            session_id,
            &self.cwd,
            self.exclude_sensitive,
        )
    }
}

/// Tags around the memory section in a desktop system prompt, so a cached
/// session can swap it for a fresh copy every turn.
pub(crate) const MEMORY_CONTEXT_START: &str = "\n\n<desktop_memory_context>";
pub(crate) const MEMORY_CONTEXT_END: &str = "</desktop_memory_context>";

/// Wrap a memory section in its tags, or return an empty string when there is
/// nothing to show.
pub(crate) fn tagged_memory_prompt_block(section: &str) -> String {
    let section = section.trim();
    if section.is_empty() {
        return String::new();
    }
    format!("{MEMORY_CONTEXT_START}\n{section}\n{MEMORY_CONTEXT_END}")
}

/// The tagged memory block for `session_id`, or an empty string when memory
/// is off or no lesson file exists.
pub(crate) fn memory_prompt_block(inputs: Option<&MemoryPromptInputs>, session_id: &str) -> String {
    inputs
        .map(|inputs| tagged_memory_prompt_block(&inputs.section(session_id)))
        .unwrap_or_default()
}

/// Build the tool registry together with the memory prompt inputs so both
/// follow the memory switch. The inputs are `None` when memory is off or the
/// `reflection` tool is not active.
pub(crate) fn build_memory_aware_tools(
    extension_tools: Vec<Box<dyn Tool>>,
    selection: ToolSelection,
    memory: &MemorySettings,
    artifacts_dir: &std::path::Path,
    cwd: &std::path::Path,
) -> (ToolRegistry, ToolSelection, Option<MemoryPromptInputs>) {
    let selection = apply_memory_setting_to_tool_selection(selection, memory);
    let registry = ToolRegistry::from_builtin_and_extensions(extension_tools, selection.clone());
    let has_reflection = registry
        .active_tools()
        .iter()
        .any(|tool| tool.name() == "reflection");
    let inputs = (memory.memory_enabled && has_reflection).then(|| MemoryPromptInputs {
        artifacts_dir: artifacts_dir.to_path_buf(),
        cwd: cwd.to_path_buf(),
        exclude_sensitive: memory.exclude_sensitive,
    });
    (registry, selection, inputs)
}

/// The group id behind a group session id (`session:group:<id>`), which is
/// the scope id of that group's memories.
pub(crate) fn group_scope_id_for_session(session_id: &str) -> Option<String> {
    session_id
        .strip_prefix("session:group:")
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
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
    memory_prompt_section_from_files(artifacts_dir, session_id, cwd, exclude_sensitive)
}

/// One scope's lesson file as it appears in the prompt.
struct ScopeArtifact {
    heading: &'static str,
    path_line: String,
    lessons: Vec<crate::reflection_runtime::ParsedLessonLine>,
}

fn scope_artifact(
    path: std::path::PathBuf,
    heading: &'static str,
    label: &str,
    scope_id: &str,
) -> Option<ScopeArtifact> {
    if !path.exists() {
        return None;
    }
    // An unreadable file contributes its path but no memories; memory must
    // never fail a turn.
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lessons = crate::reflection_runtime::parse_lesson_artifact(&text);
    lessons.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    Some(ScopeArtifact {
        heading,
        path_line: format!("- {label} scope `{scope_id}`: {}", path.display()),
        lessons,
    })
}

fn memory_line(text: &str) -> String {
    format!(
        "- {}",
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    )
}

fn memory_prompt_section_from_files(
    artifacts_dir: &std::path::Path,
    session_id: &str,
    cwd: &std::path::Path,
    exclude_sensitive: bool,
) -> String {
    use crate::reflection_runtime::reflection_lesson_artifact_path as artifact_path;
    use kordi_tools::reflection_tool::{
        GLOBAL_SCOPE_ID, MAX_PROMPT_MEMORIES, MAX_PROMPT_MEMORY_CHARS,
    };

    let project_root = kordi_core::config::project_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let project_scope_id = project_root.display().to_string();
    let mut artifacts = vec![
        scope_artifact(
            artifact_path(artifacts_dir, "global", GLOBAL_SCOPE_ID),
            "Global",
            "Global",
            GLOBAL_SCOPE_ID,
        ),
        scope_artifact(
            artifact_path(artifacts_dir, "conversation", session_id),
            "This conversation",
            "Conversation",
            session_id,
        ),
        scope_artifact(
            artifact_path(artifacts_dir, "project", &project_scope_id),
            "This project",
            "Project",
            &project_scope_id,
        ),
    ];
    if let Some(group_scope_id) = group_scope_id_for_session(session_id) {
        artifacts.push(scope_artifact(
            artifact_path(artifacts_dir, "group", &group_scope_id),
            "This group",
            "Group",
            &group_scope_id,
        ));
    }
    let artifacts = artifacts.into_iter().flatten().collect::<Vec<_>>();
    if artifacts.is_empty() {
        return String::new();
    }

    let sensitive_rule = if exclude_sensitive {
        " Memories must not record health, finances, relationships, identity attributes, credentials, or other people's private details."
    } else {
        ""
    };
    let mut section = format!(
        "\n\n## Memories\nThese are the user's saved memories for this account and conversation. They are current and take precedence over older instructions earlier in this conversation when they conflict. After corrections, repeated failures, or outcomes, report the update and call `reflection` to save a concise memory. Before saving, read that scope's artifact and skip anything already there or restated; when a preference changes, save the corrected version. Use `global` only for preferences the user wants everywhere (\"from now on\", \"always\"); keep everything else in its conversation, group, or project scope.{sensitive_rule}"
    );

    let total = artifacts
        .iter()
        .map(|artifact| artifact.lessons.len())
        .sum::<usize>();
    let mut used_chars = 0usize;
    let mut shown = 0usize;
    'blocks: for artifact in &artifacts {
        let mut wrote_heading = false;
        for lesson in &artifact.lessons {
            let line = memory_line(&lesson.text);
            let chars = line.chars().count() + 1;
            if shown >= MAX_PROMPT_MEMORIES || used_chars + chars > MAX_PROMPT_MEMORY_CHARS {
                break 'blocks;
            }
            if !wrote_heading {
                section.push_str(&format!("\n{}:", artifact.heading));
                wrote_heading = true;
            }
            section.push('\n');
            section.push_str(&line);
            used_chars += chars;
            shown += 1;
        }
    }
    if shown < total {
        section.push_str("\n(more memories omitted)");
    }

    section.push_str("\nArtifacts:");
    for artifact in &artifacts {
        section.push('\n');
        section.push_str(&artifact.path_line);
    }
    section
}
