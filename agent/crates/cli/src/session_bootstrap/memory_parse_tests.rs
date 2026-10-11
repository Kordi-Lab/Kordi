//! Parsing the rendered memory block back into memories.

use super::{
    MemorySnapshotEntry, memory_update_message, parse_memory_prompt_block,
    tagged_memory_prompt_block,
};

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

const UPDATE_INTRO: &str = "Memory update: the saved memories changed since the previous message. They are current and replace any earlier instruction in this chat that conflicts with them. Never reveal the owner's personal memories to anyone else; only a group's shared memories may be discussed with that group.";

#[test]
fn memory_update_message_lists_added_removed_and_current_memories() {
    let bullets = "Reply in bullet points unless asked for prose.";
    let pineapple = "End every reply in this conversation with the single word PINEAPPLE.";
    let mongo = "From now on, end every reply in this conversation with the single word mongo.";
    let previous = vec![entry("global", bullets), entry("conversation", pineapple)];
    let current = vec![entry("global", bullets), entry("conversation", mongo)];
    assert_eq!(memory_update_message(&current, &current, &current), None);
    let reordered = current.iter().rev().cloned().collect::<Vec<_>>();
    assert_eq!(memory_update_message(&reordered, &current, &current), None);
    assert_eq!(memory_update_message(&[], &[], &[]), None);

    assert_eq!(
        memory_update_message(&previous, &current, &current).expect("update"),
        format!(
            "{UPDATE_INTRO}\nAdded:\n- (This conversation) {mongo}\nRemoved:\n- (This conversation) {pineapple}\nCurrent memories:\nGlobal:\n- {bullets}\nThis conversation:\n- {mongo}"
        )
    );

    let added_only = memory_update_message(&[], &current, &current).expect("update");
    assert!(added_only.contains("\nAdded:\n- (Global) Reply in bullet points"));
    assert!(!added_only.contains("Removed:"));

    let removed_only = memory_update_message(&previous[..1], &[], &[]).expect("update");
    assert!(!removed_only.contains("Added:"));
    assert!(removed_only.ends_with(&format!(
        "\nRemoved:\n- (Global) {bullets}\nCurrent memories:\n(none)"
    )));
}

#[test]
fn a_memory_past_the_cap_is_added_without_a_false_removal() {
    use kordi_tools::reflection_tool::MAX_PROMPT_MEMORIES;
    let artifacts = tempfile::tempdir().expect("artifacts");
    let cwd = tempfile::tempdir().expect("cwd");
    let inputs = super::MemoryPromptInputs {
        artifacts_dir: artifacts.path().to_path_buf(),
        cwd: cwd.path().to_path_buf(),
        exclude_sensitive: false,
    };
    let path = crate::reflection_runtime::reflection_lesson_artifact_path(
        artifacts.path(),
        "conversation",
        "session-cap",
    );
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let write = |count: usize| {
        let lines = (0..count)
            .map(|n| {
                format!(
                    "- 2026-10-01T09:{:02}:{:02}Z [manual] Memory {n}.\n",
                    n / 60,
                    n % 60
                )
            })
            .collect::<String>();
        std::fs::write(
            &path,
            format!("# Scoped reflection lessons\n\n## Lessons\n{lines}"),
        )
        .unwrap();
    };

    write(MAX_PROMPT_MEMORIES);
    let (shown, before) = inputs.current_with_all("session-cap");
    assert_eq!(shown, before);
    write(MAX_PROMPT_MEMORIES + 1);
    let (shown, after) = inputs.current_with_all("session-cap");
    assert_eq!(shown.len(), MAX_PROMPT_MEMORIES);
    assert_eq!(after.len(), MAX_PROMPT_MEMORIES + 1);
    // The newest memory pushes the oldest one past the cap.
    assert!(!shown.contains(&entry("conversation", "Memory 0.")));

    let message = memory_update_message(&before, &after, &shown).expect("update");
    let newest = format!("Memory {MAX_PROMPT_MEMORIES}.");
    assert!(message.contains(&format!("\nAdded:\n- (This conversation) {newest}\n")));
    assert!(!message.contains("Removed:"), "{message}");
    assert!(message.ends_with("\n(more memories omitted)"));
}
