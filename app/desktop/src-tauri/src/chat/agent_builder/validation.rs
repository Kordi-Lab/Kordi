//! Bounded workspace reads, contract validation, and content fingerprinting.

use std::collections::{BTreeMap, BTreeSet};
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

struct WorkspaceValidationState {
    errors: Vec<String>,
    files: Vec<DesktopAgentBuilderFileStatus>,
    expected_files: BTreeSet<PathBuf>,
    declared_skill_roots: BTreeSet<PathBuf>,
    draft_skills: Vec<DesktopAgentBuilderSkillDraft>,
}

impl WorkspaceValidationState {
    fn new() -> Self {
        Self {
            errors: Vec::new(),
            files: Vec::new(),
            expected_files: BTreeSet::from([PathBuf::from(AGENT_FILE), PathBuf::from(PROMPT_FILE)]),
            declared_skill_roots: BTreeSet::new(),
            draft_skills: Vec::new(),
        }
    }

    fn record_file(&mut self, path: String, kind: &str, valid: bool) {
        self.files.push(DesktopAgentBuilderFileStatus {
            path,
            kind: kind.to_string(),
            valid,
        });
    }
}

fn load_agent_file(
    workspace: &Path,
    state: &mut WorkspaceValidationState,
) -> Option<DesktopAgentBuilderAgentFile> {
    match read_limited_inside(workspace, Path::new(AGENT_FILE), MAX_AGENT_BYTES) {
        Ok(text) => match serde_json::from_str::<DesktopAgentBuilderAgentFile>(&text) {
            Ok(parsed) => {
                state.record_file(AGENT_FILE.to_string(), "agent", true);
                Some(parsed)
            }
            Err(error) => {
                state.errors.push(format!("agent.json is invalid: {error}"));
                state.record_file(AGENT_FILE.to_string(), "agent", false);
                None
            }
        },
        Err(error) => {
            state.errors.push(error);
            state.record_file(AGENT_FILE.to_string(), "agent", false);
            None
        }
    }
}

fn load_system_prompt(workspace: &Path, state: &mut WorkspaceValidationState) -> Option<String> {
    match read_limited_inside(workspace, Path::new(PROMPT_FILE), MAX_PROMPT_BYTES) {
        Ok(value) if !value.trim().is_empty() => {
            state.record_file(PROMPT_FILE.to_string(), "prompt", true);
            Some(value.trim().to_string())
        }
        Ok(_) => {
            state
                .errors
                .push("SYSTEM_PROMPT.md cannot be empty".to_string());
            state.record_file(PROMPT_FILE.to_string(), "prompt", false);
            None
        }
        Err(error) => {
            state.errors.push(error);
            state.record_file(PROMPT_FILE.to_string(), "prompt", false);
            None
        }
    }
}

fn validate_named_values(kind: &str, values: &[String], errors: &mut Vec<String>) {
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

fn validate_agent_metadata(agent: &DesktopAgentBuilderAgentFile, errors: &mut Vec<String>) {
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
        errors
            .push("agent.json access must be 'only-me' or 'participant-conversations'".to_string());
    }
    if agent.tools.len() > MAX_TOOLS {
        errors.push(format!("agent.json may include at most {MAX_TOOLS} tools"));
    }
    if agent.plugins.len() > MAX_PLUGINS {
        errors.push(format!(
            "agent.json may include at most {MAX_PLUGINS} plugins"
        ));
    }
    validate_named_values("tool", &agent.tools, errors);
    validate_named_values("plugin", &agent.plugins, errors);
}

