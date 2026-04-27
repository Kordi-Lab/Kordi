use kordi_core::settings::{ProjectSharedSource, Settings};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProjectSource {
    pub label: String,
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProjectSettings {
    pub root: String,
    pub name: String,
    pub context: String,
    pub system_prompt: String,
    pub shared_sources: Vec<DesktopProjectSource>,
}

fn resolve_project_root(project_root: Option<String>) -> Result<PathBuf, String> {
    let base = project_root
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|err| err.to_string())?);
    Ok(kordi_core::config::project_root(&base).unwrap_or(base))
}

fn expand_home_path(raw_path: &str) -> PathBuf {
    if raw_path == "~" {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(raw_path));
    }
    if let Some(rest) = raw_path.strip_prefix("~/") {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(raw_path));
    }
    PathBuf::from(raw_path)
}

fn resolve_explicit_project_folder(raw_path: &str, create: bool) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Project folder is required".to_string());
    }

    let candidate = expand_home_path(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(candidate)
    };

    if create {
        std::fs::create_dir_all(&resolved).map_err(|err| err.to_string())?;
    }

    if !resolved.exists() {
        return Err("Project folder does not exist".to_string());
    }
    if !resolved.is_dir() {
        return Err("Project path must be a folder".to_string());
    }

    Ok(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

fn sanitize_project_slug(value: &str) -> String {
    let slug = value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    }
}

fn default_new_project_parent() -> PathBuf {
    // Avoid spaces in app-managed project paths so generated shell commands,
    // file references, and agent prompts stay simple and copy-safe.
    const DEFAULT_PROJECTS_DIR: &str = "KordiProjects";
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(DEFAULT_PROJECTS_DIR))
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(DEFAULT_PROJECTS_DIR)
        })
}

fn register_project_folder(root: &std::path::Path, name: Option<&str>) -> Result<(), String> {
    kordi_cli::desktop_runtime::register_project(root, name).map_err(|err| err.to_string())?;
    if let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) {
        let mut settings = Settings::load_project(root);
        if settings
            .project_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            settings.project_name = Some(name.to_string());
            settings.save_project(root).map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

fn load_project_settings_for_root(root: &std::path::Path) -> DesktopProjectSettings {
    let settings = Settings::load_project(root);
    let name = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Project".to_string());

    DesktopProjectSettings {
        root: root.display().to_string(),
        name,
        context: settings.project_context.unwrap_or_default(),
        system_prompt: settings.project_system_prompt.unwrap_or_default(),
        shared_sources: settings
            .project_shared_sources
            .into_iter()
            .map(|source| DesktopProjectSource {
                label: source.label,
                path: source.path,
                detail: source.detail,
            })
            .collect(),
    }
}

#[tauri::command]
pub fn desktop_project_settings(
    project_root: Option<String>,
) -> Result<DesktopProjectSettings, String> {
    let root = resolve_project_root(project_root)?;
    Ok(load_project_settings_for_root(&root))
}

#[tauri::command]
pub fn desktop_project_create_from_folder(
    folder_path: String,
    name: Option<String>,
) -> Result<DesktopProjectSettings, String> {
    let root = resolve_explicit_project_folder(&folder_path, false)?;
    let trimmed_name = name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    register_project_folder(&root, trimmed_name)?;
    Ok(load_project_settings_for_root(&root))
}

#[tauri::command]
pub fn desktop_project_create_new(
    name: String,
    parent_dir: Option<String>,
) -> Result<DesktopProjectSettings, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("Project name is required".to_string());
    }

    let parent = parent_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| resolve_explicit_project_folder(value, true))
        .transpose()?
        .unwrap_or_else(default_new_project_parent);
    std::fs::create_dir_all(&parent).map_err(|err| err.to_string())?;

    let root = parent.join(sanitize_project_slug(trimmed_name));
    std::fs::create_dir_all(&root).map_err(|err| err.to_string())?;
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    register_project_folder(&root, Some(trimmed_name))?;
    Ok(load_project_settings_for_root(&root))
}

#[tauri::command]
pub fn desktop_save_project_settings(
    project_root: Option<String>,
    name: String,
    context: String,
    system_prompt: String,
    shared_sources: Vec<DesktopProjectSource>,
) -> Result<DesktopProjectSettings, String> {
    let root = resolve_project_root(project_root)?;
    let mut settings = Settings::load_project(&root);

    settings.project_name = Some(name.trim().to_string()).filter(|value| !value.is_empty());
    settings.project_context = Some(context.trim().to_string()).filter(|value| !value.is_empty());
    settings.project_system_prompt =
        Some(system_prompt.trim().to_string()).filter(|value| !value.is_empty());
    settings.project_shared_sources = shared_sources
        .into_iter()
        .filter_map(|source| {
            let label = source.label.trim().to_string();
            let path = source.path.and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
            let detail = source.detail.and_then(|value| {
                let trimmed = value.trim().to_string();
                (!trimmed.is_empty()).then_some(trimmed)
            });
            if label.is_empty() && path.is_none() && detail.is_none() {
                None
            } else {
                Some(ProjectSharedSource {
                    label: if label.is_empty() {
                        "Source".to_string()
                    } else {
                        label
                    },
                    path,
                    detail,
                })
            }
        })
        .collect();

    settings
        .save_project(&root)
        .map_err(|err| err.to_string())?;
    register_project_folder(&root, Some(&name))?;
    Ok(load_project_settings_for_root(&root))
}
