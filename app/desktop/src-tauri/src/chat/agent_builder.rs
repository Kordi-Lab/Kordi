use kordi_cli::skill_library::{
    self, SkillBundle, SkillBundleFile, SkillInstallScope, SkillLibraryEntry,
};
use std::fs;
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
const MAX_TOOLS: usize = 48;
const MAX_PLUGINS: usize = 24;
const MAX_FINGERPRINT_FILES: usize = 128;
const MAX_FINGERPRINT_BYTES: u64 = 2 * 1024 * 1024;

const BUILDER_SYSTEM_PROMPT: &str = r#"You are Kordi Factory, a persistent creation workspace for building and refining real Kordi resources.

The workspace is private to the current build. You can create or refine agent definitions, prompts, skills, tool and plugin selections, workflow instructions, and supporting draft files allowed by the workspace format. Use the agent-creator and skill-creator skills when their focused workflows apply. Read the current files before changing them, then use the provided file tools to implement the user's request. Do not return JSON-only proposals and do not pretend that a change is complete before writing it.

You may edit only files inside this workspace. Never request or expose credentials. Keep all product copy and generated configuration in English. Keep permissions and tools as narrow as possible. Kordi validates and tests the draft outside this conversation; never claim that validation, a runtime test, or publishing succeeded unless the corresponding result is visible in the conversation context.

After each change, briefly list the files changed and tell the user whether the draft is ready to validate and test."#;

const AGENT_CREATOR_SKILL: &str = include_str!("agent_builder_resources/agent-creator/SKILL.md");
const SKILL_CREATOR_SKILL: &str = include_str!("agent_builder_resources/skill-creator/SKILL.md");

mod models;

use self::models::DesktopAgentBuilderMetadata;
#[cfg(test)]
use self::models::DesktopAgentBuilderSkillFile;
pub use self::models::{
    DesktopAgentBuilderDraft, DesktopAgentBuilderFileStatus, DesktopAgentBuilderOpenResult,
    DesktopAgentBuilderSeed, DesktopAgentBuilderSkillDraft, DesktopAgentBuilderSkillSeed,
    DesktopAgentBuilderStatus, DesktopAgentBuilderTestReport, DesktopAgentBuilderValidation,
};

mod storage;

#[cfg(test)]
use self::storage::resources_root;
use self::storage::{
    builder_mutation_lock, container_for_draft, draft_container, drafts_root, find_active_draft,
    load_metadata, new_metadata, read_test_report, test_report_path, workspace_for_draft,
    write_json, write_metadata,
};

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

