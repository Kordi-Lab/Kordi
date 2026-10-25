//! Agent instruction files Settings › Memory can import memories from.
//!
//! Discovery looks only at fixed names at the root of each project Kordi knows
//! and in the home folder; it never scans folders recursively. The import
//! itself runs in `memory_import_run`.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Files over this size are skipped: they are rarely instructions.
pub(crate) const MAX_AGENT_FILE_BYTES: u64 = 200 * 1024;

/// Agent instruction files at the root of a project.
const PROJECT_FILES: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    "CLAUDE.local.md",
    ".codex/AGENTS.md",
    ".claude/CLAUDE.md",
];

/// Agent instruction files in the home folder.
const HOME_FILES: &[&str] = &[
    "AGENTS.md",
    "CLAUDE.md",
    ".codex/AGENTS.md",
    ".claude/CLAUDE.md",
];

pub(crate) const HOME_PROJECT_NAME: &str = "Home";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstructionFile {
    pub path: String,
    /// The project root; `None` for files in the home folder.
    pub root: Option<String>,
    pub project_name: String,
    pub file_name: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified_at: u64,
}

fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| root.display().to_string())
}

fn file_entry(
    base: &Path,
    relative: &str,
    root: Option<&Path>,
    name: &str,
) -> Option<AgentInstructionFile> {
    let path = base.join(relative);
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AGENT_FILE_BYTES {
        return None;
    }
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default();
    Some(AgentInstructionFile {
        path: path.display().to_string(),
        root: root.map(|root| root.display().to_string()),
        project_name: name.to_string(),
        file_name: relative.to_string(),
        size: metadata.len(),
        modified_at,
    })
}

/// The agent instruction files of `roots` and `home`, projects first in the
/// given order, then the home folder. A project at the home folder itself is
/// listed once, as Home.
pub(crate) fn discover_agent_files(
    roots: &[PathBuf],
    home: Option<&Path>,
) -> Vec<AgentInstructionFile> {
    let mut files = Vec::new();
    let mut seen_roots = std::collections::HashSet::new();
    for root in roots {
        if root.as_os_str().is_empty() || Some(root.as_path()) == home || !seen_roots.insert(root) {
            continue;
        }
        let name = project_name(root);
        files.extend(
            PROJECT_FILES
                .iter()
                .filter_map(|relative| file_entry(root, relative, Some(root), &name)),
        );
    }
    if let Some(home) = home {
        files.extend(
            HOME_FILES
                .iter()
                .filter_map(|relative| file_entry(home, relative, None, HOME_PROJECT_NAME)),
        );
    }
    files
}

pub(crate) fn known_project_roots() -> Vec<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_default();
    kordi_cli::desktop_runtime::list_project_groups(&cwd)
        .map(|groups| {
            groups
                .into_iter()
                .map(|group| PathBuf::from(group.root.trim()))
                .filter(|root| root.is_absolute())
                .collect()
        })
        .unwrap_or_default()
}

/// The agent instruction files of the projects Kordi knows and the home folder.
#[tauri::command]
pub async fn desktop_memory_import_discover() -> Result<Vec<AgentInstructionFile>, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        discover_agent_files(&known_project_roots(), home.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn memory_import_discovers_root_files_of_projects_and_home_only() {
        let base =
            std::env::temp_dir().join(format!("kordi-memory-import-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        let project = base.join("work").join("launch-site");
        let other = base.join("work").join("plugins");
        write(&project.join("AGENTS.md"), "Use pnpm for every script.");
        write(
            &project.join(".claude/CLAUDE.md"),
            "Run the linter before a commit.",
        );
        write(&project.join("CLAUDE.local.md"), "Answer briefly.");
        write(
            &project.join("docs/AGENTS.md"),
            "Nested files are not read.",
        );
        write(&project.join("README.md"), "Not an agent file.");
        write(
            &other.join("CLAUDE.md"),
            &"x".repeat(MAX_AGENT_FILE_BYTES as usize + 1),
        );
        write(&home.join(".codex/AGENTS.md"), "Write in British English.");
        write(&home.join("CLAUDE.local.md"), "Home has no local file.");

        let roots = vec![
            project.clone(),
            other.clone(),
            project.clone(),
            home.clone(),
        ];
        let files = discover_agent_files(&roots, Some(&home));
        let names: Vec<(&str, &str)> = files
            .iter()
            .map(|file| (file.project_name.as_str(), file.file_name.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                ("launch-site", "AGENTS.md"),
                ("launch-site", "CLAUDE.local.md"),
                ("launch-site", ".claude/CLAUDE.md"),
                ("Home", ".codex/AGENTS.md"),
            ],
            "root files only, oversized files skipped, each project once, home last"
        );
        assert_eq!(
            files[0].root.as_deref(),
            Some(project.display().to_string().as_str())
        );
        assert_eq!(
            files[0].path,
            project.join("AGENTS.md").display().to_string()
        );
        assert_eq!(files[0].size, "Use pnpm for every script.".len() as u64);
        assert!(files[0].modified_at > 0);
        assert_eq!(files[3].root, None);
        assert!(discover_agent_files(&[], None).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
