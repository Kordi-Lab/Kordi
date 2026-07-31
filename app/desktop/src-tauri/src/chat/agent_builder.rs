use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use kordi_cli::desktop_runtime::{DesktopRuntimeProfile, DesktopRuntimeSession};
use kordi_cli::skill_library::{
    self, SkillBundle, SkillBundleFile, SkillInstallScope, SkillLibraryEntry,
};
use kordi_tools::ExecutionPolicy;
use sha2::{Digest, Sha256};
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

use self::models::{
    DesktopAgentBuilderAgentFile, DesktopAgentBuilderMetadata, DesktopAgentBuilderModelFile,
    DesktopAgentBuilderSkillFile,
};
pub use self::models::{
    DesktopAgentBuilderDraft, DesktopAgentBuilderFileStatus, DesktopAgentBuilderOpenResult,
    DesktopAgentBuilderSeed, DesktopAgentBuilderSkillDraft, DesktopAgentBuilderSkillSeed,
    DesktopAgentBuilderStatus, DesktopAgentBuilderTestReport, DesktopAgentBuilderValidation,
};

mod storage;

use self::storage::{
    builder_mutation_lock, checked_draft_id, container_for_draft, draft_container, drafts_root,
    find_active_draft, load_metadata, metadata_path, new_metadata, read_test_report,
    resources_root, test_report_path, workspace_for_draft, write_if_missing, write_json,
    write_metadata,
};

fn clean_slug(value: &str) -> String {
    let mut result = String::new();
    let mut previous_dash = false;
    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            result.push(character);
            previous_dash = false;
        } else if !result.is_empty() && !previous_dash {
            result.push('-');
            previous_dash = true;
        }
    }
    result.trim_matches('-').chars().take(64).collect()
}