fn collect_skill_bundle_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<SkillBundleFile>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    for entry in fs::read_dir(current)
        .map_err(|error| format!("Unable to inspect {}: {error}", current.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?;
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "Skill bundles cannot contain symbolic links: {}",
                relative.display()
            ));
        }
        if file_type.is_dir() {
            collect_skill_bundle_files(root, &path, files, total_bytes)?;
            continue;
        }
        if !file_type.is_file() || !is_safe_relative_path(relative) {
            return Err(format!(
                "Skill bundle file is invalid: {}",
                relative.display()
            ));
        }
        if files.len() >= MAX_SKILL_BUNDLE_FILES {
            return Err(format!(
                "A built skill may contain at most {MAX_SKILL_BUNDLE_FILES} files"
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
        if bytes.len() as u64 > MAX_SKILL_SUPPORT_FILE_BYTES {
            return Err(format!("Skill file is too large: {}", relative.display()));
        }
        *total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if *total_bytes > MAX_FINGERPRINT_BYTES {
            return Err(format!(
                "A built skill may total at most {} MB",
                MAX_FINGERPRINT_BYTES / (1024 * 1024)
            ));
        }
        files.push(SkillBundleFile {
            path: relative.to_string_lossy().to_string(),
            bytes,
        });
    }
    Ok(())
}

fn status_from_metadata(
    metadata: &DesktopAgentBuilderMetadata,
) -> Result<DesktopAgentBuilderStatus, String> {
    let container = container_for_draft(&metadata.draft_id)?;
    let workspace = workspace_for_draft(&metadata.draft_id)?;
    let (draft, validation) = validate_workspace(&workspace);
    let test_report = read_test_report(&container);
    let publish_ready = metadata.status == "draft"
        && validation.valid
        && test_report
            .as_ref()
            .is_some_and(|report| report.passed && report.fingerprint == validation.fingerprint);
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

#[tauri::command]
pub async fn desktop_agent_builder_open(
    manager: State<'_, DesktopChatManager>,
    target_key: String,
    seed: Option<DesktopAgentBuilderSeed>,
) -> Result<DesktopAgentBuilderOpenResult, String> {
    let _mutation_guard = builder_mutation_lock().lock().await;
    let target_key = target_key.trim();
    if target_key.is_empty() || target_key.len() > 240 {
        return Err("Kordi Factory target is invalid".to_string());
    }
    fs::create_dir_all(drafts_root())
        .map_err(|error| format!("Unable to create Kordi Factory storage: {error}"))?;

    let metadata = find_active_draft(target_key).unwrap_or_else(|| new_metadata(target_key));
    let container = container_for_draft(&metadata.draft_id)?;
    let workspace = workspace_for_draft(&metadata.draft_id)?;
    fs::create_dir_all(&container)
        .map_err(|error| format!("Unable to create Kordi Factory draft: {error}"))?;
    migrate_legacy_workspace(&container, &workspace)?;
    materialize_builder_skills(&container)?;
    materialize_seed(&workspace, seed.as_ref())?;
    write_metadata(&workspace, &metadata)?;
    let handle = load_or_create_runtime(manager.inner(), &metadata, &workspace).await?;
    let session = handle
        .lock()
        .await
        .detail()
        .map_err(|error| error.to_string())?;
    Ok(DesktopAgentBuilderOpenResult {
        status: status_from_metadata(&metadata)?,
        session,
    })
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
    let (workspace, mut metadata) = load_metadata(&draft_id)?;
    ensure_expected_fingerprint(&workspace, &expected_fingerprint)?;
    let status = status_from_metadata(&metadata)?;
    if !status.publish_ready {
        return Err(
            "Validate and successfully test the current draft before publishing".to_string(),
        );
    }
    metadata.status = "published".to_string();
    metadata.updated_at_ms = now_millis();
    write_metadata(&workspace, &metadata)?;
    status_from_metadata(&metadata)
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
    let (workspace, metadata) = load_metadata(&draft_id)?;
    ensure_expected_fingerprint(&workspace, &expected_fingerprint)?;
    let status = status_from_metadata(&metadata)?;
    if !status.publish_ready {
        return Err(
            "Validate and successfully test the current skill before installing it".to_string(),
        );
    }
    let draft = status
        .draft
        .ok_or_else(|| "Validated Factory draft is unavailable".to_string())?;
    let normalized_name = clean_slug(&skill_name);
    let skill = draft
        .skills
        .into_iter()
        .find(|skill| skill.name == normalized_name)
        .ok_or_else(|| "The selected skill is not part of this Factory draft".to_string())?;
    let install_scope = match scope.trim() {
        "global" => SkillInstallScope::Global,
        "project" => SkillInstallScope::Project,
        _ => return Err("Skill install scope must be global or project".to_string()),
    };
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let previously_installed = skill_library::list_skills(&cwd)
        .map_err(|error| error.to_string())?
        .iter()
        .any(|entry| entry.origin == "built" && entry.name == skill.name);
    let source_path = workspace.join(&skill.path);
    let source_root = source_path
        .parent()
        .ok_or_else(|| "The built skill directory is invalid".to_string())?;
    let mut bundle_files = Vec::new();
    let mut bundle_bytes = 0_u64;
    collect_skill_bundle_files(
        source_root,
        source_root,
        &mut bundle_files,
        &mut bundle_bytes,
    )?;
    bundle_files.sort_by(|left, right| left.path.cmp(&right.path));
    if !bundle_files.iter().any(|file| file.path == "SKILL.md") {
        return Err("The built skill bundle does not contain SKILL.md".to_string());
    }
    let entry = skill_library::install_skill_bundle(
        &cwd,
        install_scope,
        SkillBundle {
            name: skill.name.clone(),
            description: skill.description,
            slug: skill.name.clone(),
            origin: "built".to_string(),
            provider: None,
            owner: None,
            version: None,
            source_url: None,
            digest: None,
            files: bundle_files,
        },
    )
    .map_err(|error| error.to_string())?;
    if !previously_installed {
        skill_library::set_skill_enabled(&entry.name, false).map_err(|error| error.to_string())?;
    }
    manager.reload_skill_resources().await?;
    skill_library::list_skills(&cwd)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|candidate| candidate.id == entry.id)
        .ok_or_else(|| "Installed skill could not be reloaded".to_string())
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
    manager.sessions.lock().await.remove(&metadata.session_id);
    kordi_cli::desktop_runtime::delete_session_forever(&metadata.session_id)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_prompt_covers_multiple_kordi_resource_types() {
        assert!(BUILDER_SYSTEM_PROMPT.starts_with("You are Kordi Factory"));
        for resource in [
            "agent definitions",
            "skills",
            "tool and plugin selections",
            "workflow instructions",
            "supporting draft files",
        ] {
            assert!(
                BUILDER_SYSTEM_PROMPT.contains(resource),
                "Factory prompt should cover {resource}"
            );
        }
    }

    #[test]
    fn clean_slug_produces_safe_skill_names() {
        assert_eq!(clean_slug(" Repository Review "), "repository-review");
        assert_eq!(clean_slug("../Unsafe Name"), "unsafe-name");
    }

    #[test]
    fn frontmatter_name_requires_frontmatter() {
        assert_eq!(
            frontmatter_name("---\nname: repo-review\ndescription: Test\n---\n"),
            Some("repo-review".to_string())
        );
        assert_eq!(
            frontmatter_field(
                "---\nname: repo-review\ndescription: Test\n---\n",
                "description"
            ),
            Some("Test".to_string())
        );
        assert_eq!(frontmatter_name("# repo-review"), None);
    }

    #[test]
    fn relative_paths_reject_parent_components() {
        assert!(is_safe_relative_path(Path::new("skills/review/SKILL.md")));
        assert!(!is_safe_relative_path(Path::new("../SKILL.md")));
        assert!(!is_safe_relative_path(Path::new("/tmp/SKILL.md")));
        assert!(is_canonical_skill_file_path(Path::new(
            "skills/review/SKILL.md"
        )));
        assert!(is_skill_bundle_file_path(Path::new(
            "skills/review/scripts/check.sh"
        )));
        assert!(!is_canonical_skill_file_path(Path::new(
            "skills/review/notes.md"
        )));
    }

    #[test]
    fn validates_materialized_workspace_and_invalidates_changed_fingerprint() {
        let workspace =
            std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
        let seed = DesktopAgentBuilderSeed {
            name: "Repository reviewer".to_string(),
            role: "Code review agent".to_string(),
            access: "only-me".to_string(),
            tools: vec!["read".to_string(), "grep".to_string()],
            skills: vec![DesktopAgentBuilderSkillSeed {
                name: "repository-review".to_string(),
                description: "Review a repository safely".to_string(),
                content: None,
            }],
            ..DesktopAgentBuilderSeed::default()
        };

        materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
        let (draft, validation) = validate_workspace(&workspace);
        assert!(validation.valid, "{:?}", validation.errors);
        assert_eq!(draft.expect("validated draft").skills.len(), 1);

        let original_fingerprint = validation.fingerprint;
        fs::write(
            workspace.join(PROMPT_FILE),
            "You are a careful repository reviewer.\n",
        )
        .expect("update prompt");
        let (_, changed_validation) = validate_workspace(&workspace);
        assert!(changed_validation.valid);
        assert_ne!(changed_validation.fingerprint, original_fingerprint);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn rejects_skill_paths_that_do_not_match_the_skill_name() {
        let skill = DesktopAgentBuilderSkillFile {
            name: "repository-review".to_string(),
            description: "Review repositories".to_string(),
            path: Some("skills/other/SKILL.md".to_string()),
        };
        let error = skill_path(&skill).expect_err("mismatched path should fail");
        assert!(error.contains("skills/repository-review/SKILL.md"));
    }

    #[test]
    fn rejects_unpublished_files_outside_the_draft_contract() {
        let workspace =
            std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
        let seed = DesktopAgentBuilderSeed {
            name: "Focused agent".to_string(),
            role: "Test agent".to_string(),
            access: "only-me".to_string(),
            ..DesktopAgentBuilderSeed::default()
        };
        materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
        fs::write(workspace.join("unpublished.txt"), "not part of the agent")
            .expect("write unsupported file");

        let (_, validation) = validate_workspace(&workspace);
        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("Unsupported file")));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn validates_and_fingerprints_declared_skill_support_files() {
        let workspace =
            std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
        let seed = DesktopAgentBuilderSeed {
            name: "Repository reviewer".to_string(),
            role: "Code review agent".to_string(),
            access: "only-me".to_string(),
            skills: vec![DesktopAgentBuilderSkillSeed {
                name: "repository-review".to_string(),
                description: "Review a repository safely".to_string(),
                content: None,
            }],
            ..DesktopAgentBuilderSeed::default()
        };
        materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
        let script = workspace.join("skills/repository-review/scripts/check.sh");
        fs::create_dir_all(script.parent().expect("script parent")).expect("create scripts");
        fs::write(&script, "#!/bin/sh\nexit 0\n").expect("write supporting script");

        let (_, validation) = validate_workspace(&workspace);
        assert!(validation.valid, "{:?}", validation.errors);
        assert!(validation.files.iter().any(|file| {
            file.path == "skills/repository-review/scripts/check.sh"
                && file.kind == "skill-support"
                && file.valid
        }));
        let original_fingerprint = validation.fingerprint;
        fs::write(&script, "#!/bin/sh\nexit 1\n").expect("change supporting script");
        let (_, changed) = validate_workspace(&workspace);
        assert!(changed.valid, "{:?}", changed.errors);
        assert_ne!(changed.fingerprint, original_fingerprint);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn atomic_workspace_updates_reject_stale_fingerprints() {
        let container =
            std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
        let workspace = container.join(WORKSPACE_DIR);
        let seed = DesktopAgentBuilderSeed {
            name: "Focused agent".to_string(),
            role: "Test agent".to_string(),
            access: "only-me".to_string(),
            ..DesktopAgentBuilderSeed::default()
        };
        materialize_seed(&workspace, Some(&seed)).expect("materialize builder workspace");
        let original = workspace_fingerprint(&workspace)
            .expect("fingerprint workspace")
            .0;
        atomically_update_workspace(&workspace, &original, |staged| {
            fs::write(staged.join(PROMPT_FILE), "Updated prompt\n")
                .map_err(|error| error.to_string())
        })
        .expect("apply atomic update");
        let changed = workspace_fingerprint(&workspace)
            .expect("fingerprint updated workspace")
            .0;
        assert_ne!(changed, original);
        let error = atomically_update_workspace(&workspace, &original, |_| Ok(()))
            .expect_err("stale update should fail");
        assert!(error.contains("changed in another session"));
        assert_eq!(
            fs::read_to_string(workspace.join(PROMPT_FILE)).expect("read updated prompt"),
            "Updated prompt\n"
        );
        let _ = fs::remove_dir_all(container);
    }

    #[test]
    fn legacy_drafts_migrate_into_a_metadata_isolated_workspace() {
        let container =
            std::env::temp_dir().join(format!("kordi-agent-builder-test-{}", uuid::Uuid::new_v4()));
        let workspace = container.join(WORKSPACE_DIR);
        let seed = DesktopAgentBuilderSeed {
            name: "Migrated agent".to_string(),
            role: "Migration test".to_string(),
            access: "only-me".to_string(),
            ..DesktopAgentBuilderSeed::default()
        };
        materialize_seed(&container, Some(&seed)).expect("materialize legacy draft");
        migrate_legacy_workspace(&container, &workspace).expect("migrate legacy draft");
        materialize_builder_skills(&container).expect("materialize protected resources");

        assert!(workspace.join(AGENT_FILE).is_file());
        assert!(workspace.join(PROMPT_FILE).is_file());
        assert!(!workspace.join(METADATA_FILE).exists());
        assert!(resources_root(&container)
            .join("agent-creator/SKILL.md")
            .is_file());
        assert!(!resources_root(&container).starts_with(&workspace));
        let _ = fs::remove_dir_all(container);
    }
}
