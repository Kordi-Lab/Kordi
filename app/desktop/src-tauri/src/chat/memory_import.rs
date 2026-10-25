//! Agent instruction files Settings › Memory can import memories from.
//!
//! Discovery looks only at fixed names at the root of each project Kordi knows
//! and in the home folder, and at the folders where other coding agents keep
//! instructions and memories (`memory_import_apps`); it never scans folders
//! recursively. The import itself runs in `memory_import_run`.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::memory_import_apps::{
    home_app_files, project_app_files, source_rank, CHOSEN, PROJECT_FILE,
};

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

/// Agent instruction files at the root of the home folder; the agents' own
/// folders are in `memory_import_apps`.
const HOME_FILES: &[&str] = &["AGENTS.md", "CLAUDE.md"];

pub(crate) const HOME_PROJECT_NAME: &str = "Home";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstructionFile {
    pub path: String,
    /// The project root; `None` for files in the home folder.
    pub root: Option<String>,
    pub project_name: String,
    pub file_name: String,
    /// The app the file belongs to, such as "Claude Code"; the list is grouped by it.
    pub source: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified_at: u64,
}

pub(crate) fn project_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| root.display().to_string())
}

pub(crate) fn file_entry(
    base: &Path,
    relative: &str,
    root: Option<&Path>,
    name: &str,
    source: &str,
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
        source: source.to_string(),
        size: metadata.len(),
        modified_at,
    })
}

/// The agent instruction files of `roots` and `home`, grouped by app in
/// `source_rank` order; within an app, projects come first in the given
/// order, then the home folder. A project at the home folder itself is listed
/// once, as Home.
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
                .filter_map(|relative| file_entry(root, relative, Some(root), &name, PROJECT_FILE)),
        );
        files.extend(project_app_files(root, &name));
    }
    if let Some(home) = home {
        files.extend(HOME_FILES.iter().filter_map(|relative| {
            file_entry(home, relative, None, HOME_PROJECT_NAME, PROJECT_FILE)
        }));
        files.extend(home_app_files(home));
    }
    files.sort_by_key(|file| source_rank(&file.source));
    files
}