fn canonical_skill_path(name: &str) -> PathBuf {
    PathBuf::from(format!("skills/{}/SKILL.md", clean_slug(name)))
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

#[cfg(test)]
fn is_canonical_skill_file_path(path: &Path) -> bool {
    let components = path.components().collect::<Vec<_>>();
    if components.len() != 3
        || components[0].as_os_str() != "skills"
        || components[2].as_os_str() != "SKILL.md"
    {
        return false;
    }
    let Some(slug) = components[1].as_os_str().to_str() else {
        return false;
    };
    !slug.is_empty() && clean_slug(slug) == slug
}

fn is_skill_bundle_file_path(path: &Path) -> bool {
    if !is_safe_relative_path(path) || path.to_string_lossy().len() > 512 {
        return false;
    }
    let components = path.components().collect::<Vec<_>>();
    if components.len() < 3 || components[0].as_os_str() != "skills" {
        return false;
    }
    let Some(slug) = components[1].as_os_str().to_str() else {
        return false;
    };
    !slug.is_empty() && clean_slug(slug) == slug
}

fn default_skill_content(skill: &DesktopAgentBuilderSkillSeed, slug: &str) -> String {
    let description = normalized_skill_description(&skill.description, slug);
    let escaped_description = description
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace(['\r', '\n'], " ");
    format!(
        "---\nname: {slug}\ndescription: \"{escaped_description}\"\n---\n\n# {}\n\nFollow the user's request using this focused capability. Ask for clarification when required, preserve user data, and report concrete results.\n",
        skill.name.trim()
    )
}

fn normalized_skill_description(description: &str, slug: &str) -> String {
    if description.trim().is_empty() {
        format!("Use {slug} when its focused workflow is required.")
    } else {
        description.trim().to_string()
    }
}

fn materialize_builder_skills(container: &Path) -> Result<(), String> {
    let resources = resources_root(container);
    write_if_missing(
        &resources.join("agent-creator/SKILL.md"),
        AGENT_CREATOR_SKILL,
    )?;
    write_if_missing(
        &resources.join("skill-creator/SKILL.md"),
        SKILL_CREATOR_SKILL,
    )
}

fn migrate_legacy_workspace(container: &Path, workspace: &Path) -> Result<(), String> {
    fs::create_dir_all(workspace)
        .map_err(|error| format!("Unable to create Kordi Factory workspace: {error}"))?;
    for relative in [AGENT_FILE, PROMPT_FILE, "skills"] {
        let legacy = container.join(relative);
        if !legacy.exists() {
            continue;
        }
        let destination = workspace.join(relative);
        if destination.exists() {
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
        }
        fs::rename(&legacy, &destination).map_err(|error| {
            format!(
                "Unable to migrate {} into the protected Kordi Factory workspace: {error}",
                legacy.display()
            )
        })?;
    }
    Ok(())
}

fn materialize_seed(
    workspace: &Path,
    seed: Option<&DesktopAgentBuilderSeed>,
) -> Result<(), String> {
    fs::create_dir_all(workspace)
        .map_err(|error| format!("Unable to create Kordi Factory workspace: {error}"))?;

    let seed = seed.cloned().unwrap_or_default();
    let name = if seed.name.trim().is_empty() {
        "New build".to_string()
    } else {
        seed.name.trim().to_string()
    };
    let system_prompt = if seed.system_prompt.trim().is_empty() {
        format!("You are {name}, a focused Kordi agent. Follow the user's request accurately and state uncertainty clearly.\n")
    } else {
        format!("{}\n", seed.system_prompt.trim())
    };

    let mut skill_files = Vec::new();
    for skill in seed.skills.iter().take(MAX_SKILLS) {
        let slug = clean_slug(&skill.name);
        if slug.is_empty() {
            continue;
        }
        let relative_path = format!("skills/{slug}/SKILL.md");
        let content = skill
            .content
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("{}\n", value.trim()))
            .unwrap_or_else(|| default_skill_content(skill, &slug));
        write_if_missing(&workspace.join(&relative_path), &content)?;
        skill_files.push(DesktopAgentBuilderSkillFile {
            name: slug,
            description: normalized_skill_description(&skill.description, &clean_slug(&skill.name)),
            path: Some(relative_path),
        });
    }

    let agent_file = DesktopAgentBuilderAgentFile {
        name,
        role: seed.role.trim().to_string(),
        description: seed.description.trim().to_string(),
        source_summary: seed.source_summary.trim().to_string(),
        boundaries: seed
            .boundaries
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .take(20)
            .collect(),
        model: DesktopAgentBuilderModelFile {
            provider: seed.provider.filter(|value| !value.trim().is_empty()),
            model: seed.model.filter(|value| !value.trim().is_empty()),
            thinking: seed.thinking.filter(|value| !value.trim().is_empty()),
        },
        access: if seed.access.trim().is_empty() {
            "only-me".to_string()
        } else {
            seed.access.trim().to_string()
        },
        tools: seed
            .tools
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        plugins: seed
            .plugins
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        skills: skill_files,
    };
    if !workspace.join(AGENT_FILE).exists() {
        write_json(&workspace.join(AGENT_FILE), &agent_file)?;
    }
    write_if_missing(&workspace.join(PROMPT_FILE), &system_prompt)
}

fn builder_profile(workspace: &Path) -> DesktopRuntimeProfile {
    DesktopRuntimeProfile {
        provider: None,
        model: None,
        thinking: None,
        // Keep the bundled skills discoverable for slash commands and also embed
        // their contract in the specialist prompt. This makes the Factory
        // deterministic even when a user has disabled a same-named global skill.
        system_prompt: Some(format!(
            "{BUILDER_SYSTEM_PROMPT}\n\n<bundled_agent_creator_skill>\n{AGENT_CREATOR_SKILL}\n</bundled_agent_creator_skill>\n\n<bundled_skill_creator_skill>\n{SKILL_CREATOR_SKILL}\n</bundled_skill_creator_skill>"
        )),
        tool_names: Some(vec![
            "read".to_string(),
            "find".to_string(),
            "grep".to_string(),
            "ls".to_string(),
            "write".to_string(),
            "edit".to_string(),
        ]),
        skill_names: Some(vec![
            "agent-creator".to_string(),
            "skill-creator".to_string(),
        ]),
        skill_paths: vec![resources_root(
            workspace.parent().unwrap_or_else(|| Path::new(".")),
        )],
        execution_policy: Some(ExecutionPolicy::Safety),
    }
}

