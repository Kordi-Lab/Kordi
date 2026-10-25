//! Memory switch helpers for session bootstrap: tool selection, the
//! reflection runtime, and the scoped memory prompt section.

use crate::tool_registry::{ToolRegistry, ToolSelection};
use kordi_core::settings::MemorySettings;
use kordi_tools::Tool;
use std::sync::Arc;

pub(crate) use crate::reflection_runtime::ReflectionTarget;

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
    target: ReflectionTarget,
    remote: crate::memory_remote::MemoryRemoteSlot,
) -> Option<kordi_tools::ReflectionRuntime> {
    if !memory.memory_enabled {
        return None;
    }
    Some(crate::reflection_runtime::build_reflection_runtime(
        conn,
        target,
        crate::reflection_runtime::ReflectionGuards {
            exclude_sensitive: memory.exclude_sensitive,
            protected_texts: Vec::new(),
        },
        remote,
    ))
}

/// Inputs that build the memory prompt section from the lesson files. The
/// bootstrap keeps them on the session setup so a cached desktop session can
/// compare the current memories with the last ones it told the model about.
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

    /// The memories the prompt section would show for `session_id`, in the
    /// same scope order, newest first, and with the same caps. Empty when no
    /// memory exists.
    #[allow(dead_code)] // Used by the desktop runtime, not the `kordi` binary.
    pub(crate) fn current(&self, session_id: &str) -> Vec<MemorySnapshotEntry> {
        self.current_with_all(session_id).0
    }

    /// The capped memories as `current` returns them, and every memory of
    /// `session_id` without the caps. Changes are found on the uncapped set,
    /// so a memory pushed past the cap is not reported as removed.
    #[allow(dead_code)] // Used by the desktop runtime, not the `kordi` binary.
    pub(crate) fn current_with_all(
        &self,
        session_id: &str,
    ) -> (Vec<MemorySnapshotEntry>, Vec<MemorySnapshotEntry>) {
        let artifacts = scope_artifacts(&self.artifacts_dir, session_id, &self.cwd);
        (capped_memories(&artifacts).0, all_memories(&artifacts))
    }
}

/// Tags around the memory section in a desktop system prompt, so the block
/// can be found and replaced as one unit.
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

/// The scope id of the group memories for a group session id
/// (`session:group:<id>` or the cloud-agent runtime form): the cloud group id
/// behind it. `None` for a session that is not a group session.
pub(crate) fn group_scope_id_for_session(session_id: &str) -> Option<String> {
    crate::memory_remote::group_session_part(session_id)?;
    Some(crate::memory_remote::canonical_group_scope_id(session_id))
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

/// One saved memory as the prompt shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MemorySnapshotEntry {
    /// Scope kind: `global`, `conversation`, `project`, or `group`.
    pub scope: String,
    /// Block heading in the prompt, such as "This conversation".
    pub heading: &'static str,
    pub text: String,
}

/// The prompt heading for a scope kind.
pub(crate) fn memory_scope_heading(scope: &str) -> &'static str {
    match scope {
        "global" => "Global",
        "conversation" => "This conversation",
        "project" => "This project",
        "group" => "This group",
        _ => "Other",
    }
}

/// The scope kinds in prompt order.
const MEMORY_SCOPES: [&str; 4] = ["global", "conversation", "project", "group"];