/// A file the person chose: its folder is the project, or Home for a file
/// directly in the home folder. Size and date are zero when unreadable; the
/// import checks the file again with `chosen_agent_file`.
pub(crate) fn chosen_row(path: &Path, home: Option<&Path>) -> AgentInstructionFile {
    let folder = path.parent().unwrap_or(path);
    let in_home = Some(folder) == home;
    let metadata = std::fs::metadata(path).ok();
    AgentInstructionFile {
        path: path.display().to_string(),
        root: (!in_home).then(|| folder.display().to_string()),
        project_name: if in_home {
            HOME_PROJECT_NAME.to_string()
        } else {
            project_name(folder)
        },
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        source: CHOSEN.to_string(),
        size: metadata.as_ref().map(|data| data.len()).unwrap_or_default(),
        modified_at: metadata
            .and_then(|data| data.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
    }
}

/// A chosen file the import may read: a regular `.md` file under the home
/// folder, not empty and at most 200 KB.
pub(crate) fn chosen_agent_file(
    path: &Path,
    home: Option<&Path>,
) -> Result<AgentInstructionFile, String> {
    let refused = || "This file can't be imported.".to_string();
    let home = home
        .and_then(|home| home.canonicalize().ok())
        .ok_or_else(refused)?;
    let resolved = path.canonicalize().map_err(|_| refused())?;
    let is_markdown = resolved
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    let metadata = std::fs::metadata(&resolved).map_err(|_| refused())?;
    if !path.is_absolute()
        || !is_markdown
        || resolved == home
        || !resolved.starts_with(&home)
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_AGENT_FILE_BYTES
    {
        return Err(refused());
    }
    Ok(chosen_row(&resolved, Some(&home)))
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

#[cfg(target_os = "macos")]
fn choose_markdown_paths() -> Result<Vec<PathBuf>, String> {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSArray, NSString, NSURL};

    // SAFETY: called only from Tauri's with_webview main-thread closure.
    // Retained objects stay on that thread; only the selected paths leave it.
    unsafe {
        let pointer: *mut AnyObject = msg_send![class!(NSOpenPanel), openPanel];
        let panel = Retained::retain(pointer).ok_or("Could not open the file picker.")?;
        let types = NSArray::from_retained_slice(&[NSString::from_str("md")]);
        let _: () = msg_send![&*panel, setCanChooseFiles: true];
        let _: () = msg_send![&*panel, setCanChooseDirectories: false];
        let _: () = msg_send![&*panel, setAllowsMultipleSelection: true];
        let _: () = msg_send![&*panel, setAllowedFileTypes: &*types];
        let response: isize = msg_send![&*panel, runModal];
        if response != 1 {
            return Ok(Vec::new());
        }
        let urls: Retained<NSArray<NSURL>> = msg_send![&*panel, URLs];
        Ok(urls
            .iter()
            .filter_map(|url| url.path())
            .map(|path| PathBuf::from(path.to_string()))
            .collect())
    }
}

/// Opens the file picker for `.md` files and returns the chosen ones as rows.
#[tauri::command]
pub async fn desktop_memory_import_choose(
    window: tauri::WebviewWindow,
) -> Result<Vec<AgentInstructionFile>, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |_| {
                let _ = sender.send(choose_markdown_paths());
            })
            .map_err(|_| "Could not open the file picker.")?;
        let paths = receiver
            .await
            .map_err(|_| "The file picker was interrupted.")??;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Ok(paths
            .iter()
            .map(|path| chosen_row(path, home.as_deref()))
            .collect())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("Choosing files is unavailable on this platform.".into())
    }
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
        let names: Vec<(&str, &str, &str)> = files
            .iter()
            .map(|file| {
                (
                    file.source.as_str(),
                    file.project_name.as_str(),
                    file.file_name.as_str(),
                )
            })
            .collect();
        assert_eq!(
            names,
            vec![
                ("Codex", "Home", ".codex/AGENTS.md"),
                ("Project file", "launch-site", "AGENTS.md"),
                ("Project file", "launch-site", "CLAUDE.local.md"),
                ("Project file", "launch-site", ".claude/CLAUDE.md"),
            ],
            "root files only, oversized files skipped, each project once, grouped by app"
        );
        let files = &files[1..];
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
        assert!(discover_agent_files(&[], None).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn memory_import_accepts_chosen_markdown_files_under_home_only() {
        let base =
            std::env::temp_dir().join(format!("kordi-memory-import-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        let notes = home.join("notes").join("rules.md");
        let home_file = home.join("rules.md");
        write(&notes, "Use pnpm for every script.");
        write(&home_file, "Write in British English.");
        write(&home.join("notes/rules.txt"), "Not markdown.");
        write(&home.join("notes/empty.md"), "");
        write(
            &home.join("notes/large.md"),
            &"x".repeat(MAX_AGENT_FILE_BYTES as usize + 1),
        );
        write(&base.join("outside/rules.md"), "Outside home.");
        std::fs::create_dir_all(home.join("folder.md")).unwrap();

        let file = chosen_agent_file(&notes, Some(&home)).unwrap();
        assert_eq!(file.project_name, "notes");
        assert_eq!(file.file_name, "rules.md");
        assert_eq!(file.size, "Use pnpm for every script.".len() as u64);
        let home_row = chosen_agent_file(&home_file, Some(&home)).unwrap();
        assert_eq!(
            (home_row.project_name.as_str(), home_row.root),
            ("Home", None)
        );
        for refused in [
            home.join("notes/rules.txt"),
            home.join("notes/empty.md"),
            home.join("notes/large.md"),
            home.join("notes/missing.md"),
            home.join("folder.md"),
            base.join("outside/rules.md"),
            home.join("notes/../../outside/rules.md"),
            PathBuf::from("notes/rules.md"),
        ] {
            assert!(
                chosen_agent_file(&refused, Some(&home)).is_err(),
                "{refused:?} is refused"
            );
        }
        assert!(chosen_agent_file(&notes, None).is_err());
        let row = chosen_row(&home.join("notes/missing.md"), Some(&home));
        assert_eq!((row.project_name.as_str(), row.size), ("notes", 0));
        let _ = std::fs::remove_dir_all(&base);
    }
}
