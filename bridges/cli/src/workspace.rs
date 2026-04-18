use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use crate::error::WorkspaceError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectJson {
    pub project_id: String,
    pub slug: String,
    pub display_name: String,
    pub created_at: String,
}

/// Initialize a .bridges workspace inside `project_path`.
/// Creates directory structure and default files. Never overwrites existing files.
pub fn init_workspace(project_path: &Path, slug: &str) -> Result<(), WorkspaceError> {
    let bridges_dir = project_path.join(".bridges");
    let shared_dir = project_path.join(".shared");

    fs::create_dir_all(&bridges_dir).map_err(|source| WorkspaceError::CreateDir {
        path: bridges_dir.clone(),
        source,
    })?;
    let artifacts_dir = shared_dir.join("artifacts");
    fs::create_dir_all(&artifacts_dir).map_err(|source| WorkspaceError::CreateDir {
        path: artifacts_dir,
        source,
    })?;

    // project.json
    let project_json_path = bridges_dir.join("project.json");
    if !project_json_path.exists() {
        let project = ProjectJson {
            project_id: uuid::Uuid::new_v4().to_string(),
            slug: slug.to_string(),
            display_name: slug.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let json = serde_json::to_string_pretty(&project).map_err(WorkspaceError::Serialize)?;
        fs::write(&project_json_path, json).map_err(|source| WorkspaceError::Write {
            path: project_json_path.clone(),
            source,
        })?;
    }

    // Shared markdown files
    write_if_missing(
        &shared_dir.join("PROJECT.md"),
        &format!("# {}\n\nProject overview goes here.\n", slug),
    )?;
    write_if_missing(
        &shared_dir.join("TODOS.md"),
        "# TODOs\n\n- [ ] First task\n",
    )?;
    write_if_missing(
        &shared_dir.join("DEBATES.md"),
        "# Debates\n\nOpen discussions go here.\n",
    )?;
    write_if_missing(
        &shared_dir.join("DECISIONS.md"),
        "# Decisions\n\nFinalized decisions go here.\n",
    )?;
    write_if_missing(
        &shared_dir.join("PROGRESS.md"),
        "# Progress\n\nOptional shared status updates.\n",
    )?;
    write_if_missing(
        &shared_dir.join("CHANGELOG.md"),
        "# Changelog\n\nProject-level changes and decisions. Do not store chat transcripts here.\n",
    )?;
    Ok(())
}

fn write_if_missing(path: &Path, content: &str) -> Result<(), WorkspaceError> {
    if !path.exists() {
        fs::write(path, content).map_err(|source| WorkspaceError::Write {
            path: path.to_path_buf(),
            source,
        })?;
    }
    Ok(())
}

/// Read project.json from a workspace.
pub fn read_project_json(project_path: &Path) -> Result<Option<ProjectJson>, WorkspaceError> {
    let path = project_path.join(".bridges").join("project.json");
    let data = match fs::read_to_string(&path) {
        Ok(data) => data,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(WorkspaceError::Read { path, source }),
    };
    let project =
        serde_json::from_str(&data).map_err(|source| WorkspaceError::Parse { path, source })?;
    Ok(Some(project))
}
