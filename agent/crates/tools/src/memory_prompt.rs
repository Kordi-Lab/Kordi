//! The `## Memories` system prompt section of a cloud run (#1710, #1977).
//!
//! The cloud runner and the cloud server render it with the same function,
//! so a run gets the same section whichever executor runs it: the runner
//! from the memories it fetches, the server for a run it hands to the
//! owner's Mac (a proactive evaluation). The inputs are neutral: the memory
//! fields the section reads, the account's memory settings, and the run's
//! conversation ids.

use crate::memory_categories::memory_routing_rules;
use crate::reflection_tool::{GLOBAL_SCOPE_ID, MAX_PROMPT_MEMORIES, MAX_PROMPT_MEMORY_CHARS};

/// The fields of one saved memory that the section reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptMemory<'a> {
    pub scope: &'a str,
    pub scope_id: &'a str,
    pub text: &'a str,
    pub created_at: &'a str,
    pub updated_at: &'a str,
}

/// The account's memory settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemorySettings {
    pub enabled: bool,
    pub exclude_sensitive: bool,
}

/// The run the section is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryRun<'a> {
    /// The run's conversation, for example `session:group:<groupId>`.
    pub session_id: &'a str,
    /// The execution subsession, when the run has one.
    pub subsession_id: Option<&'a str>,
    /// The owner made the request, so the run may save global memories.
    pub owner_request: bool,
}

/// The line a run without tools adds after its memory section.
pub const NO_TOOLS_MEMORY_LINE: &str =
    "This run has no tools: apply the memories, do not try to save new ones.";

/// Scope ids a run reads memories from.
///
/// Every run reads the owner's global memories (scope id `account`). A cloud
/// run carries one conversation id, its session id (for example
/// `session:group:<groupId>` or `session:direct-person:<a>:<b>`), plus a
/// subsession id for execution subsessions. Both are conversation scope ids.
/// A group conversation also exposes its group id. Runs carry no project id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryScopes {
    pub conversation_ids: Vec<String>,
    pub group_id: Option<String>,
    pub project_id: Option<String>,
}

/// Prompt blocks in display order: global first, then the run's scopes.
const PROMPT_BLOCKS: [(&str, &str); 4] = [
    ("global", "Global"),
    ("conversation", "This conversation"),
    ("group", "This group"),
    ("project", "This project"),
];

impl MemoryScopes {
    pub fn for_session(session_id: &str, subsession_id: Option<&str>) -> Self {
        let mut conversation_ids = vec![session_id.to_string()];
        if let Some(subsession_id) = subsession_id
            && !subsession_id.trim().is_empty()
            && subsession_id != session_id
        {
            conversation_ids.push(subsession_id.to_string());
        }
        let group_id = session_id
            .strip_prefix("session:group:")
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        Self {
            conversation_ids,
            group_id,
            project_id: None,
        }
    }

    pub fn for_run(run: &MemoryRun<'_>) -> Self {
        Self::for_session(run.session_id, run.subsession_id)
    }

    /// Checks a `reflection` save against the scopes the server allows for
    /// the run, so the model gets the refusal without a round trip: the
    /// run's conversations and group, and `global` only when the owner made
    /// the request. Cloud runs carry no project. The error lists the scope
    /// ids the model may use.
    pub fn check_save(
        &self,
        owner_request: bool,
        scope: &str,
        scope_id: &str,
    ) -> Result<(), String> {
        let scope_id = scope_id.trim();
        let allowed = match scope.trim() {
            "conversation" => self.conversation_ids.iter().any(|id| id == scope_id),
            "group" => self.group_id.as_deref() == Some(scope_id),
            "project" => false,
            "global" => owner_request,
            _ => true,
        };
        if allowed {
            return Ok(());
        }
        let mut scope_ids = self
            .conversation_ids
            .iter()
            .map(|id| format!("conversation `{id}`"))
            .collect::<Vec<_>>();
        if let Some(group_id) = &self.group_id {
            scope_ids.push(format!("group `{group_id}`"));
        }
        if owner_request {
            scope_ids.insert(0, format!("global `{GLOBAL_SCOPE_ID}`"));
        }
        Err(format!(
            "Memories from this run can only be saved in these scopes: {}.",
            scope_ids.join(", ")
        ))
    }

