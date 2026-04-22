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
pub fn desktop_project_settings(project_root: Option<String>) -> Result<DesktopProjectSettings, String> {
    let root = resolve_project_root(project_root)?;
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
    settings.project_system_prompt = Some(system_prompt.trim().to_string()).filter(|value| !value.is_empty());
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
                    label: if label.is_empty() { "Source".to_string() } else { label },
                    path,
                    detail,
                })
            }
        })
        .collect();

    settings.save_project(&root).map_err(|err| err.to_string())?;
    Ok(load_project_settings_for_root(&root))
}