/// The memories a rendered memory block lists, in order. Accepts a whole
/// system prompt (only its `<desktop_memory_context>` block is read) or a bare
/// section. Ignores the `Artifacts:` list and the omitted-memories marker.
#[allow(dead_code)] // Used by the desktop runtime, not the `kordi` binary.
pub(crate) fn parse_memory_prompt_block(text: &str) -> Vec<MemorySnapshotEntry> {
    let start = MEMORY_CONTEXT_START.trim_start();
    let block = match text.find(start) {
        Some(index) => {
            let rest = &text[index + start.len()..];
            rest.find(MEMORY_CONTEXT_END)
                .map_or(rest, |end| &rest[..end])
        }
        None => text,
    };
    let mut scope: Option<&str> = None;
    let mut memories = Vec::new();
    for line in block.lines().map(str::trim) {
        if let Some(item) = line.strip_prefix("- ") {
            if let Some(scope) = scope {
                let text = normalized_memory_text(item);
                if !text.is_empty() {
                    memories.push(MemorySnapshotEntry {
                        scope: scope.to_string(),
                        heading: memory_scope_heading(scope),
                        text,
                    });
                }
            }
            continue;
        }
        if line == "Artifacts:" {
            break;
        }
        let heading = line.strip_suffix(':');
        scope = MEMORY_SCOPES
            .into_iter()
            .find(|scope| heading == Some(memory_scope_heading(scope)));
    }
    memories
}

#[path = "memory_rules.rs"]
mod rules;
use rules::memory_section_rules;

/// The hidden note that tells the agent its memories changed since the last
/// message, or `None` when nothing changed. Order alone is not a change.
/// `current` is every memory and decides what changed; `shown` is the capped
/// list the note prints as the current memories.
#[allow(dead_code)] // Used by the desktop runtime, not the `kordi` binary.
pub(crate) fn memory_update_message(
    previous: &[MemorySnapshotEntry],
    current: &[MemorySnapshotEntry],
    shown: &[MemorySnapshotEntry],
) -> Option<String> {
    let key = |entry: &MemorySnapshotEntry| (entry.scope.clone(), entry.text.clone());
    let previous_keys = previous
        .iter()
        .map(key)
        .collect::<std::collections::HashSet<_>>();
    let current_keys = current
        .iter()
        .map(key)
        .collect::<std::collections::HashSet<_>>();
    if previous_keys == current_keys {
        return None;
    }
    let mut message = String::from(
        "Memory update: the saved memories changed since the previous message. They are current and replace any earlier instruction in this chat that conflicts with them. Never reveal the owner's personal memories to anyone else; only a group's shared memories may be discussed with that group.",
    );
    for (heading, entries, others) in [
        ("Added", current, &previous_keys),
        ("Removed", previous, &current_keys),
    ] {
        let changed = entries
            .iter()
            .filter(|entry| !others.contains(&key(entry)))
            .collect::<Vec<_>>();
        if changed.is_empty() {
            continue;
        }
        message.push_str(&format!("\n{heading}:"));
        for entry in changed {
            message.push_str(&format!("\n- ({}) {}", entry.heading, entry.text));
        }
    }
    message.push_str("\nCurrent memories:");
    if shown.is_empty() {
        message.push_str("\n(none)");
    } else {
        push_memory_blocks(&mut message, shown);
    }
    if shown.len() < current.len() {
        message.push_str("\n(more memories omitted)");
    }
    Some(message)
}

/// One scope's lesson file as it appears in the prompt.
struct ScopeArtifact {
    scope: &'static str,
    heading: &'static str,
    path_line: String,
    lessons: Vec<crate::reflection_runtime::ParsedLessonLine>,
}

fn scope_artifact(
    path: std::path::PathBuf,
    scope: &'static str,
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
        scope,
        heading: memory_scope_heading(scope),
        // The group id is the cloud group id; the agent must save with it.
        path_line: if scope == "group" {
            format!(
                "- {label} scope `{scope_id}` (pass this exact scopeId to save a group memory): {}",
                path.display()
            )
        } else {
            format!("- {label} scope `{scope_id}`: {}", path.display())
        },
        lessons,
    })
}