fn validate_declared_skill(
    workspace: &Path,
    skill: &DesktopAgentBuilderSkillFile,
    normalized_name: String,
    state: &mut WorkspaceValidationState,
) {
    let relative = match skill_path(skill) {
        Ok(value) => value,
        Err(error) => {
            state.errors.push(error);
            return;
        }
    };
    let display_path = relative.to_string_lossy().to_string();
    state.expected_files.insert(relative.clone());
    if let Some(parent) = relative.parent() {
        state.declared_skill_roots.insert(parent.to_path_buf());
    }

    match read_limited_inside(workspace, &relative, MAX_SKILL_BYTES) {
        Ok(content) => {
            let header_name = frontmatter_name(&content);
            let header_description =
                frontmatter_field(&content, "description").filter(|value| !value.trim().is_empty());
            let valid_name = header_name.as_deref() == Some(normalized_name.as_str());
            let valid_description =
                !skill.description.trim().is_empty() && header_description.is_some();
            if !valid_name {
                state.errors.push(format!(
                    "{display_path} must have YAML frontmatter name: {normalized_name}"
                ));
            }
            if !valid_description {
                state.errors.push(format!(
                    "{display_path} and its agent.json entry must include a description"
                ));
            }
            state.record_file(
                display_path.clone(),
                "skill",
                valid_name && valid_description,
            );
            state.draft_skills.push(DesktopAgentBuilderSkillDraft {
                name: normalized_name,
                description: skill.description.trim().to_string(),
                path: display_path,
                content,
            });
        }
        Err(error) => {
            state.errors.push(error);
            state.record_file(display_path, "skill", false);
        }
    }
}

fn validate_agent_contract(
    workspace: &Path,
    agent: &DesktopAgentBuilderAgentFile,
    state: &mut WorkspaceValidationState,
) {
    let agent_error_count = state.errors.len();
    validate_agent_metadata(agent, &mut state.errors);
    let mut seen = BTreeSet::new();
    for skill in agent.skills.iter().take(MAX_SKILLS) {
        let normalized_name = clean_slug(&skill.name);
        if normalized_name.is_empty() || !seen.insert(normalized_name.clone()) {
            state.errors.push(format!(
                "Skill '{}' has an invalid or duplicate name",
                skill.name
            ));
            continue;
        }
        validate_declared_skill(workspace, skill, normalized_name, state);
    }
    if state.errors.len() > agent_error_count {
        if let Some(file) = state.files.iter_mut().find(|file| file.path == AGENT_FILE) {
            file.valid = false;
        }
    }
}

fn validate_remaining_workspace_files(
    workspace: &Path,
    workspace_files: Vec<PathBuf>,
    state: &mut WorkspaceValidationState,
) {
    let mut skill_bundle_file_counts = state
        .declared_skill_roots
        .iter()
        .map(|root| (root.clone(), 1_usize))
        .collect::<BTreeMap<_, _>>();
    for relative in workspace_files {
        if state.expected_files.contains(&relative) {
            continue;
        }
        if let Some(skill_root) = state
            .declared_skill_roots
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
                state.errors.push(format!(
                    "Skill support file is invalid or exceeds bundle limits: {}",
                    relative.display()
                ));
            }
            state.record_file(
                relative.to_string_lossy().to_string(),
                "skill-support",
                within_limits,
            );
            continue;
        }
        state.errors.push(format!(
            "Unsupported file in Kordi Factory draft: {}",
            relative.display()
        ));
        state.record_file(relative.to_string_lossy().to_string(), "unsupported", false);
    }
}

fn build_draft(
    agent_file: Option<DesktopAgentBuilderAgentFile>,
    system_prompt: Option<String>,
    skills: Vec<DesktopAgentBuilderSkillDraft>,
) -> Option<DesktopAgentBuilderDraft> {
    let (agent, system_prompt) = agent_file.zip(system_prompt)?;
    Some(DesktopAgentBuilderDraft {
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
        skills,
    })
}

pub(super) fn validate_workspace(
    workspace: &Path,
) -> (
    Option<DesktopAgentBuilderDraft>,
    DesktopAgentBuilderValidation,
) {
    let mut state = WorkspaceValidationState::new();
    let (fingerprint, workspace_files) = workspace_fingerprint(workspace).unwrap_or_else(|error| {
        state.errors.push(error);
        (String::new(), Vec::new())
    });
    let agent_file = load_agent_file(workspace, &mut state);
    let system_prompt = load_system_prompt(workspace, &mut state);
    if let Some(agent) = agent_file.as_ref() {
        validate_agent_contract(workspace, agent, &mut state);
    }
    validate_remaining_workspace_files(workspace, workspace_files, &mut state);
    let draft = build_draft(agent_file, system_prompt, state.draft_skills);

    (
        draft,
        DesktopAgentBuilderValidation {
            valid: state.errors.is_empty(),
            fingerprint,
            errors: state.errors,
            files: state.files,
        },
    )
}
