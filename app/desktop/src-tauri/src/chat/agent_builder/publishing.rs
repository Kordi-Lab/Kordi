//! Validated draft publication and built-skill installation.

use std::fs;
use std::path::Path;

use kordi_cli::skill_library::{
    self, SkillBundle, SkillBundleFile, SkillInstallScope, SkillLibraryEntry,
};

use super::storage::{load_metadata, write_metadata};
use super::workspace::{clean_slug, ensure_expected_fingerprint, is_safe_relative_path};
use super::{
    now_millis, status_from_metadata, DesktopAgentBuilderStatus, DesktopChatManager,
    MAX_FINGERPRINT_BYTES, MAX_SKILL_BUNDLE_FILES, MAX_SKILL_SUPPORT_FILE_BYTES,
};

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

pub(super) fn mark_published(
    draft_id: &str,
    expected_fingerprint: &str,
) -> Result<DesktopAgentBuilderStatus, String> {
    let (workspace, mut metadata) = load_metadata(draft_id)?;
    ensure_expected_fingerprint(&workspace, expected_fingerprint)?;
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

pub(super) async fn install_skill(
    manager: &DesktopChatManager,
    draft_id: &str,
    skill_name: &str,
    scope: &str,
    expected_fingerprint: &str,
) -> Result<SkillLibraryEntry, String> {
    let (workspace, metadata) = load_metadata(draft_id)?;
    ensure_expected_fingerprint(&workspace, expected_fingerprint)?;
    let status = status_from_metadata(&metadata)?;
    if !status.publish_ready {
        return Err(
            "Validate and successfully test the current skill before installing it".to_string(),
        );
    }
    let draft = status
        .draft
        .ok_or_else(|| "Validated Factory draft is unavailable".to_string())?;
    let normalized_name = clean_slug(skill_name);
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
