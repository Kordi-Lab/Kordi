use kordi_cli::skill_library::SkillLibraryEntry;
use std::fs;
#[cfg(test)]
use std::path::Path;
use tauri::State;

use super::{now_millis, DesktopChatManager, DesktopSessionHandle};

const SESSION_PREFIX: &str = "session:agent-builder:";
const WORKSPACE_DIR: &str = "workspace";
const RESOURCES_DIR: &str = "resources";
const METADATA_FILE: &str = "builder.json";
const AGENT_FILE: &str = "agent.json";
const PROMPT_FILE: &str = "SYSTEM_PROMPT.md";
const TEST_REPORT_FILE: &str = "test-report.json";
const MAX_AGENT_BYTES: u64 = 128 * 1024;
const MAX_PROMPT_BYTES: u64 = 96 * 1024;
const MAX_SKILL_BYTES: u64 = 96 * 1024;
const MAX_SKILL_SUPPORT_FILE_BYTES: u64 = 512 * 1024;
const MAX_SKILL_BUNDLE_FILES: usize = 64;
const MAX_SKILLS: usize = 24;
const MAX_AGENT_NAME_CHARS: usize = 120;
const MAX_TOOLS: usize = 48;
const MAX_PLUGINS: usize = 24;
const MAX_FINGERPRINT_FILES: usize = 128;
const MAX_FINGERPRINT_BYTES: u64 = 2 * 1024 * 1024;

const BUILDER_SYSTEM_PROMPT: &str = r#"You are Kordi Factory, a persistent creation workspace for building and refining real Kordi resources.

The workspace is private to the current build. You can create or refine agent definitions, prompts, skills, tool and plugin selections, workflow instructions, and supporting draft files allowed by the workspace format. Use the agent-creator and skill-creator skills when their focused workflows apply. Read the current files before changing them, then use the provided file tools to implement the user's request. The tools available to this Factory conversation are not the candidate agent's runtime tool catalog; do not report a candidate capability as unavailable merely because you cannot use it while editing the draft. Do not return JSON-only proposals and do not pretend that a change is complete before writing it.

You may edit only files inside this workspace. Never request or expose credentials. Keep all product copy and generated configuration in English. Keep permissions and tools as narrow as possible. Kordi validates and tests the draft outside this conversation; never claim that validation, a runtime test, or publishing succeeded unless the corresponding result is visible in the conversation context.

After each change, briefly list the files changed and tell the user whether the draft is ready to validate and test."#;

const AGENT_CREATOR_SKILL: &str = include_str!("agent_builder_resources/agent-creator/SKILL.md");
const SKILL_CREATOR_SKILL: &str = include_str!("agent_builder_resources/skill-creator/SKILL.md");

pub mod catalog;
mod models;

#[cfg(test)]
use self::catalog::{
    artifact_kind_from_target, deduplicate_builder_summaries, fallback_name_from_target,
    is_untouched_creation,
};
use self::models::DesktopAgentBuilderMetadata;
#[cfg(test)]
use self::models::DesktopAgentBuilderSkillFile;
pub use self::models::{
    DesktopAgentBuilderDraft, DesktopAgentBuilderFileStatus, DesktopAgentBuilderOpenResult,
    DesktopAgentBuilderSeed, DesktopAgentBuilderSkillDraft, DesktopAgentBuilderSkillSeed,
    DesktopAgentBuilderStatus, DesktopAgentBuilderSummary, DesktopAgentBuilderTestReport,
    DesktopAgentBuilderValidation,
};

mod storage;

use self::storage::{
    all_builder_associations, associate_builder, builder_mutation_lock, container_for_draft,
    draft_container, drafts_root, load_metadata, new_metadata, read_test_report,
    remove_builder_association, resolve_builder, retarget_builder, test_report_path,
    workspace_for_draft, write_json, write_metadata,
};
#[cfg(test)]
use self::storage::{metadata_path, resolve_builder_in, resources_root};

mod validation;

#[cfg(test)]
use self::validation::{frontmatter_field, frontmatter_name, skill_path, workspace_fingerprint};
use self::validation::{read_limited, validate_workspace};

mod workspace;

#[cfg(test)]
use self::workspace::is_canonical_skill_file_path;
use self::workspace::{
    atomically_update_workspace, canonical_skill_path, checked_draft_file_path, clean_slug,
    ensure_expected_fingerprint, is_safe_relative_path, is_skill_bundle_file_path,
    materialize_builder_skills, materialize_seed, migrate_legacy_workspace, write_draft,
};

mod runtime;

pub(super) use self::runtime::{is_agent_builder_session_id, resume_agent_builder_runtime};
use self::runtime::{load_or_create_runtime, run_draft_smoke_test};

mod publishing;

fn status_from_metadata(
    metadata: &DesktopAgentBuilderMetadata,
) -> Result<DesktopAgentBuilderStatus, String> {
    let container = container_for_draft(&metadata.draft_id)?;
    let workspace = workspace_for_draft(&metadata.draft_id)?;
    let (draft, validation) = validate_workspace(&workspace);
    let test_report = read_test_report(&container);
    let publish_ready = validated_draft_is_publish_ready(&metadata.status, validation.valid);
    Ok(DesktopAgentBuilderStatus {
        draft_id: metadata.draft_id.clone(),
        target_key: metadata.target_key.clone(),
        session_id: metadata.session_id.clone(),
        workspace_path: workspace.display().to_string(),
        lifecycle: metadata.status.clone(),
        draft,
        validation,
        test_report,
        publish_ready,
    })
}

