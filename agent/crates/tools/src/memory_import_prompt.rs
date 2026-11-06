//! The prompt that reads one of a person's agent instruction files into
//! memories. The Mac's import turn (`memory_import_run.rs` in the desktop
//! app) and the server's extraction for the browser app use the same system
//! prompt, user prompt, and per-file cap.

/// How many existing memories, and how much of each, go into the prompt.
const EXISTING_LIMIT: usize = 60;
const EXISTING_CHARS: usize = 200;

/// The most memories one file may add.
pub const MAX_MEMORIES_PER_FILE: usize = 12;

pub const MEMORY_IMPORT_SYSTEM_PROMPT: &str = "\
You turn a person's own agent instruction files into memories.
You receive the full text of one or more of these files, each with its path and project, and the memories the person already has.
Return JSON only, with no prose and no code fence, in this shape:
{\"memories\":[{\"text\":\"...\",\"category\":\"...\",\"scope\":\"project\",\"file\":\"<path as given>\"}]}
Rules:
- Repository conventions, workflow rules, and tool and command habits: category \"hcp-custom:task_lessons\", scope \"project\" (the file's project).
- Personal preferences that apply everywhere, such as language, tone, units, or formatting the person always wants: category \"general_preferences\", scope \"global\".
- Facts about the person's work, such as role, projects, or skills: category \"work_context\", scope \"project\".
- Skip anything that is not durable, anything about other people, credentials, secrets, paths, hostnames, or infrastructure identifiers.
- Skip anything already present in the existing memories, even when worded differently.
- Claude Code memory files start with a frontmatter block (name, description, type user, feedback, project, or reference): a user entry is about the person (a global preference or a work fact), a feedback entry is a working rule (a task lesson in the project, or global when it is not about one project), project entries stay in the project, and reference entries, such as links or tickets, are skipped.
- Write each memory as one plain sentence. At most 12 memories per file.
- If nothing qualifies, return {\"memories\":[]}.";

/// The existing memory texts, capped, one per line.
fn existing_block(existing: &[String]) -> String {
    let lines: Vec<String> = existing
        .iter()
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
        .take(EXISTING_LIMIT)
        .map(|text| {
            format!(
                "- {}",
                text.chars().take(EXISTING_CHARS).collect::<String>()
            )
        })
        .collect();
    if lines.is_empty() {
        "(none)".to_string()
    } else {
        lines.join("\n")
    }
}

/// The user prompt for one file: the existing memories (capped), then the
/// file's app, path, project, and text.
pub fn import_prompt(
    source: &str,
    path: &str,
    project_name: &str,
    text: &str,
    existing: &[String],
) -> String {
    format!(
        "Existing memories:\n{}\n\nApp: {}\nFile: {}\nProject: {}\n<<<FILE\n{}\nFILE>>>",
        existing_block(existing),
        source,
        path,
        project_name,
        text.trim(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_import_prompt_carries_the_file_and_capped_existing_memories() {
        let existing: Vec<String> = (0..80)
            .map(|index| format!("Memory {index} {}", "y".repeat(300)))
            .collect();
        let prompt = import_prompt(
            "Project file",
            "/work/launch-site/AGENTS.md",
            "launch-site",
            "  Use pnpm.\n",
            &existing,
        );
        assert!(prompt.contains(
            "File: /work/launch-site/AGENTS.md\nProject: launch-site\n<<<FILE\nUse pnpm.\nFILE>>>"
        ));
        assert_eq!(prompt.matches("\n- Memory ").count(), 60);
        assert!(
            !prompt.contains(&"y".repeat(200)),
            "each memory is capped at 200 characters"
        );
        assert!(import_prompt("App", "f", "p", "x", &[]).contains("Existing memories:\n(none)"));
        assert!(MEMORY_IMPORT_SYSTEM_PROMPT.contains("hcp-custom:task_lessons"));
        assert!(prompt.contains("App: Project file\nFile: "));
        assert!(
            MEMORY_IMPORT_SYSTEM_PROMPT
                .contains("reference entries, such as links or tickets, are skipped")
        );
        assert!(MEMORY_IMPORT_SYSTEM_PROMPT.contains("At most 12 memories per file."));
    }
}
