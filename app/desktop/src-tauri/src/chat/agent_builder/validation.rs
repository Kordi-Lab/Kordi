//! Bounded workspace reads, contract validation, and content fingerprinting.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::models::{DesktopAgentBuilderAgentFile, DesktopAgentBuilderSkillFile};
use super::{
    canonical_skill_path, clean_slug, is_safe_relative_path, is_skill_bundle_file_path,
    DesktopAgentBuilderDraft, DesktopAgentBuilderFileStatus, DesktopAgentBuilderSkillDraft,
    DesktopAgentBuilderValidation, AGENT_FILE, MAX_AGENT_BYTES, MAX_FINGERPRINT_BYTES,
    MAX_FINGERPRINT_FILES, MAX_PLUGINS, MAX_PROMPT_BYTES, MAX_SKILLS, MAX_SKILL_BUNDLE_FILES,
    MAX_SKILL_BYTES, MAX_SKILL_SUPPORT_FILE_BYTES, MAX_TOOLS, PROMPT_FILE,
};

pub(super) fn read_limited(path: &Path, max_bytes: u64) -> Result<String, String> {
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

pub(super) fn skill_path(skill: &DesktopAgentBuilderSkillFile) -> Result<PathBuf, String> {
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

pub(super) fn frontmatter_field(content: &str, field: &str) -> Option<String> {
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

pub(super) fn frontmatter_name(content: &str) -> Option<String> {
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

pub(super) fn workspace_fingerprint(workspace: &Path) -> Result<(String, Vec<PathBuf>), String> {
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

pub(super) fn validate_workspace(
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
