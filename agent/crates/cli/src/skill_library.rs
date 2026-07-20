use std::collections::BTreeSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use chrono::Utc;
use kordi_core::config;
use kordi_core::settings::Settings;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const PROVENANCE_FILE: &str = ".kordi-skill.json";
const MAX_BUNDLE_FILES: usize = 128;
const MAX_BUNDLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillInstallScope {
    Global,
    Project,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source_label: String,
    pub source_path: String,
    pub scope: String,
    pub origin: String,
    pub enabled: bool,
    pub editable: bool,
    pub removable: bool,
    pub version: Option<String>,
    pub provider: Option<String>,
    pub owner: Option<String>,
    pub source_url: Option<String>,
    pub digest: Option<String>,
    pub file_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryFile {
    pub path: String,
    pub size: u64,
    pub text: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryDetail {
    pub skill: SkillLibraryEntry,
    pub files: Vec<SkillLibraryFile>,
    pub skill_md: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillBundleFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillBundle {
    pub name: String,
    pub description: String,
    pub slug: String,
    pub origin: String,
    pub provider: Option<String>,
    pub owner: Option<String>,
    pub version: Option<String>,
    pub source_url: Option<String>,
    pub digest: Option<String>,
    pub files: Vec<SkillBundleFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SkillProvenance {
    origin: String,
    provider: Option<String>,
    owner: Option<String>,
    slug: String,
    version: Option<String>,
    source_url: Option<String>,
    digest: Option<String>,
    installed_at: String,
}

pub fn list_skills(cwd: &Path) -> Result<Vec<SkillLibraryEntry>> {
    let settings = Settings::load_merged(cwd);
    let disabled = settings
        .disabled_skills
        .iter()
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect::<BTreeSet<_>>();
    let mut entries = crate::extensions::discover_skills_for_library(cwd)?
        .into_iter()
        .map(|definition| {
            let source_path = normalize_path(PathBuf::from(&definition.info.source_info.path));
            let normalized_name = definition.info.name.trim().to_ascii_lowercase();
            let provenance = read_provenance(&source_path);
            let scope = skill_scope(&source_path, cwd, &definition.info.source_info.source);
            let origin = provenance
                .as_ref()
                .map(|value| value.origin.clone())
                .unwrap_or_else(|| infer_origin(&source_path, cwd));
            let managed = is_managed_skill_path(&source_path, cwd);
            let file_count = skill_files(&source_path)
                .map(|files| files.len())
                .unwrap_or(1);
            SkillLibraryEntry {
                id: skill_id(&source_path),
                name: definition.info.name,
                description: definition.info.description,
                source_label: definition.info.source_info.source,
                source_path: source_path.display().to_string(),
                scope,
                enabled: !disabled.contains(&normalized_name),
                editable: managed && origin == "built",
                removable: managed && provenance.is_some(),
                version: provenance.as_ref().and_then(|value| value.version.clone()),
                provider: provenance.as_ref().and_then(|value| value.provider.clone()),
                owner: provenance.as_ref().and_then(|value| value.owner.clone()),
                source_url: provenance
                    .as_ref()
                    .and_then(|value| value.source_url.clone()),
                digest: provenance.as_ref().and_then(|value| value.digest.clone()),
                origin,
                file_count,
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.source_path.cmp(&right.source_path))
    });
    Ok(entries)
}

pub fn skill_detail(cwd: &Path, skill_id_value: &str) -> Result<SkillLibraryDetail> {
    let skill = find_skill(cwd, skill_id_value)?;
    let source_path = PathBuf::from(&skill.source_path);
    let files = skill_files(&source_path)?;
    let skill_md = read_limited_text(&source_path)?;
    Ok(SkillLibraryDetail {
        skill,
        files,
        skill_md,
    })
}

pub fn read_skill_file(cwd: &Path, skill_id_value: &str, relative_path: &str) -> Result<String> {
    let skill = find_skill(cwd, skill_id_value)?;
    let resolved = resolved_skill_file(&skill, relative_path)?;
    read_limited_text(&resolved)
}

pub fn write_skill_file(
    cwd: &Path,
    skill_id_value: &str,
    relative_path: &str,
    content: &str,
) -> Result<SkillLibraryDetail> {
    if content.len() as u64 > MAX_TEXT_PREVIEW_BYTES {
        bail!("Skill file is too large to save");
    }
    let skill = find_skill(cwd, skill_id_value)?;
    if !skill.editable {
        bail!("Only skills built in Kordi Factory can be edited here");
    }
    let resolved = resolved_skill_file(&skill, relative_path)?;
    if !is_text_path(&resolved) {
        bail!("Binary skill files cannot be edited in Kordi");
    }
    if relative_path == "SKILL.md" {
        let declared_name = frontmatter_field(content, "name")
            .ok_or_else(|| anyhow::anyhow!("SKILL.md must declare a frontmatter name"))?;
        if clean_slug(&declared_name) != clean_slug(&skill.name) {
            bail!("SKILL.md name must remain '{}'", clean_slug(&skill.name));
        }
        if frontmatter_field(content, "description").is_none_or(|value| value.trim().is_empty()) {
            bail!("SKILL.md must declare a frontmatter description");
        }
    }
    let temporary = resolved.with_file_name(format!(
        ".{}.save-{}",
        resolved
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill"),
        uuid::Uuid::new_v4()
    ));
    fs::write(&temporary, content)?;
    if let Err(error) = fs::rename(&temporary, &resolved) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    skill_detail(cwd, skill_id_value)
}

pub fn set_skill_enabled(name: &str, enabled: bool) -> Result<()> {
    let normalized = name.trim();
    if normalized.is_empty() {
        bail!("Skill name is required");
    }
    let mut settings = Settings::load_global();
    let is_disabled = settings
        .disabled_skills
        .iter()
        .any(|entry| entry.trim().eq_ignore_ascii_case(normalized));
    if enabled && is_disabled {
        settings
            .disabled_skills
            .retain(|entry| !entry.trim().eq_ignore_ascii_case(normalized));
    } else if !enabled && !is_disabled {
        settings.disabled_skills.push(normalized.to_string());
    }
    settings.save_global().map_err(Into::into)
}

pub fn install_skill_bundle(
    cwd: &Path,
    scope: SkillInstallScope,
    bundle: SkillBundle,
) -> Result<SkillLibraryEntry> {
    validate_bundle(&bundle)?;
    let root = match scope {
        SkillInstallScope::Global => config::preferred_global_resource_dir("skills"),
        SkillInstallScope::Project => config::preferred_project_resource_dir(cwd, "skills"),
    };
    let slug = clean_slug(&bundle.slug);
    install_skill_bundle_at(&root, bundle)?;
    let installed_path = root.join(slug).join("SKILL.md");
    let installed_id = skill_id(&normalize_path(installed_path));
    find_skill(cwd, &installed_id)
}

pub fn remove_skill(cwd: &Path, skill_id_value: &str) -> Result<bool> {
    let skill = find_skill(cwd, skill_id_value)?;
    if !skill.removable {
        bail!("This skill is managed by its source and cannot be removed here");
    }
    let source_path = normalize_path(PathBuf::from(skill.source_path));
    if !is_managed_skill_path(&source_path, cwd) {
        bail!("Skill path is outside Kordi-managed storage");
    }
    let root = skill_root(&source_path);
    if !root.join(PROVENANCE_FILE).is_file() {
        bail!("Skill provenance is missing; Kordi will not remove an unmanaged directory");
    }
    fs::remove_dir_all(root)?;
    Ok(true)
}

fn install_skill_bundle_at(root: &Path, mut bundle: SkillBundle) -> Result<()> {
    let slug = clean_slug(&bundle.slug);
    fs::create_dir_all(root)?;
    bundle
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    let digest = bundle
        .digest
        .clone()
        .unwrap_or_else(|| bundle_digest(&bundle.files));
    let suffix = uuid::Uuid::new_v4();
    let stage = root.join(format!(".{slug}.install-{suffix}"));
    let backup = root.join(format!(".{slug}.backup-{suffix}"));
    let target = root.join(&slug);

    fs::create_dir(&stage)?;
    let install_result = (|| -> Result<()> {
        for file in &bundle.files {
            let relative = checked_relative_path(&file.path)?;
            let destination = stage.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(destination, &file.bytes)?;
        }
        let provenance = SkillProvenance {
            origin: bundle.origin,
            provider: bundle.provider,
            owner: bundle.owner,
            slug: slug.clone(),
            version: bundle.version,
            source_url: bundle.source_url,
            digest: Some(digest),
            installed_at: Utc::now().to_rfc3339(),
        };
        fs::write(
            stage.join(PROVENANCE_FILE),
            format!("{}\n", serde_json::to_string_pretty(&provenance)?),
        )?;

        if target.exists() {
            if !target.join(PROVENANCE_FILE).is_file() {
                bail!(
                    "A local skill already uses the name '{slug}'. Rename the new skill before installing it."
                );
            }
            fs::rename(&target, &backup)?;
        }
        if let Err(error) = fs::rename(&stage, &target) {
            if backup.exists() {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error.into());
        }
        if backup.exists() {
            fs::remove_dir_all(&backup)?;
        }
        Ok(())
    })();
    if install_result.is_err() && stage.exists() {
        let _ = fs::remove_dir_all(stage);
    }
    install_result
}

fn validate_bundle(bundle: &SkillBundle) -> Result<()> {
    let slug = clean_slug(&bundle.slug);
    if slug.is_empty() || slug != bundle.slug {
        bail!("Skill slug must contain lowercase letters, numbers, and hyphens only");
    }
    if bundle.name.trim().is_empty() {
        bail!("Skill name is required");
    }
    if bundle.files.is_empty() || bundle.files.len() > MAX_BUNDLE_FILES {
        bail!("Skill bundle must contain between 1 and {MAX_BUNDLE_FILES} files");
    }
    let total_bytes = bundle
        .files
        .iter()
        .try_fold(0usize, |total, file| total.checked_add(file.bytes.len()))
        .ok_or_else(|| anyhow::anyhow!("Skill bundle is too large"))?;
    if total_bytes > MAX_BUNDLE_BYTES {
        bail!("Skill bundle exceeds the 4 MB limit");
    }
    let mut seen = BTreeSet::new();
    for file in &bundle.files {
        let relative = checked_relative_path(&file.path)?;
        let key = relative.to_string_lossy().to_string();
        if !seen.insert(key.clone()) {
            bail!("Skill bundle contains the duplicate path '{key}'");
        }
    }
    let skill_md = bundle
        .files
        .iter()
        .find(|file| file.path == "SKILL.md")
        .ok_or_else(|| anyhow::anyhow!("Skill bundle must include SKILL.md at its root"))?;
    let skill_text =
        std::str::from_utf8(&skill_md.bytes).context("SKILL.md must be valid UTF-8 text")?;
    let frontmatter_name = frontmatter_field(skill_text, "name")
        .ok_or_else(|| anyhow::anyhow!("SKILL.md must declare a frontmatter name"))?;
    if clean_slug(&frontmatter_name) != slug {
        bail!("SKILL.md name must match the install slug '{slug}'");
    }
    if frontmatter_field(skill_text, "description").is_none_or(|value| value.trim().is_empty()) {
        bail!("SKILL.md must declare a frontmatter description");
    }
    Ok(())
}

fn find_skill(cwd: &Path, skill_id_value: &str) -> Result<SkillLibraryEntry> {
    list_skills(cwd)?
        .into_iter()
        .find(|entry| entry.id == skill_id_value)
        .ok_or_else(|| anyhow::anyhow!("Skill is no longer available"))
}

fn read_provenance(source_path: &Path) -> Option<SkillProvenance> {
    let path = skill_root(source_path).join(PROVENANCE_FILE);
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn resolved_skill_file(skill: &SkillLibraryEntry, relative_path: &str) -> Result<PathBuf> {
    let source_path = normalize_path(PathBuf::from(&skill.source_path));
    let relative = checked_relative_path(relative_path)?;
    let root = skill_root(&source_path);
    let target = if source_path.file_name().and_then(|value| value.to_str()) == Some("SKILL.md") {
        root.join(&relative)
    } else if source_path
        .file_name()
        .is_some_and(|name| relative == Path::new(name))
    {
        source_path.clone()
    } else {
        bail!("Skill file is unavailable");
    };
    let resolved = normalize_path(target);
    if !resolved.starts_with(&root) || !resolved.is_file() {
        bail!("Skill file is unavailable");
    }
    Ok(resolved)
}

fn skill_scope(path: &Path, cwd: &Path, source_label: &str) -> String {
    if source_label.starts_with("package:") {
        return "package".to_string();
    }
    if config::project_resource_dir_candidates(cwd, "skills")
        .into_iter()
        .map(normalize_path)
        .any(|root| path.starts_with(root))
    {
        return "project".to_string();
    }
    if config::global_resource_dir_candidates("skills")
        .into_iter()
        .map(normalize_path)
        .any(|root| path.starts_with(root))
    {
        return "global".to_string();
    }
    if path.to_string_lossy().contains("/.agents/skills/") {
        return "shared".to_string();
    }
    "external".to_string()
}

fn infer_origin(path: &Path, cwd: &Path) -> String {
    if skill_scope(path, cwd, "") == "project" {
        "project".to_string()
    } else {
        "installed".to_string()
    }
}

fn is_managed_skill_path(path: &Path, cwd: &Path) -> bool {
    config::global_resource_dir_candidates("skills")
        .into_iter()
        .chain(config::project_resource_dir_candidates(cwd, "skills"))
        .map(normalize_path)
        .any(|root| path.starts_with(root))
}

fn skill_root(source_path: &Path) -> PathBuf {
    source_path.parent().unwrap_or(source_path).to_path_buf()
}

fn skill_files(source_path: &Path) -> Result<Vec<SkillLibraryFile>> {
    if source_path.file_name().and_then(|value| value.to_str()) != Some("SKILL.md") {
        let metadata = fs::metadata(source_path)?;
        return Ok(vec![SkillLibraryFile {
            path: source_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill.md")
                .to_string(),
            size: metadata.len(),
            text: is_text_path(source_path),
        }]);
    }
    let root = skill_root(source_path);
    let mut pending = vec![root.clone()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file()
                || path.file_name().and_then(|value| value.to_str()) == Some(PROVENANCE_FILE)
            {
                continue;
            }
            let relative = path.strip_prefix(&root)?.to_string_lossy().to_string();
            files.push(SkillLibraryFile {
                path: relative,
                size: entry.metadata()?.len(),
                text: is_text_path(&path),
            });
            if files.len() >= MAX_BUNDLE_FILES {
                break;
            }
        }
        if files.len() >= MAX_BUNDLE_FILES {
            break;
        }
    }
    files.sort_by(|left, right| {
        (left.path != "SKILL.md")
            .cmp(&(right.path != "SKILL.md"))
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(files)
}

fn is_text_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some(
            "md" | "txt"
                | "json"
                | "yaml"
                | "yml"
                | "toml"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "py"
                | "rs"
                | "sh"
                | "css"
                | "html"
        )
    )
}

fn read_limited_text(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_TEXT_PREVIEW_BYTES {
        bail!("Skill file is too large to preview");
    }
    fs::read_to_string(path).with_context(|| format!("Unable to read {}", path.display()))
}

fn checked_relative_path(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value.trim());
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        bail!("Skill bundle contains an unsafe file path");
    }
    Ok(path)
}

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

fn frontmatter_field(content: &str, field: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == field {
            return Some(
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    None
}

fn bundle_digest(files: &[SkillBundleFile]) -> String {
    let mut hasher = Sha256::new();
    for file in files {
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(&file.bytes);
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn skill_id(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    format!("skill:{:x}", hasher.finalize())
}

fn normalize_path(path: PathBuf) -> PathBuf {
    fs::canonicalize(&path).unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_bundle() -> SkillBundle {
        SkillBundle {
            name: "Repository review".to_string(),
            description: "Review a repository".to_string(),
            slug: "repository-review".to_string(),
            origin: "community".to_string(),
            provider: Some("clawhub".to_string()),
            owner: Some("kordi".to_string()),
            version: Some("1.0.0".to_string()),
            source_url: Some("https://example.com/skill".to_string()),
            digest: None,
            files: vec![SkillBundleFile {
                path: "SKILL.md".to_string(),
                bytes: b"---\nname: repository-review\ndescription: Review a repository safely.\n---\n\n# Repository review\n".to_vec(),
            }],
        }
    }

    #[test]
    fn bundle_validation_rejects_traversal_and_name_mismatch() {
        let mut traversal = valid_bundle();
        traversal.files.push(SkillBundleFile {
            path: "../escape.sh".to_string(),
            bytes: Vec::new(),
        });
        assert!(validate_bundle(&traversal).is_err());

        let mut mismatch = valid_bundle();
        mismatch.slug = "different".to_string();
        assert!(validate_bundle(&mismatch).is_err());
    }

    #[test]
    fn install_is_provenance_backed_and_replaces_managed_versions() {
        let root = tempfile::tempdir().expect("skill root");
        install_skill_bundle_at(root.path(), valid_bundle()).expect("install skill");
        let target = root.path().join("repository-review");
        assert!(target.join("SKILL.md").is_file());
        assert!(target.join(PROVENANCE_FILE).is_file());

        let mut updated = valid_bundle();
        updated.version = Some("1.1.0".to_string());
        updated.files[0].bytes.extend_from_slice(b"\nUpdated.\n");
        install_skill_bundle_at(root.path(), updated).expect("update managed skill");
        assert!(
            fs::read_to_string(target.join("SKILL.md"))
                .expect("read installed skill")
                .contains("Updated.")
        );
    }
}
