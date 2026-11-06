//! Reads one agent instruction file into memories (Settings › Memory › Import).
//!
//! Like a digest run, it runs one turn in a throwaway profiled session with
//! this Mac's provider, a fixed system prompt, and no tools. A hosted account
//! runs under the import run the caller claimed (`memoryImportRuns.ts`), whose
//! credentials resolve exactly as for a claimed digest run. The reply is the
//! model's JSON, which the caller parses and saves; nothing is saved here.

use std::path::{Path, PathBuf};

use kordi_cli::desktop_runtime::{DesktopRuntimeProfile, DesktopRuntimeSession};
use kordi_tools::ExecutionPolicy;

use super::digest_run::attempt_routes;
use super::hosted_provider_auth::{resolve_for_lease, route_uses_hosted_auth, HostedTurnAuth};
use super::memory_import::{
    chosen_agent_file, discover_agent_files, known_project_roots, AgentInstructionFile,
};
use super::message_route::apply_desktop_chat_message_route;
use super::DesktopChatMessageRoute;

use kordi_tools::memory_import_prompt;

pub(crate) use kordi_tools::memory_import_prompt::MEMORY_IMPORT_SYSTEM_PROMPT;

pub(crate) fn import_prompt(
    file: &AgentInstructionFile,
    text: &str,
    existing: &[String],
) -> String {
    memory_import_prompt::import_prompt(
        &file.source,
        &file.path,
        &file.project_name,
        text,
        existing,
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

/// The execution lease this Mac holds for a claimed import run.
fn lease(
    run_id: &str,
    claim_id: &str,
    owner_account_id: &str,
) -> Result<kordi_cli::desktop_runtime::DesktopCloudExecutionLease, String> {
    serde_json::from_value(serde_json::json!({
        "sessionId": format!("memory-import:{owner_account_id}"),
        "runId": run_id,
        "claimId": claim_id,
        "ownerAccountId": owner_account_id,
    }))
    .map_err(|error| error.to_string())
}

/// A hosted account's short-lived credentials for the claimed import run.
async fn hosted_auth_for_run(
    route: &DesktopChatMessageRoute,
    run_id: Option<&str>,
    claim_id: Option<&str>,
) -> Result<HostedTurnAuth, String> {
    let (Some(run_id), Some(claim_id)) = (
        run_id.map(str::trim).filter(|value| !value.is_empty()),
        claim_id.map(str::trim).filter(|value| !value.is_empty()),
    ) else {
        return Err(HOSTED_ROUTE_UNAVAILABLE.to_string());
    };
    let session = crate::cloud_session::cloud_session_load()?
        .filter(|session| !session.token.is_empty())
        .ok_or_else(|| "Sign in to Kordi to import.".to_string())?;
    resolve_for_lease(route, &lease(run_id, claim_id, &session.account_id)?).await
}

/// Runs one import turn for the agent file at `path` and returns the model's
/// reply. `route` is this Mac's chat route, resolved as for a digest run on
/// this Mac: the chosen model first, then the provider's fast model. A hosted
/// route needs the claimed import run's `run_id` and `claim_id`.
#[tauri::command]
pub async fn desktop_memory_import_extract(
    path: String,
    existing_memories: Vec<String>,
    route: Option<DesktopChatMessageRoute>,
    fallback_model: Option<String>,
    run_id: Option<String>,
    claim_id: Option<String>,
) -> Result<String, String> {
    let file = tauri::async_runtime::spawn_blocking(move || importable_file(&path))
        .await
        .map_err(|error| error.to_string())??;
    let text =
        std::fs::read_to_string(&file.path).map_err(|_| "Could not read this file.".to_string())?;
    // A hosted account has no credential on this Mac: the server hands over
    // short-lived material for the claimed import run, as for a digest run.
    let hosted_auth = match route.as_ref() {
        Some(route) if route_uses_hosted_auth(Some(route)) => {
            Some(hosted_auth_for_run(route, run_id.as_deref(), claim_id.as_deref()).await?)
        }
        _ => None,
    };
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
        match import_turn(&workspace, &prompt, route.as_ref(), hosted_auth.clone()).await {
            Ok(reply) => return Ok(reply),
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

pub(crate) const HOSTED_ROUTE_UNAVAILABLE: &str = "Import needs a run for this account. Try again.";

/// One import turn with `route` in a throwaway session.
async fn import_turn(
    workspace: &Path,
    prompt: &str,
    route: Option<&DesktopChatMessageRoute>,
    hosted_auth: Option<HostedTurnAuth>,
) -> Result<String, String> {
    let hosted = hosted_auth.is_some();
    let profile = DesktopRuntimeProfile {
        provider: route
            .filter(|_| !hosted)
            .and_then(|route| route.auth_provider.clone()),
        model: route
            .filter(|_| !hosted)
            .and_then(|route| route.model.clone()),
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
        if let Some(auth) = hosted_auth {
            runtime
                .set_ephemeral_provider_auth_with_options(
                    &auth.provider,
                    auth.auth,
                    auth.base_url,
                    auth.api.as_deref(),
                )
                .map_err(|error| error.to_string())?;
        }
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
    fn memory_import_lease_names_the_claimed_run() {
        let lease = lease("import_1", "claim_1", "acct_owner").expect("lease");
        assert_eq!(lease.run_id, "import_1");
        assert_eq!(lease.claim_id, "claim_1");
        assert_eq!(lease.owner_account_id, "acct_owner");
    }

    #[test]
    fn memory_import_prompt_names_the_file_app_and_project() {
        let file = AgentInstructionFile {
            path: "/work/launch-site/AGENTS.md".into(),
            root: Some("/work/launch-site".into()),
            project_name: "launch-site".into(),
            file_name: "AGENTS.md".into(),
            source: "Project file".into(),
            size: 10,
            modified_at: 1,
        };
        let prompt = import_prompt(&file, "  Use pnpm.\n", &[]);
        assert!(prompt.contains(
            "App: Project file\nFile: /work/launch-site/AGENTS.md\nProject: launch-site\n<<<FILE\nUse pnpm.\nFILE>>>"
        ));
        assert!(MEMORY_IMPORT_SYSTEM_PROMPT.contains("hcp-custom:task_lessons"));
    }
}
