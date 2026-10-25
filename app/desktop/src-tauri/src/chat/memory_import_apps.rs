//! Where other coding agents keep instructions and memories on this Mac, for
//! Settings › Memory › Import. Each folder is read one level deep only.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use super::memory_import::{file_entry, project_name, AgentInstructionFile, HOME_PROJECT_NAME};

pub(crate) const CLAUDE_CODE: &str = "Claude Code";
pub(crate) const CODEX: &str = "Codex";
pub(crate) const CURSOR: &str = "Cursor";
pub(crate) const GEMINI: &str = "Gemini";
pub(crate) const COPILOT: &str = "Copilot";
pub(crate) const PROJECT_FILE: &str = "Project file";
pub(crate) const CHOSEN: &str = "Chosen files";

/// The order of the app groups in the list.
const SOURCE_ORDER: &[&str] = &[
    CLAUDE_CODE,
    CODEX,
    CURSOR,
    GEMINI,
    COPILOT,
    PROJECT_FILE,
    CHOSEN,
];

/// Session files read, and bytes of each first line, to find a Claude Code project's folder.
const SESSION_FILES_READ: usize = 20;
const SESSION_LINE_BYTES: u64 = 256 * 1024;

pub(crate) fn source_rank(source: &str) -> usize {
    SOURCE_ORDER
        .iter()
        .position(|name| *name == source)
        .unwrap_or(SOURCE_ORDER.len())
}

/// The entries of `base/dir` with one of `extensions` (any case), as paths
/// relative to `base`, sorted by name. Subfolders are not read.
fn files_in(base: &Path, dir: &str, extensions: &[&str]) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(base.join(dir)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .filter(|name| {
            Path::new(name)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extensions
                        .iter()
                        .any(|wanted| extension.eq_ignore_ascii_case(wanted))
                })
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| format!("{dir}/{name}"))
        .collect()
}

/// Cursor rules, Gemini and Copilot instructions at the root of a project.
pub(crate) fn project_app_files(root: &Path, name: &str) -> Vec<AgentInstructionFile> {
    let entry = |relative: &str, source: &str| file_entry(root, relative, Some(root), name, source);
    let mut files: Vec<AgentInstructionFile> = files_in(root, ".cursor/rules", &["md", "mdc"])
        .iter()
        .filter_map(|relative| entry(relative, CURSOR))
        .collect();
    files.extend(entry(".cursorrules", CURSOR));
    files.extend(entry("GEMINI.md", GEMINI));
    files.extend(entry(".github/copilot-instructions.md", COPILOT));
    files
}

/// The agents' own files in the home folder: Claude Code (with its project
/// memories), Codex, Cursor and Gemini.
pub(crate) fn home_app_files(home: &Path) -> Vec<AgentInstructionFile> {
    let entry =
        |relative: &str, source: &str| file_entry(home, relative, None, HOME_PROJECT_NAME, source);
    let mut files: Vec<AgentInstructionFile> = entry(".claude/CLAUDE.md", CLAUDE_CODE)
        .into_iter()
        .collect();
    files.extend(claude_project_memories(home));
    files.extend(entry(".codex/AGENTS.md", CODEX));
    files.extend(
        files_in(home, ".codex/instructions", &["md"])
            .iter()
            .filter_map(|relative| entry(relative, CODEX)),
    );
    files.extend(
        files_in(home, ".cursor/rules", &["md", "mdc"])
            .iter()
            .filter_map(|relative| entry(relative, CURSOR)),
    );
    files.extend(entry(".gemini/GEMINI.md", GEMINI));
    files
}

/// Every `~/.claude/projects/<slug>/memory/*.md` but the `MEMORY.md` index,
/// in the project the slug stands for.
fn claude_project_memories(home: &Path) -> Vec<AgentInstructionFile> {
    let Ok(entries) = std::fs::read_dir(home.join(".claude/projects")) else {
        return Vec::new();
    };
    let mut folders: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    folders.sort();
    let mut files = Vec::new();
    for folder in folders {
        let memories: Vec<String> = files_in(&folder, "memory", &["md"])
            .into_iter()
            .filter(|relative| relative != "memory/MEMORY.md")
            .collect();
        if memories.is_empty() {
            continue;
        }
        let slug = folder
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let project = session_cwd(&folder).unwrap_or_else(|| slug_path(slug));
        let (root, name) = if project == home {
            (None, HOME_PROJECT_NAME.to_string())
        } else {
            (Some(project.as_path()), project_name(&project))
        };
        files.extend(
            memories
                .iter()
                .filter_map(|relative| file_entry(&folder, relative, root, &name, CLAUDE_CODE)),
        );
    }
    files
}

