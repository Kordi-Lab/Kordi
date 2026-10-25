//! Reads one agent instruction file into memories (Settings › Memory › Import).
//!
//! Like a digest run, it runs one turn in a throwaway profiled session with
//! this Mac's provider, a fixed system prompt, and no tools. The reply is the
//! model's JSON, which the caller parses and saves; nothing is saved here.

use std::path::{Path, PathBuf};

use kordi_cli::desktop_runtime::{DesktopRuntimeProfile, DesktopRuntimeSession};
use kordi_tools::ExecutionPolicy;

use super::digest_run::attempt_routes;
use super::hosted_provider_auth::route_uses_hosted_auth;
use super::memory_import::{
    chosen_agent_file, discover_agent_files, known_project_roots, AgentInstructionFile,
};
use super::message_route::apply_desktop_chat_message_route;
use super::DesktopChatMessageRoute;

/// How many existing memories, and how much of each, go into the prompt.
const EXISTING_LIMIT: usize = 60;
const EXISTING_CHARS: usize = 200;

pub(crate) const MEMORY_IMPORT_SYSTEM_PROMPT: &str = "\
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

pub(crate) fn import_prompt(
    file: &AgentInstructionFile,
    text: &str,
    existing: &[String],
) -> String {
    format!(
        "Existing memories:\n{}\n\nApp: {}\nFile: {}\nProject: {}\n<<<FILE\n{}\nFILE>>>",
        existing_block(existing),
        file.source,
        file.path,
        file.project_name,
        text.trim(),
    )
}

/// The discovered file at `path`, or a file the person chose that passes
/// `chosen_agent_file`; any other path is refused.
fn importable_file(path: &str) -> Result<AgentInstructionFile, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match discover_agent_files(&known_project_roots(), home.as_deref())
        .into_iter()
        .find(|file| file.path == path)
    {
        Some(file) => Ok(file),
        None => chosen_agent_file(Path::new(path), home.as_deref()),
    }
}

/// Runs one import turn for the agent file at `path` and returns the model's
/// reply. `route` is this Mac's chat route, resolved as for a digest run on
/// this Mac: the chosen model first, then the provider's fast model.
#[tauri::command]
pub async fn desktop_memory_import_extract(
    path: String,
    existing_memories: Vec<String>,
    route: Option<DesktopChatMessageRoute>,
    fallback_model: Option<String>,
) -> Result<String, String> {
    let file = tauri::async_runtime::spawn_blocking(move || importable_file(&path))
        .await
        .map_err(|error| error.to_string())??;
    let text =
        std::fs::read_to_string(&file.path).map_err(|_| "Could not read this file.".to_string())?;
    // A hosted account's credentials are released only for a run the server
    // admitted, and an import is not one.
    if route_uses_hosted_auth(route.as_ref()) {
        return Err(HOSTED_ROUTE_UNAVAILABLE.to_string());
    }
    let prompt = import_prompt(&file, &text, &existing_memories);
    let workspace = std::env::temp_dir().join("kordi-memory-imports");
    std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    let routes: Vec<Option<DesktopChatMessageRoute>> = match route {
        Some(route) => attempt_routes(route, fallback_model)
            .into_iter()
            .map(Some)
            .collect(),
        None => vec![None],
    };
    let mut failure = String::new();
    for route in routes {
        match import_turn(&workspace, &prompt, route.as_ref()).await {
            Ok(reply) => return Ok(reply),
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

pub(crate) const HOSTED_ROUTE_UNAVAILABLE: &str = "Import needs a provider signed in on this Mac.";

/// One import turn with `route` in a throwaway session.
async fn import_turn(
    workspace: &Path,
    prompt: &str,
    route: Option<&DesktopChatMessageRoute>,
) -> Result<String, String> {
    let profile = DesktopRuntimeProfile {
        provider: route.and_then(|route| route.auth_provider.clone()),
        model: route.and_then(|route| route.model.clone()),
        thinking: Some("low".to_string()),
        system_prompt: Some(MEMORY_IMPORT_SYSTEM_PROMPT.to_string()),
        // No tools: the file text is in the prompt.
        tool_names: Some(Vec::new()),
        execution_policy: Some(ExecutionPolicy::Safety),
        ..DesktopRuntimeProfile::default()
    };
    let session_id = format!("session:memory-import:{}", uuid::Uuid::new_v4());
    let result = async {
        let mut runtime = DesktopRuntimeSession::create_profiled_with_id(
            workspace.to_path_buf(),
            &session_id,
            profile,
        )
        .await
        .map_err(|error| error.to_string())?;
        apply_desktop_chat_message_route(&mut runtime, route)?;
        let detail = runtime
            .send_message(prompt.to_string(), Vec::new())
            .await
            .map_err(|error| error.to_string())?;
        detail
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
            .map(|message| message.text.clone())
            .ok_or_else(|| "The model finished without an answer.".to_string())
    }
    .await;
    let _ = kordi_cli::desktop_runtime::delete_session_forever(&session_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_import_prompt_carries_the_file_and_capped_existing_memories() {
        let file = AgentInstructionFile {
            path: "/work/launch-site/AGENTS.md".into(),
            root: Some("/work/launch-site".into()),
            project_name: "launch-site".into(),
            file_name: "AGENTS.md".into(),
            source: "Project file".into(),
            size: 10,
            modified_at: 1,
        };
        let existing: Vec<String> = (0..80)
            .map(|index| format!("Memory {index} {}", "y".repeat(300)))
            .collect();
        let prompt = import_prompt(&file, "  Use pnpm.\n", &existing);
        assert!(prompt.contains(
            "File: /work/launch-site/AGENTS.md\nProject: launch-site\n<<<FILE\nUse pnpm.\nFILE>>>"
        ));
        assert_eq!(prompt.matches("\n- Memory ").count(), 60);
        assert!(
            !prompt.contains(&"y".repeat(200)),
            "each memory is capped at 200 characters"
        );
        assert!(import_prompt(&file, "x", &[]).contains("Existing memories:\n(none)"));
        assert!(MEMORY_IMPORT_SYSTEM_PROMPT.contains("hcp-custom:task_lessons"));
        assert!(prompt.contains("App: Project file\nFile: "));
        assert!(MEMORY_IMPORT_SYSTEM_PROMPT
            .contains("reference entries, such as links or tickets, are skipped"));
    }
}
