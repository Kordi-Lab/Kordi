//! Draft workspace path policy, seeding, migration, and atomic mutation.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::models::{
    DesktopAgentBuilderAgentFile, DesktopAgentBuilderModelFile, DesktopAgentBuilderSkillFile,
};
use super::storage::{draft_container, resources_root, write_if_missing, write_json};
use super::validation::workspace_fingerprint;
use super::{
    DesktopAgentBuilderDraft, DesktopAgentBuilderSeed, DesktopAgentBuilderSkillSeed,
    AGENT_CREATOR_SKILL, AGENT_FILE, MAX_SKILLS, PROMPT_FILE, SKILL_CREATOR_SKILL,
};

pub(super) fn clean_slug(value: &str) -> String {
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

pub(super) fn canonical_skill_path(name: &str) -> PathBuf {
    PathBuf::from(format!("skills/{}/SKILL.md", clean_slug(name)))
}

pub(super) fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

#[cfg(test)]
pub(super) fn is_canonical_skill_file_path(path: &Path) -> bool {
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

pub(super) fn is_skill_bundle_file_path(path: &Path) -> bool {
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

pub(super) fn materialize_builder_skills(container: &Path) -> Result<(), String> {
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

pub(super) fn migrate_legacy_workspace(container: &Path, workspace: &Path) -> Result<(), String> {
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

pub(super) fn materialize_seed(
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
        proactive: seed.proactive,
        mention_permissions: seed.mention_permissions,
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

pub(super) fn ensure_expected_fingerprint(
    workspace: &Path,
    expected_fingerprint: &str,
) -> Result<(), String> {
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

pub(super) fn atomically_update_workspace<F>(
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

pub(super) fn checked_draft_file_path(
    workspace: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
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

pub(super) fn write_draft(workspace: &Path, draft: DesktopAgentBuilderDraft) -> Result<(), String> {
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
        proactive: draft.proactive,
        mention_permissions: draft.mention_permissions,
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