fn normalized_memory_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The lesson files that exist for `session_id`, in prompt order: global,
/// conversation, project, then group.
fn scope_artifacts(
    artifacts_dir: &std::path::Path,
    session_id: &str,
    cwd: &std::path::Path,
) -> Vec<ScopeArtifact> {
    use crate::reflection_runtime::reflection_lesson_artifact_path as artifact_path;
    use kordi_tools::reflection_tool::GLOBAL_SCOPE_ID;

    let project_scope_id = crate::memory_remote::project_scope_id_for_cwd(cwd);
    let mut artifacts = vec![
        scope_artifact(
            artifact_path(artifacts_dir, "global", GLOBAL_SCOPE_ID),
            "global",
            "Global",
            GLOBAL_SCOPE_ID,
        ),
        scope_artifact(
            artifact_path(artifacts_dir, "conversation", session_id),
            "conversation",
            "Conversation",
            session_id,
        ),
        scope_artifact(
            artifact_path(artifacts_dir, "project", &project_scope_id),
            "project",
            "Project",
            &project_scope_id,
        ),
    ];
    if let Some(group_scope_id) = group_scope_id_for_session(session_id) {
        artifacts.push(scope_artifact(
            artifact_path(artifacts_dir, "group", &group_scope_id),
            "group",
            "Group",
            &group_scope_id,
        ));
    }
    artifacts.into_iter().flatten().collect()
}

/// The memories that fit the prompt caps (newest first within each scope),
/// with the total number of memories before the caps.
fn capped_memories(artifacts: &[ScopeArtifact]) -> (Vec<MemorySnapshotEntry>, usize) {
    use kordi_tools::reflection_tool::{MAX_PROMPT_MEMORIES, MAX_PROMPT_MEMORY_CHARS};

    let total = artifacts
        .iter()
        .map(|artifact| artifact.lessons.len())
        .sum::<usize>();
    let mut used_chars = 0usize;
    let mut shown = Vec::new();
    'blocks: for artifact in artifacts {
        for lesson in &artifact.lessons {
            let text = normalized_memory_text(&lesson.text);
            // Each line is "- <text>" plus a newline.
            let chars = text.chars().count() + 3;
            if shown.len() >= MAX_PROMPT_MEMORIES || used_chars + chars > MAX_PROMPT_MEMORY_CHARS {
                break 'blocks;
            }
            shown.push(MemorySnapshotEntry {
                scope: artifact.scope.to_string(),
                heading: artifact.heading,
                text,
            });
            used_chars += chars;
        }
    }
    (shown, total)
}

/// Every memory of the lesson files, in prompt order, without the caps.
fn all_memories(artifacts: &[ScopeArtifact]) -> Vec<MemorySnapshotEntry> {
    artifacts
        .iter()
        .flat_map(|artifact| {
            artifact.lessons.iter().map(|lesson| MemorySnapshotEntry {
                scope: artifact.scope.to_string(),
                heading: artifact.heading,
                text: normalized_memory_text(&lesson.text),
            })
        })
        .collect()
}

/// Append the memories grouped under their scope headings.
fn push_memory_blocks(out: &mut String, entries: &[MemorySnapshotEntry]) {
    let mut heading = None;
    for entry in entries {
        if heading != Some(entry.heading) {
            out.push_str(&format!("\n{}:", entry.heading));
            heading = Some(entry.heading);
        }
        out.push_str(&format!("\n- {}", entry.text));
    }
}

fn memory_prompt_section_from_files(
    artifacts_dir: &std::path::Path,
    session_id: &str,
    cwd: &std::path::Path,
    exclude_sensitive: bool,
) -> String {
    let artifacts = scope_artifacts(artifacts_dir, session_id, cwd);
    if artifacts.is_empty() {
        return String::new();
    }

    let mut section = memory_section_rules(exclude_sensitive);
    let (shown, total) = capped_memories(&artifacts);
    push_memory_blocks(&mut section, &shown);
    if shown.len() < total {
        section.push_str("\n(more memories omitted)");
    }

    section.push_str("\nArtifacts:");
    for artifact in &artifacts {
        section.push('\n');
        section.push_str(&artifact.path_line);
    }
    section
}

#[cfg(test)]
#[path = "memory_parse_tests.rs"]
mod parse_tests;