pub(super) fn is_agent_builder_session_id(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

fn draft_id_from_session(session_id: &str) -> Result<&str, String> {
    let draft_id = session_id
        .strip_prefix(SESSION_PREFIX)
        .ok_or_else(|| "Kordi Factory session id is invalid".to_string())?;
    checked_draft_id(draft_id)
}

pub(super) async fn resume_agent_builder_runtime(
    session_id: &str,
) -> Result<DesktopRuntimeSession, String> {
    let draft_id = draft_id_from_session(session_id)?;
    let container = container_for_draft(draft_id)?;
    let workspace = workspace_for_draft(draft_id)?;
    if !metadata_path(&container).is_file() {
        return Err("Kordi Factory draft is unavailable".to_string());
    }
    migrate_legacy_workspace(&container, &workspace)?;
    materialize_builder_skills(&container)?;
    DesktopRuntimeSession::resume_profiled(
        workspace.clone(),
        session_id,
        builder_profile(&workspace),
    )
    .await
    .map_err(|error| error.to_string())
}

async fn load_or_create_runtime(
    manager: &DesktopChatManager,
    metadata: &DesktopAgentBuilderMetadata,
    workspace: &Path,
) -> Result<DesktopSessionHandle, String> {
    if let Some(handle) = manager
        .sessions
        .lock()
        .await
        .get(&metadata.session_id)
        .cloned()
    {
        return Ok(handle);
    }

    let mut runtime = if kordi_cli::desktop_runtime::session_exists(&metadata.session_id)
        .map_err(|error| error.to_string())?
    {
        DesktopRuntimeSession::resume_profiled(
            workspace.to_path_buf(),
            &metadata.session_id,
            builder_profile(workspace),
        )
        .await
        .map_err(|error| error.to_string())?
    } else {
        DesktopRuntimeSession::create_profiled_with_id(
            workspace.to_path_buf(),
            &metadata.session_id,
            builder_profile(workspace),
        )
        .await
        .map_err(|error| error.to_string())?
    };
    runtime
        .materialize_session()
        .map_err(|error| error.to_string())?;
    runtime
        .set_auto_name("Kordi Factory")
        .map_err(|error| error.to_string())?;
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    Ok(sessions
        .entry(metadata.session_id.clone())
        .or_insert_with(|| handle.clone())
        .clone())
}

fn read_limited(path: &Path, max_bytes: u64) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} is larger than {} KB",
            path.display(),
            max_bytes / 1024
        ));
    }
    fs::read_to_string(path).map_err(|error| format!("Unable to read {}: {error}", path.display()))
}

fn read_limited_inside(
    workspace: &Path,
    relative: &Path,
    max_bytes: u64,
) -> Result<String, String> {
    if !is_safe_relative_path(relative) {
        return Err("Kordi Factory file path is invalid".to_string());
    }
    let root = fs::canonicalize(workspace)
        .map_err(|error| format!("Unable to resolve Kordi Factory workspace: {error}"))?;
    let candidate = workspace.join(relative);
    let resolved = fs::canonicalize(&candidate)
        .map_err(|error| format!("Unable to resolve {}: {error}", candidate.display()))?;
    if !resolved.starts_with(root) {
        return Err(format!(
            "{} escapes the Kordi Factory workspace",
            candidate.display()
        ));
    }
    read_limited(&resolved, max_bytes)
}

fn skill_path(skill: &DesktopAgentBuilderSkillFile) -> Result<PathBuf, String> {
    let expected = canonical_skill_path(&skill.name);
    let relative = skill
        .path
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| expected.clone());
    if !is_safe_relative_path(&relative) || relative != expected {
        return Err(format!(
            "Skill '{}' must use path {}",
            skill.name,
            expected.display()
        ));
    }
    Ok(relative)
}

fn frontmatter_field(content: &str, field: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix(&format!("{field}:")) {
            return Some(value.trim().trim_matches(['\'', '"']).to_string());
        }
    }
    None
}

fn frontmatter_name(content: &str) -> Option<String> {
    frontmatter_field(content, "name")
}

fn collect_fingerprint_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
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
                "Kordi Factory drafts cannot contain symbolic links: {}",
                relative.display()
            ));
        }
        if file_type.is_dir() {
            collect_fingerprint_files(root, &path, files)?;
        } else if file_type.is_file() {
            files.push(relative.to_path_buf());
            if files.len() > MAX_FINGERPRINT_FILES {
                return Err(format!(
                    "Kordi Factory drafts may contain at most {MAX_FINGERPRINT_FILES} files"
                ));
            }
        }
    }
    Ok(())
}

