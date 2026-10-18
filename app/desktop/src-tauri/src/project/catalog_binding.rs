//! Binds projects that another Mac on the account publishes to folders on this Mac.
//!
//! Project catalogs carry only `sha256(root)`; roots stay on the Mac that owns
//! them. This Mac hashes its own candidate folders to find the same project.
use super::{
    load_project_settings_for_root, register_project_folder, resolve_explicit_project_folder,
    DesktopProjectSettings,
};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Common folders for code under the home folder. Documents, Desktop and
/// Downloads are excluded because reading them triggers a macOS privacy prompt.
const SEARCH_FOLDERS: &[&str] = &[
    "",
    "Developer",
    "Projects",
    "projects",
    "Code",
    "code",
    "src",
    "repos",
    "workspace",
    "GitHub",
    "github",
    "git",
    "KordiProjects",
];
const MAX_HINTS: usize = 64;
const MAX_SESSIONS: usize = 4000;

/// The opaque catalog ID of a folder, identical to the desktop catalog publisher.
pub(crate) fn catalog_id(root: &Path) -> String {
    hex::encode(Sha256::digest(root.display().to_string().as_bytes()))
}

fn valid_catalog_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_folder_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

fn candidate_folders(name: &str, hints: &[String], home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let named = valid_folder_name(name).then(|| name.trim());
    for hint in hints.iter().take(MAX_HINTS) {
        let hint = Path::new(hint.trim());
        if !hint.is_absolute() {
            continue;
        }
        for ancestor in hint.ancestors().take(6) {
            candidates.push(ancestor.to_path_buf());
            if let (Some(parent), Some(name)) = (ancestor.parent(), named) {
                candidates.push(parent.join(name));
            }
        }
    }
    if let (Some(home), Some(name)) = (home, named) {
        candidates.extend(
            SEARCH_FOLDERS
                .iter()
                .map(|folder| home.join(folder).join(name)),
        );
    }
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

/// The local folder whose catalog ID matches, searching only bounded candidates.
fn find_catalog_root(
    id: &str,
    name: &str,
    hints: &[String],
    home: Option<&Path>,
) -> Option<PathBuf> {
    candidate_folders(name, hints, home)
        .into_iter()
        .filter(|candidate| candidate.is_dir())
        .filter_map(|candidate| std::fs::canonicalize(candidate).ok())
        .find(|root| catalog_id(root) == id)
}

fn project_registration_database() -> PathBuf {
    kordi_core::config::session_db_path(&kordi_core::settings::Settings::load_global().storage)
}

/// True when this Mac has the project and the user archived it.
fn archived_locally(database: &Path, root: &Path) -> Result<bool, String> {
    let connection = kordi_session::store::open_db(database).map_err(|error| error.to_string())?;
    let archived: Option<bool> = connection
        .query_row(
            "SELECT archived_at IS NOT NULL FROM projects WHERE root = ?1",
            [root.display().to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(archived.unwrap_or(false))
}

fn resolve_catalog_project(
    database: &Path,
    id: &str,
    name: &str,
    hints: &[String],
    home: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    if !valid_catalog_id(id) {
        return Err("Invalid project.".to_string());
    }
    let Some(root) = find_catalog_root(&id.to_ascii_lowercase(), name, hints, home) else {
        return Ok(None);
    };
    // Automatic binding never restores a project the user archived on this Mac.
    if archived_locally(database, &root)? {
        return Ok(None);
    }
    Ok(Some(root))
}

/// Find and register a project another Mac publishes when its folder exists here.
#[tauri::command]
pub async fn desktop_project_resolve_catalog(
    catalog_id: String,
    name: String,
    hints: Vec<String>,
) -> Result<Option<DesktopProjectSettings>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = kordi_core::local_paths::home_directory();
        let Some(root) = resolve_catalog_project(
            &project_registration_database(),
            &catalog_id,
            &name,
            &hints,
            home.as_deref(),
        )?
        else {
            return Ok(None);
        };
        register_project_folder(&root, None)?;
        Ok(Some(load_project_settings_for_root(&root)))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn located_catalog_root(id: &str, folder_path: &str) -> Result<PathBuf, String> {
    if !valid_catalog_id(id) {
        return Err("Invalid project.".to_string());
    }
    let root = resolve_explicit_project_folder(folder_path, false, false)?;
    if catalog_id(&root) != id.to_ascii_lowercase() {
        return Err("This folder is not the project's folder. Choose the folder the project uses on your other Mac.".to_string());
    }
    Ok(root)
}

/// Bind a project another Mac publishes to a folder the user picked.
#[tauri::command]
pub fn desktop_project_locate_catalog(
    catalog_id: String,
    folder_path: String,
) -> Result<DesktopProjectSettings, String> {
    let root = located_catalog_root(&catalog_id, &folder_path)?;
    register_project_folder(&root, None)?;
    Ok(load_project_settings_for_root(&root))
}

fn session_workspace_ids(
    database: &Path,
    session_ids: &[String],
) -> Result<HashMap<String, String>, String> {
    let connection = kordi_session::store::open_db(database).map_err(|error| error.to_string())?;
    let mut ids = HashMap::new();
    for session_id in session_ids.iter().take(MAX_SESSIONS) {
        let Some(row) = kordi_session::store::get_session(&connection, session_id)
            .map_err(|error| error.to_string())?
        else {
            continue;
        };
        let root = row.project_root.as_deref().map(str::trim).unwrap_or("");
        let cwd = row.cwd.trim();
        if row.session_scope != "project" || root.is_empty() || cwd.is_empty() || cwd == root {
            continue;
        }
        // Same rule as the runtime: a worktree counts only when it is the recorded selection.
        let selected = connection
            .query_row(
                "SELECT json_extract(payload,'$.data.path') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='desktop_execution_workspace' ORDER BY seq DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        if selected.as_deref() == Some(cwd) {
            ids.insert(session_id.clone(), catalog_id(Path::new(cwd)));
        }
    }
    Ok(ids)
}

/// Opaque worktree IDs of project sessions that run outside the project folder.
#[tauri::command]
pub async fn desktop_project_session_workspace_ids(
    session_ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_workspace_ids(&project_registration_database(), &session_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "catalog_binding_tests.rs"]
mod tests;
