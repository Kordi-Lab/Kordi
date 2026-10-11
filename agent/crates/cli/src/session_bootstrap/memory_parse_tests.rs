//! Parsing the rendered memory block back into memories.

use super::{MemorySnapshotEntry, parse_memory_prompt_block, tagged_memory_prompt_block};

fn entry(scope: &str, text: &str) -> MemorySnapshotEntry {
    MemorySnapshotEntry {
        scope: scope.to_string(),
        heading: super::memory_scope_heading(scope),
        text: text.to_string(),
    }
}

const SECTION: &str = "\n\n## Memories\nThese are the user's saved memories. Use `global` only for preferences the user wants everywhere (\"from now on\", \"always\").\nGlobal:\n- Reply briefly.\n- Use metric units.\nThis conversation:\n- End with PINEAPPLE.\nThis project:\n- Run the tests first.\nThis group:\n- Start every reply with Hi team.\nArtifacts:\n- Global scope `global`: /tmp/global.md\n- Group scope `gs-1` (pass this exact scopeId to save a group memory): /tmp/group.md";

#[test]
fn parses_all_four_headings_in_order() {
    let prompt = format!("Base prompt{}", tagged_memory_prompt_block(SECTION));
    assert_eq!(
        parse_memory_prompt_block(&prompt),
        vec![
            entry("global", "Reply briefly."),
            entry("global", "Use metric units."),
            entry("conversation", "End with PINEAPPLE."),
            entry("project", "Run the tests first."),
            entry("group", "Start every reply with Hi team."),
        ]
    );
}

#[test]
fn ignores_artifacts_and_the_omitted_marker() {
    let section = "## Memories\nIntro.\nGlobal:\n- Keep it short.\n(more memories omitted)\nArtifacts:\n- Global scope `global`: /tmp/global.md\n- Conversation scope `c`: /tmp/c.md";
    assert_eq!(
        parse_memory_prompt_block(&tagged_memory_prompt_block(section)),
        vec![entry("global", "Keep it short.")]
    );
}

#[test]
fn normalizes_whitespace_and_skips_text_outside_the_block() {
    let prompt = format!(
        "Global:\n- Not a memory, outside the block.{}\nThis group:\n- Also outside.",
        tagged_memory_prompt_block(
            "## Memories\n  This group:  \n-   Say   Hi team.  \n\nArtifacts:"
        )
    );
    assert_eq!(
        parse_memory_prompt_block(&prompt),
        vec![entry("group", "Say Hi team.")]
    );
}

#[test]
fn empty_when_there_is_no_memory_line() {
    assert!(parse_memory_prompt_block("").is_empty());
    assert!(
        parse_memory_prompt_block(&tagged_memory_prompt_block(
            "## Memories\nIntro.\nArtifacts:\n- Global scope `global`: /tmp/g.md"
        ))
        .is_empty()
    );
}