fn workspace_fingerprint(workspace: &Path) -> Result<(String, Vec<PathBuf>), String> {
    let mut files = Vec::new();
    collect_fingerprint_files(workspace, workspace, &mut files)?;
    files.sort();
    let mut digest = Sha256::new();
    let mut total_bytes = 0_u64;
    for relative in &files {
        let path = workspace.join(relative);
        let bytes = fs::metadata(&path)
            .map_err(|error| format!("Unable to inspect {}: {error}", path.display()))?
            .len();
        total_bytes = total_bytes.saturating_add(bytes);
        if total_bytes > MAX_FINGERPRINT_BYTES {
            return Err(format!(
                "Kordi Factory draft files may total at most {} MB",
                MAX_FINGERPRINT_BYTES / (1024 * 1024)
            ));
        }
        digest.update(relative.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(fs::read(path).map_err(|error| error.to_string())?);
        digest.update([0]);
    }
    Ok((format!("{:x}", digest.finalize()), files))
}

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

fn validate_workspace(
    workspace: &Path,
) -> (
    Option<DesktopAgentBuilderDraft>,
    DesktopAgentBuilderValidation,
) {
    let mut errors = Vec::new();
    let mut files = Vec::new();
    let (fingerprint, workspace_files) = workspace_fingerprint(workspace).unwrap_or_else(|error| {
        errors.push(error);
        (String::new(), Vec::new())
    });
    let mut expected_files =
        BTreeSet::from([PathBuf::from(AGENT_FILE), PathBuf::from(PROMPT_FILE)]);
    let mut declared_skill_roots = BTreeSet::new();

    let agent_text = read_limited_inside(workspace, Path::new(AGENT_FILE), MAX_AGENT_BYTES);
    let mut agent_file = None;
    match agent_text {
        Ok(text) => match serde_json::from_str::<DesktopAgentBuilderAgentFile>(&text) {
            Ok(parsed) => {
                files.push(DesktopAgentBuilderFileStatus {
                    path: AGENT_FILE.to_string(),
                    kind: "agent".to_string(),
                    valid: true,
                });
                agent_file = Some(parsed);
            }
            Err(error) => {
                errors.push(format!("agent.json is invalid: {error}"));
                files.push(DesktopAgentBuilderFileStatus {
                    path: AGENT_FILE.to_string(),
                    kind: "agent".to_string(),
                    valid: false,
                });
            }
        },
        Err(error) => {
            errors.push(error);
            files.push(DesktopAgentBuilderFileStatus {
                path: AGENT_FILE.to_string(),
                kind: "agent".to_string(),
                valid: false,
            });
        }
    }

    let prompt = match read_limited_inside(workspace, Path::new(PROMPT_FILE), MAX_PROMPT_BYTES) {
        Ok(value) if !value.trim().is_empty() => {
            files.push(DesktopAgentBuilderFileStatus {
                path: PROMPT_FILE.to_string(),
                kind: "prompt".to_string(),
                valid: true,
            });
            Some(value.trim().to_string())
        }
        Ok(_) => {
            errors.push("SYSTEM_PROMPT.md cannot be empty".to_string());
            files.push(DesktopAgentBuilderFileStatus {
                path: PROMPT_FILE.to_string(),
                kind: "prompt".to_string(),
                valid: false,
            });
            None
        }
        Err(error) => {
            errors.push(error);
            files.push(DesktopAgentBuilderFileStatus {
                path: PROMPT_FILE.to_string(),
                kind: "prompt".to_string(),
                valid: false,
            });
            None
        }
    };

    let mut draft_skills = Vec::new();
    if let Some(agent) = agent_file.as_ref() {
        let agent_error_count = errors.len();
        if agent.name.trim().is_empty() {
            errors.push("agent.json must include a name".to_string());
        }
        if agent.role.trim().is_empty() {
            errors.push("agent.json must include a role".to_string());
        }
        if agent.skills.len() > MAX_SKILLS {
            errors.push(format!(
                "agent.json may reference at most {MAX_SKILLS} skills"
            ));
        }
        if !matches!(agent.access.trim(), "only-me" | "participant-conversations") {
            errors.push(
                "agent.json access must be 'only-me' or 'participant-conversations'".to_string(),
            );
        }
        if agent.tools.len() > MAX_TOOLS {
            errors.push(format!("agent.json may include at most {MAX_TOOLS} tools"));
        }
        if agent.plugins.len() > MAX_PLUGINS {
            errors.push(format!(
                "agent.json may include at most {MAX_PLUGINS} plugins"
            ));
        }
        for (kind, values) in [("tool", &agent.tools), ("plugin", &agent.plugins)] {
            let mut seen_values = BTreeSet::new();
            for value in values {
                let normalized = value.trim();
                if normalized.is_empty() || normalized.len() > 96 {
                    errors.push(format!("agent.json contains an invalid {kind} name"));
                } else if !seen_values.insert(normalized.to_ascii_lowercase()) {
                    errors.push(format!(
                        "agent.json contains duplicate {kind} '{normalized}'"
                    ));
                }
            }
        }
        let mut seen = BTreeSet::new();
        for skill in agent.skills.iter().take(MAX_SKILLS) {
            let normalized_name = clean_slug(&skill.name);
            if normalized_name.is_empty() || !seen.insert(normalized_name.clone()) {
                errors.push(format!(
                    "Skill '{}' has an invalid or duplicate name",
                    skill.name
                ));
                continue;
            }
            let relative = match skill_path(skill) {
                Ok(value) => value,
                Err(error) => {
                    errors.push(error);
                    continue;
                }
            };
            let display_path = relative.to_string_lossy().to_string();
            expected_files.insert(relative.clone());
            if let Some(parent) = relative.parent() {
                declared_skill_roots.insert(parent.to_path_buf());
            }
            match read_limited_inside(workspace, &relative, MAX_SKILL_BYTES) {
                Ok(content) => {
                    let header_name = frontmatter_name(&content);
                    let header_description = frontmatter_field(&content, "description")
                        .filter(|value| !value.trim().is_empty());
                    let valid_name = header_name.as_deref() == Some(normalized_name.as_str());
                    let valid_description =
                        !skill.description.trim().is_empty() && header_description.is_some();
                    let valid = valid_name && valid_description;
                    if !valid_name {
                        errors.push(format!(
                            "{display_path} must have YAML frontmatter name: {normalized_name}"
                        ));
                    }
                    if !valid_description {
                        errors.push(format!(
                            "{display_path} and its agent.json entry must include a description"
                        ));
                    }
                    files.push(DesktopAgentBuilderFileStatus {
                        path: display_path.clone(),
                        kind: "skill".to_string(),
                        valid,
                    });
                    draft_skills.push(DesktopAgentBuilderSkillDraft {
                        name: normalized_name,
                        description: skill.description.trim().to_string(),
                        path: display_path,
                        content,
                    });
                }
                Err(error) => {
                    errors.push(error);
                    files.push(DesktopAgentBuilderFileStatus {
                        path: display_path,
                        kind: "skill".to_string(),
                        valid: false,
                    });
                }
            }
        }
        if errors.len() > agent_error_count {
            if let Some(file) = files.iter_mut().find(|file| file.path == AGENT_FILE) {
                file.valid = false;
            }
        }
    }

    let mut skill_bundle_file_counts = declared_skill_roots
        .iter()
        .map(|root| (root.clone(), 1_usize))
        .collect::<std::collections::BTreeMap<_, _>>();
    for relative in workspace_files {
        if expected_files.contains(&relative) {
            continue;
        }
        if let Some(skill_root) = declared_skill_roots
            .iter()
            .find(|skill_root| relative.starts_with(skill_root.as_path()))
        {
            let count = skill_bundle_file_counts
                .entry(skill_root.clone())
                .or_default();
            *count += 1;
            let size = workspace
                .join(&relative)
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or(MAX_SKILL_SUPPORT_FILE_BYTES.saturating_add(1));
            let within_limits = is_skill_bundle_file_path(&relative)
                && *count <= MAX_SKILL_BUNDLE_FILES
                && size <= MAX_SKILL_SUPPORT_FILE_BYTES;
            if !within_limits {
                errors.push(format!(
                    "Skill support file is invalid or exceeds bundle limits: {}",
                    relative.display()
                ));
            }
            files.push(DesktopAgentBuilderFileStatus {
                path: relative.to_string_lossy().to_string(),
                kind: "skill-support".to_string(),
                valid: within_limits,
            });
            continue;
        }
        errors.push(format!(
            "Unsupported file in Kordi Factory draft: {}",
            relative.display()
        ));
        files.push(DesktopAgentBuilderFileStatus {
            path: relative.to_string_lossy().to_string(),
            kind: "unsupported".to_string(),
            valid: false,
        });
    }

    let draft = match (agent_file, prompt) {
        (Some(agent), Some(system_prompt)) => Some(DesktopAgentBuilderDraft {
            name: agent.name.trim().to_string(),
            role: agent.role.trim().to_string(),
            description: agent.description.trim().to_string(),
            system_prompt,
            source_summary: agent.source_summary.trim().to_string(),
            boundaries: agent
                .boundaries
                .into_iter()
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect(),
            access: agent.access.trim().to_string(),
            provider: agent.model.provider,
            model: agent.model.model,
            thinking: agent.model.thinking,
            tools: agent
                .tools
                .into_iter()
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect(),
            plugins: agent
                .plugins
                .into_iter()
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect(),
            skills: draft_skills,
        }),
        _ => None,
    };

    (
        draft,
        DesktopAgentBuilderValidation {
            valid: errors.is_empty(),
            fingerprint,
            errors,
            files,
        },
    )
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

fn ensure_expected_fingerprint(workspace: &Path, expected_fingerprint: &str) -> Result<(), String> {
    let expected = expected_fingerprint.trim();
    if expected.is_empty() {
        return Err("Kordi Factory draft version is required".to_string());
    }
    let (current, _) = workspace_fingerprint(workspace)?;
    if current != expected {
        return Err(
            "This Factory draft changed in another session. Refresh it before editing again."
                .to_string(),
        );
    }
    Ok(())
}

fn copy_workspace_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Unable to stage Kordi Factory workspace: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Unable to inspect {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Unable to inspect {}: {error}", source_path.display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Kordi Factory drafts cannot contain symbolic links: {}",
                source_path.display()
            ));
        }
        if file_type.is_dir() {
            copy_workspace_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Unable to stage {} as {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn atomically_update_workspace<F>(
    workspace: &Path,
    expected_fingerprint: &str,
    update: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    ensure_expected_fingerprint(workspace, expected_fingerprint)?;
    let container = draft_container(workspace)?;
    let nonce = uuid::Uuid::new_v4();
    let staged = container.join(format!(".workspace-stage-{nonce}"));
    let backup = container.join(format!(".workspace-backup-{nonce}"));
    let result = (|| {
        copy_workspace_tree(workspace, &staged)?;
        update(&staged)?;
        workspace_fingerprint(&staged)?;
        ensure_expected_fingerprint(workspace, expected_fingerprint)?;
        fs::rename(workspace, &backup)
            .map_err(|error| format!("Unable to prepare the Factory draft update: {error}"))?;
        if let Err(error) = fs::rename(&staged, workspace) {
            let _ = fs::rename(&backup, workspace);
            return Err(format!("Unable to apply the Factory draft update: {error}"));
        }
        let _ = fs::remove_dir_all(&backup);
        Ok(())
    })();
    if staged.exists() {
        let _ = fs::remove_dir_all(&staged);
    }
    if backup.exists() && !workspace.exists() {
        let _ = fs::rename(&backup, workspace);
    } else if backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    result
}

fn checked_draft_file_path(workspace: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = PathBuf::from(relative_path.trim());
    let allowed = relative == Path::new(AGENT_FILE)
        || relative == Path::new(PROMPT_FILE)
        || is_skill_bundle_file_path(&relative);
    if !allowed || !is_safe_relative_path(&relative) {
        return Err("Kordi Factory file path is not editable".to_string());
    }
    let root = fs::canonicalize(workspace)
        .map_err(|error| format!("Unable to resolve Kordi Factory workspace: {error}"))?;
    let candidate = workspace.join(relative);
    let mut existing = candidate.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| "Kordi Factory file path is invalid".to_string())?;
    }
    let resolved = fs::canonicalize(existing)
        .map_err(|error| format!("Unable to resolve Kordi Factory file path: {error}"))?;
    if !resolved.starts_with(root) {
        return Err("Kordi Factory file path escapes the draft workspace".to_string());
    }
    Ok(candidate)
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

fn write_draft(workspace: &Path, draft: DesktopAgentBuilderDraft) -> Result<(), String> {
    if draft.skills.len() > MAX_SKILLS {
        return Err(format!(
            "A Factory draft may contain at most {MAX_SKILLS} skills"
        ));
    }
    let mut skill_specs = Vec::new();
    let mut seen = BTreeSet::new();
    let mut retained_skill_directories = BTreeSet::new();
    for skill in draft.skills {
        let name = clean_slug(&skill.name);
        if name.is_empty() || !seen.insert(name.clone()) {
            return Err(format!(
                "Skill '{}' has an invalid or duplicate name",
                skill.name
            ));
        }
        let relative = if skill.path.trim().is_empty() {
            canonical_skill_path(&name)
        } else {
            PathBuf::from(skill.path.trim())
        };
        let expected = canonical_skill_path(&name);
        if !is_safe_relative_path(&relative) || relative != expected {
            return Err(format!(
                "Skill '{name}' must use path {}",
                expected.display()
            ));
        }
        let content = if skill.content.trim().is_empty() {
            default_skill_content(
                &DesktopAgentBuilderSkillSeed {
                    name: name.clone(),
                    description: skill.description.clone(),
                    content: None,
                },
                &name,
            )
        } else {
            format!("{}\n", skill.content.trim())
        };
        let path = checked_draft_file_path(workspace, &relative.to_string_lossy())?;
        if let Some(parent) = relative.parent() {
            retained_skill_directories.insert(parent.to_path_buf());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
        }
        fs::write(&path, content)
            .map_err(|error| format!("Unable to write {}: {error}", path.display()))?;
        skill_specs.push(DesktopAgentBuilderSkillFile {
            name,
            description: skill.description.trim().to_string(),
            path: Some(relative.to_string_lossy().to_string()),
        });
    }

    let skills_root = workspace.join("skills");
    if let Ok(entries) = fs::read_dir(&skills_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(workspace) else {
                continue;
            };
            if is_safe_relative_path(relative)
                && !retained_skill_directories.contains(relative)
                && path.join("SKILL.md").is_file()
            {
                fs::remove_dir_all(&path).map_err(|error| {
                    format!("Unable to remove stale skill {}: {error}", path.display())
                })?;
            }
        }
    }

    let file = DesktopAgentBuilderAgentFile {
        name: draft.name.trim().to_string(),
        role: draft.role.trim().to_string(),
        description: draft.description.trim().to_string(),
        source_summary: draft.source_summary.trim().to_string(),
        boundaries: draft
            .boundaries
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .take(20)
            .collect(),
        model: DesktopAgentBuilderModelFile {
            provider: draft.provider.filter(|value| !value.trim().is_empty()),
            model: draft.model.filter(|value| !value.trim().is_empty()),
            thinking: draft.thinking.filter(|value| !value.trim().is_empty()),
        },
        access: draft.access.trim().to_string(),
        tools: draft
            .tools
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        plugins: draft
            .plugins
            .into_iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect(),
        skills: skill_specs,
    };
    let agent_path = checked_draft_file_path(workspace, AGENT_FILE)?;
    write_json(&agent_path, &file)?;
    let prompt_path = checked_draft_file_path(workspace, PROMPT_FILE)?;
    fs::write(prompt_path, format!("{}\n", draft.system_prompt.trim()))
        .map_err(|error| format!("Unable to write {PROMPT_FILE}: {error}"))
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
        let skill_names = draft
            .skills
            .iter()
            .map(|skill| skill.name.clone())
            .collect();
        let safe_tools = draft
            .tools
            .iter()
            .filter(|name| matches!(name.as_str(), "read" | "find" | "grep" | "ls"))
            .cloned()
            .collect();
        let profile = DesktopRuntimeProfile {
            provider: draft.provider.clone(),
            model: draft.model.clone(),
            thinking: draft.thinking.clone(),
            system_prompt: Some(draft.system_prompt.clone()),
            tool_names: Some(safe_tools),
            skill_names: Some(skill_names),
            skill_paths: vec![workspace.join("skills")],
            execution_policy: Some(ExecutionPolicy::Safety),
        };
        let test_session_id = format!("session:agent-builder-test:{}", uuid::Uuid::new_v4());
        let test_result = async {
            let mut runtime = DesktopRuntimeSession::create_profiled_with_id(
                workspace.clone(),
                &test_session_id,
                profile,
            )
            .await
            .map_err(|error| error.to_string())?;
            let detail = runtime
                .send_message(
                    "Runtime smoke test: introduce yourself in one sentence and state your primary responsibility. Do not use tools.".to_string(),
                    Vec::new(),
                )
                .await
                .map_err(|error| error.to_string())?;
            let reply = detail
                .messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
                .ok_or_else(|| "The candidate runtime returned no assistant response".to_string())?;
            Ok::<String, String>(reply.text.trim().chars().take(180).collect())
        }
        .await;
        let _ = kordi_cli::desktop_runtime::delete_session_forever(&test_session_id);
        match test_result {
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