fn validated_draft_is_publish_ready(status: &str, validation_valid: bool) -> bool {
    status == "draft" && validation_valid
}

#[tauri::command]
pub async fn desktop_agent_builder_status(
    draft_id: String,
) -> Result<DesktopAgentBuilderStatus, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let (_, metadata) = load_metadata(&draft_id)?;
    status_from_metadata(&metadata)
}

#[tauri::command]
pub async fn desktop_agent_builder_read_file(
    draft_id: String,
    path: String,
) -> Result<String, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let (workspace, _) = load_metadata(&draft_id)?;
    let file_path = checked_draft_file_path(&workspace, &path)?;
    read_limited(
        &file_path,
        MAX_AGENT_BYTES.max(MAX_PROMPT_BYTES).max(MAX_SKILL_BYTES),
    )
}

#[tauri::command]
pub async fn desktop_agent_builder_write_file(
    draft_id: String,
    path: String,
    content: String,
    expected_fingerprint: String,
) -> Result<DesktopAgentBuilderStatus, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let (workspace, mut metadata) = load_metadata(&draft_id)?;
    if metadata.status != "draft" {
        return Err("Only an active draft can be edited".to_string());
    }
    if content.len() as u64
        > MAX_AGENT_BYTES
            .max(MAX_PROMPT_BYTES)
            .max(MAX_SKILL_SUPPORT_FILE_BYTES)
    {
        return Err("Kordi Factory file is too large".to_string());
    }
    atomically_update_workspace(&workspace, &expected_fingerprint, |staged| {
        let file_path = checked_draft_file_path(staged, &path)?;
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
        }
        fs::write(&file_path, content)
            .map_err(|error| format!("Unable to write {}: {error}", file_path.display()))
    })?;
    metadata.updated_at_ms = now_millis();
    write_metadata(&workspace, &metadata)?;
    status_from_metadata(&metadata)
}

#[tauri::command]
pub async fn desktop_agent_builder_update_draft(
    draft_id: String,
    draft: DesktopAgentBuilderDraft,
    expected_fingerprint: String,
) -> Result<DesktopAgentBuilderStatus, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let (workspace, mut metadata) = load_metadata(&draft_id)?;
    if metadata.status != "draft" {
        return Err("Only an active draft can be edited".to_string());
    }
    atomically_update_workspace(&workspace, &expected_fingerprint, |staged| {
        write_draft(staged, draft)
    })?;
    metadata.updated_at_ms = now_millis();
    write_metadata(&workspace, &metadata)?;
    status_from_metadata(&metadata)
}

#[tauri::command]
pub async fn desktop_agent_builder_test(
    draft_id: String,
    expected_fingerprint: String,
) -> Result<DesktopAgentBuilderStatus, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let (workspace, metadata) = load_metadata(&draft_id)?;
    if metadata.status != "draft" {
        return Err("Only an active draft can be tested".to_string());
    }
    ensure_expected_fingerprint(&workspace, &expected_fingerprint)?;
    let (draft, validation) = validate_workspace(&workspace);
    let mut report = DesktopAgentBuilderTestReport {
        passed: false,
        fingerprint: validation.fingerprint.clone(),
        summary: validation.errors.join(" "),
        tested_at_ms: now_millis(),
    };
    drop(_mutation_guard);
    if validation.valid {
        let draft = draft.ok_or_else(|| "Validated draft is unavailable".to_string())?;
        match run_draft_smoke_test(&workspace, &draft).await {
            Ok(summary) => {
                report.passed = true;
                report.summary = format!("Runtime responded successfully: {summary}");
            }
            Err(error) => report.summary = error,
        }
    }
    let _mutation_guard = builder_mutation_lock().lock().await;
    ensure_expected_fingerprint(&workspace, &validation.fingerprint)?;
    let (_, current_metadata) = load_metadata(&draft_id)?;
    if current_metadata.status != "draft" {
        return Err("Only an active draft can be tested".to_string());
    }
    write_json(&test_report_path(draft_container(&workspace)?), &report)?;
    status_from_metadata(&current_metadata)
}

#[tauri::command]
pub async fn desktop_agent_builder_mark_published(
    draft_id: String,
    expected_fingerprint: String,
) -> Result<DesktopAgentBuilderStatus, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    publishing::mark_published(&draft_id, &expected_fingerprint)
}

#[tauri::command]
pub async fn desktop_agent_builder_install_skill(
    manager: State<'_, DesktopChatManager>,
    draft_id: String,
    skill_name: String,
    scope: String,
    expected_fingerprint: String,
) -> Result<SkillLibraryEntry, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    publishing::install_skill(
        &manager,
        &draft_id,
        &skill_name,
        &scope,
        &expected_fingerprint,
    )
    .await
}

#[tauri::command]
pub async fn desktop_agent_builder_discard(
    manager: State<'_, DesktopChatManager>,
    draft_id: String,
    expected_fingerprint: String,
) -> Result<(), String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let (workspace, mut metadata) = load_metadata(&draft_id)?;
    ensure_expected_fingerprint(&workspace, &expected_fingerprint)?;
    metadata.status = "discarded".to_string();
    metadata.updated_at_ms = now_millis();
    write_metadata(&workspace, &metadata)?;
    remove_builder_association(&metadata)?;
    manager.sessions.lock().await.remove(&metadata.session_id);
    kordi_cli::desktop_runtime::delete_session_forever(&metadata.session_id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests;