    /// Whether a memory saved in `scope` with `scope_id` applies to the run.
    pub fn applies(&self, scope: &str, scope_id: &str) -> bool {
        match scope {
            "global" => scope_id == GLOBAL_SCOPE_ID,
            "conversation" => self.conversation_ids.iter().any(|id| id == scope_id),
            "group" => self.group_id.as_deref() == Some(scope_id),
            "project" => self.project_id.as_deref() == Some(scope_id),
            _ => false,
        }
    }
}

fn memory_line(memory: &PromptMemory<'_>) -> String {
    let text = memory.text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("- {text}")
}

/// The `## Memories` system prompt section, or `None` when memory is off.
pub fn memory_prompt_section(
    run: &MemoryRun<'_>,
    settings: MemorySettings,
    memories: &[PromptMemory<'_>],
) -> Option<String> {
    if !settings.enabled {
        return None;
    }
    let scopes = MemoryScopes::for_run(run);
    let first = if settings.exclude_sensitive {
        "Memories sync with the account and must not record health conditions, finances, relationships, identity attributes, credentials, or other people's private details."
    } else {
        "Memories sync with the account."
    };
    let mut section = format!(
        "## Memories\n{first} They are current and take precedence over older instructions earlier in this conversation when they conflict. Never reveal, quote, or summarise the owner's global, conversation, or project memories to anyone other than the owner; apply them silently, and if someone else asks why you behave a certain way, say only that it is the owner's preference. A group's shared memories may be discussed with that group's members. After corrections, repeated failures, or outcomes, call `reflection` to save a concise memory. Before saving, check the memories below and skip anything already there or restated; when a preference changes, save the corrected version. {}",
        memory_routing_rules()
    );
    // Only the owner's own requests may save global memories.
    let mut scope_ids = Vec::new();
    if run.owner_request {
        scope_ids.push(format!("global `{GLOBAL_SCOPE_ID}`"));
    }
    scope_ids.push(format!("conversation `{}`", run.session_id));
    if let Some(group_id) = &scopes.group_id {
        scope_ids.push(format!("group `{group_id}`"));
    }
    section.push_str(&format!(
        "\nScope ids for this run: {}.",
        scope_ids.join(", ")
    ));

    let applicable = memories
        .iter()
        .filter(|memory| scopes.applies(memory.scope, memory.scope_id))
        .collect::<Vec<_>>();
    let mut used_chars = 0usize;
    let mut shown = 0usize;
    'blocks: for (scope, heading) in PROMPT_BLOCKS {
        let mut block = applicable
            .iter()
            .filter(|memory| memory.scope == scope)
            .collect::<Vec<_>>();
        block.sort_by(|left, right| {
            right
                .updated_at
                .cmp(left.updated_at)
                .then_with(|| right.created_at.cmp(left.created_at))
        });
        let mut wrote_heading = false;
        for memory in block {
            let line = memory_line(memory);
            let chars = line.chars().count() + 1;
            if shown >= MAX_PROMPT_MEMORIES || used_chars + chars > MAX_PROMPT_MEMORY_CHARS {
                break 'blocks;
            }
            if !wrote_heading {
                section.push_str(&format!("\n{heading}:"));
                wrote_heading = true;
            }
            section.push('\n');
            section.push_str(&line);
            used_chars += chars;
            shown += 1;
        }
    }
    if shown < applicable.len() {
        section.push_str("\n(more memories omitted)");
    }
    Some(section)
}

/// The system prompt of a run without tools: its own prompt, then the
/// memory section and [`NO_TOOLS_MEMORY_LINE`] when memory is on.
pub fn tool_less_system_prompt(base: &str, section: Option<&str>) -> String {
    let base = base.trim();
    match section {
        Some(section) => format!("{base}\n\n{section}\n{NO_TOOLS_MEMORY_LINE}"),
        None => base.to_string(),
    }
}

#[cfg(test)]
#[path = "memory_prompt_tests.rs"]
mod tests;