/// The project folder of a Claude Code project: the `cwd` of the first line
/// of one of its session files.
fn session_cwd(folder: &Path) -> Option<PathBuf> {
    let mut sessions: Vec<PathBuf> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect();
    sessions.sort();
    sessions.iter().take(SESSION_FILES_READ).find_map(|path| {
        let file = std::fs::File::open(path).ok()?;
        let mut line = String::new();
        BufReader::new(file.take(SESSION_LINE_BYTES))
            .read_line(&mut line)
            .ok()?;
        let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        let cwd = PathBuf::from(value.get("cwd")?.as_str()?.trim());
        cwd.is_absolute().then_some(cwd)
    })
}

/// A slug turned back into a path: each `-` becomes `/`. Lossy for names
/// with dashes, so the session file comes first.
fn slug_path(slug: &str) -> PathBuf {
    PathBuf::from(slug.replace('-', "/"))
}

#[cfg(test)]
mod tests {
    use super::super::memory_import::discover_agent_files;
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn memory_import_finds_each_agents_files_grouped_by_app() {
        let base = std::env::temp_dir().join(format!("kordi-memory-apps-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        let project = base.join("work").join("launch-site");
        let claude = home.join(".claude/projects");
        write(&home.join(".claude/CLAUDE.md"), "Answer briefly.");
        let with_session = claude.join("-work-launch-site");
        write(
            &with_session.join("a.jsonl"),
            &format!("{{\"cwd\":\"{}\"}}\n{{}}\n", project.display()),
        );
        write(
            &with_session.join("memory/feedback_tests.md"),
            "---\ntype: feedback\n---\nRun tests.",
        );
        write(&with_session.join("memory/MEMORY.md"), "- index");
        write(&with_session.join("memory/notes/deep.md"), "Not read.");
        write(
            &claude.join("-srv-old-site/memory/user_role.md"),
            "Designer.",
        );
        write(&claude.join("-srv-empty/a.jsonl"), "{}");
        write(&home.join(".codex/AGENTS.md"), "Write in British English.");
        write(
            &home.join(".codex/instructions/kordi.md"),
            "Use the worktree.",
        );
        write(&home.join(".codex/instructions/notes.txt"), "Not markdown.");
        write(&home.join(".cursor/rules/style.mdc"), "Short names.");
        write(&home.join(".gemini/GEMINI.md"), "Be terse.");
        write(&home.join(".gemini/empty/GEMINI.md"), "");
        write(&project.join(".cursor/rules/react.md"), "Hooks first.");
        write(&project.join(".cursorrules"), "Tabs.");
        write(&project.join("GEMINI.md"), "Gemini rules.");
        write(
            &project.join(".github/copilot-instructions.md"),
            "Copilot rules.",
        );
        write(&project.join("AGENTS.md"), "Use pnpm.");

        let files = discover_agent_files(std::slice::from_ref(&project), Some(&home));
        let rows: Vec<(&str, &str, &str)> = files
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
            rows,
            vec![
                ("Claude Code", "Home", ".claude/CLAUDE.md"),
                ("Claude Code", "site", "memory/user_role.md"),
                ("Claude Code", "launch-site", "memory/feedback_tests.md"),
                ("Codex", "Home", ".codex/AGENTS.md"),
                ("Codex", "Home", ".codex/instructions/kordi.md"),
                ("Cursor", "launch-site", ".cursor/rules/react.md"),
                ("Cursor", "launch-site", ".cursorrules"),
                ("Cursor", "Home", ".cursor/rules/style.mdc"),
                ("Gemini", "launch-site", "GEMINI.md"),
                ("Gemini", "Home", ".gemini/GEMINI.md"),
                ("Copilot", "launch-site", ".github/copilot-instructions.md"),
                ("Project file", "launch-site", "AGENTS.md"),
            ]
        );
        assert_eq!(
            files[2].root.as_deref(),
            Some(project.display().to_string().as_str())
        );
        assert_eq!(
            files[1].root.as_deref(),
            Some("/srv/old/site"),
            "the slug is the fallback"
        );
        assert_eq!(files[0].root, None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
