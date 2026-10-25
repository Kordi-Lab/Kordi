//! Wording of the Mac `## Memories` system prompt section.

use kordi_tools::memory_categories::memory_routing_rules;

/// Who may hear about which memories, in the prompt section.
const MEMORY_DISCLOSURE_RULE: &str = "Never reveal, quote, or summarise the owner's global, conversation, or project memories to anyone other than the owner; apply them silently, and if someone else asks why you behave a certain way, say only that it is the owner's preference. A group's shared memories may be discussed with that group's members.";

/// The opening line of the section.
const MEMORY_SECTION_INTRO: &str = "These are the user's saved memories for this account and conversation. They are current and take precedence over older instructions earlier in this conversation when they conflict.";

/// When and how to save, before the routing rules.
const MEMORY_SAVE_RULE: &str = "After corrections, repeated failures, or outcomes, report the update and call `reflection` to save a concise memory. Before saving, read that scope's artifact and skip anything already there or restated; when a preference changes, save the corrected version.";

/// Added when the account keeps sensitive details out of memories.
const MEMORY_SENSITIVE_RULE: &str = "Memories must not record health conditions, finances, relationships, identity attributes, credentials, or other people's private details.";

/// The section heading and rules, before the memory lines.
pub(super) fn memory_section_rules(exclude_sensitive: bool) -> String {
    let mut rules = format!(
        "\n\n## Memories\n{MEMORY_SECTION_INTRO} {MEMORY_DISCLOSURE_RULE} {MEMORY_SAVE_RULE} {}",
        memory_routing_rules()
    );
    if exclude_sensitive {
        rules.push(' ');
        rules.push_str(MEMORY_SENSITIVE_RULE);
    }
    rules
}
