//! Optional shared-workspace sync for Bridges projects.
//!
//! Bridges core messaging and coordination do not depend on git.
//! When operators explicitly run `bridges sync`, this module snapshots
//! and merges managed files under `.shared/` using a local git repo.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

/// Shared directory template files.
const SHARED_TEMPLATES: &[(&str, &str)] = &[
    ("PROJECT.md", "# Project\n\n_Describe the project goals, architecture, and key decisions here._\n"),
    ("MEMBERS.md", "# Project Members\n\n| Name | Role | Joined |\n|------|------|--------|\n"),
    ("PROGRESS.md", "# Progress\n\n_Optional shared status updates for project members._\n"),
    ("TODOS.md", "# TODOs\n\n_Add tasks with `- [ ]` checkboxes._\n"),
    ("DEBATES.md", "# Debates\n\n_Active discussions._\n"),
    ("DECISIONS.md", "# Decisions\n\n_Resolved debates and decisions._\n"),
    ("CHANGELOG.md", "# Changelog\n\n_Project-level changes and decisions. Do not store chat transcripts here._\n"),
];

/// Initialize the .shared/ directory with templates.
pub fn init_shared(project_dir: &Path) {
    let shared = project_dir.join(".shared");
    fs::create_dir_all(shared.join("artifacts")).ok();

    for (name, content) in SHARED_TEMPLATES {
        let path = shared.join(name);
        if !path.exists() {
            fs::write(&path, content).ok();
        }
    }
}

/// Initialize a local repo for optional shared-workspace sync.
fn git_init(project_dir: &Path) -> Result<(), String> {
    // Ensure directory exists (critical — git -C fails on missing dirs)
    fs::create_dir_all(project_dir)
        .map_err(|e| format!("create dir {}: {}", project_dir.display(), e))?;
    run_git(project_dir, &["init", "-b", "main"])?;
    ensure_gitignore(project_dir);
    Ok(())
}

/// Stage and commit managed shared-workspace files.
pub fn git_commit(project_dir: &Path, message: &str) -> Result<bool, String> {
    ensure_gitignore(project_dir);
    run_git(project_dir, &["add", ".shared/", ".gitignore"])?;

    // Check if there's anything to commit
    let status = run_git(project_dir, &["status", "--porcelain", ".shared/"])?;
    if status.trim().is_empty() {
        return Ok(false); // nothing to commit
    }

    run_git(project_dir, &["commit", "-m", message])?;
    Ok(true)
}

fn ensure_gitignore(project_dir: &Path) {
    let gitignore = project_dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, ".bridges/\n*.theirs\n").ok();
    }
}

fn ensure_sync_repo(project_dir: &Path, node_id: &str) -> Result<(), String> {
    if !project_dir.join(".git").exists() {
        git_init(project_dir)?;
    }

    let has_name = run_git(project_dir, &["config", "--local", "--get", "user.name"]).is_ok();
    if !has_name {
        run_git(project_dir, &["config", "user.name", node_id])?;
    }

    let has_email = run_git(project_dir, &["config", "--local", "--get", "user.email"]).is_ok();
    if !has_email {
        let email = format!("{}@bridges.local", node_id);
        run_git(project_dir, &["config", "user.email", &email])?;
    }

    Ok(())
}

/// Push managed shared-workspace changes to the configured remote.
pub fn git_push(project_dir: &Path, branch: &str) -> Result<(), String> {
    run_git_remote(project_dir, &["push", "origin", branch])?;
    Ok(())
}

/// Pull managed shared-workspace changes from the configured remote and merge.
pub fn git_pull(
    project_dir: &Path,
    node_id: &str,
    approve_unmanaged: bool,
) -> Result<PullResult, String> {
    let mut warnings = Vec::new();

    // Fetch
    if let Err(e) = run_git_remote(project_dir, &["fetch", "origin"]) {
        warnings.push(format!("fetch skipped: {}", e));
        return Ok(PullResult {
            pulled: 0,
            conflicts: vec![],
            warnings,
        });
    }

    // Set tracking branch if not set
    if let Err(e) = run_git(
        project_dir,
        &["branch", "--set-upstream-to=origin/main", "main"],
    ) {
        warnings.push(format!("tracking branch not set: {}", e));
    }

    // Check if we have any local commits
    let has_local_commits = run_git(project_dir, &["rev-parse", "HEAD"]).is_ok();
    let dirty_unmanaged = dirty_unmanaged_paths(project_dir)?;

    if !has_local_commits {
        // No local commits — only allow syncing managed files into a clean worktree.
        let remote_paths = list_remote_paths(project_dir, "origin/main").unwrap_or_default();
        let unmanaged_remote: Vec<String> = remote_paths
            .iter()
            .filter(|path| !is_managed_sync_path(path))
            .cloned()
            .collect();
        if !dirty_unmanaged.is_empty() || !unmanaged_remote.is_empty() {
            if !approve_unmanaged {
                let approval = save_sync_approval(
                    project_dir,
                    node_id,
                    dirty_unmanaged.clone(),
                    unmanaged_remote.clone(),
                )?;
                warnings.push(format!(
                    "approval required before syncing unmanaged paths; inspect {} then rerun with `bridges sync --project <id> --approve-unmanaged`",
                    approval
                ));
                return Ok(PullResult {
                    pulled: 0,
                    conflicts: vec![],
                    warnings,
                });
            }
            warnings.push(
                "approved unmanaged sync: local worktree will be preserved before applying remote changes"
                    .to_string(),
            );
        }
        if !unmanaged_remote.is_empty() {
            warnings.push(format!(
                "remote contains unmanaged paths; applying approved sync for {}",
                unmanaged_remote.join(", ")
            ));
        }

        if let Err(e) = run_git(
            project_dir,
            &["checkout", "origin/main", "--", ".shared", ".gitignore"],
        ) {
            warnings.push(format!("initial sync skipped: {}", e));
            return Ok(PullResult {
                pulled: 0,
                conflicts: vec![],
                warnings,
            });
        }
        let count = remote_paths.len();
        return Ok(PullResult {
            pulled: count,
            conflicts: vec![],
            warnings,
        });
    }

    // Check if there are remote changes
    let local = run_git(project_dir, &["rev-parse", "HEAD"]).unwrap_or_default();
    let remote = run_git(project_dir, &["rev-parse", "origin/main"]).unwrap_or_default();

    if local.trim() == remote.trim() {
        clear_sync_approval(project_dir);
        return Ok(PullResult {
            pulled: 0,
            conflicts: vec![],
            warnings,
        });
    }

    let remote_changed =
        run_git(project_dir, &["diff", "--name-only", "HEAD..origin/main"]).unwrap_or_default();
    let unmanaged_remote: Vec<String> = remote_changed
        .lines()
        .filter(|l| !l.is_empty() && !is_managed_sync_path(l))
        .map(|l| l.to_string())
        .collect();
    if !dirty_unmanaged.is_empty() || !unmanaged_remote.is_empty() {
        if !approve_unmanaged {
            let approval = save_sync_approval(
                project_dir,
                node_id,
                dirty_unmanaged.clone(),
                unmanaged_remote.clone(),
            )?;
            warnings.push(format!(
                "approval required before merging unmanaged paths; inspect {} then rerun with `bridges sync --project <id> --approve-unmanaged`",
                approval
            ));
            return Ok(PullResult {
                pulled: 0,
                conflicts: vec![],
                warnings,
            });
        }
        if !unmanaged_remote.is_empty() {
            warnings.push(format!(
                "approved unmanaged merge for {}",
                unmanaged_remote.join(", ")
            ));
        }
    }

    let stash_label = format!("bridges-preserve-{}", chrono::Utc::now().timestamp());
    let stashed = if !dirty_unmanaged.is_empty() {
        warnings.push(format!(
            "preserving local unmanaged worktree before merge for {}",
            dirty_unmanaged.join(", ")
        ));
        stash_local_worktree(project_dir, &stash_label)?
    } else {
        false
    };

    // Try merge
    let merge_result = Command::new("git")
        .args([
            "-C",
            &project_dir.to_string_lossy(),
            "merge",
            "origin/main",
            "--no-edit",
            "--allow-unrelated-histories",
        ])
        .output()
        .map_err(|e| format!("git merge: {}", e))?;

    if merge_result.status.success() {
        // Count actually merged files from the merge commit
        let diff_output =
            run_git(project_dir, &["diff", "--name-only", "HEAD~1..HEAD"]).unwrap_or_default();
        let pulled = diff_output.lines().filter(|l| !l.is_empty()).count();
        if stashed {
            match pop_stash(project_dir) {
                Ok(()) => {
                    warnings.push("restored preserved local worktree after merge".to_string())
                }
                Err(e) => warnings.push(format!(
                    "local worktree preserved in git stash `{}`; restore manually ({})",
                    stash_label, e
                )),
            }
        }
        clear_sync_approval(project_dir);
        return Ok(PullResult {
            pulled,
            conflicts: vec![],
            warnings,
        });
    }

    // Merge failed — check for conflicts
    let conflict_output =
        run_git(project_dir, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
    let conflicts: Vec<String> = conflict_output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    // Count files that were successfully merged (even if some conflicted)
    let diff_output =
        run_git(project_dir, &["diff", "--name-only", "HEAD..origin/main"]).unwrap_or_default();
    let pulled = diff_output.lines().filter(|l| !l.is_empty()).count();

    if conflicts.is_empty() {
        warnings.push("merge failed without explicit conflict markers".to_string());
    }
    if stashed {
        warnings.push(format!(
            "local worktree preserved in git stash `{}`; resolve conflicts before restoring it",
            stash_label
        ));
    }

    Ok(PullResult {
        pulled,
        conflicts,
        warnings,
    })
}

/// Get the current branch name.
pub fn git_current_branch(project_dir: &Path) -> String {
    run_git(project_dir, &["branch", "--show-current"])
        .unwrap_or_else(|_| "main".to_string())
        .trim()
        .to_string()
}

/// Result of a pull operation.
pub struct PullResult {
    pub pulled: usize,
    pub conflicts: Vec<String>,
    pub warnings: Vec<String>,
}

/// Result of a full sync.
pub struct SyncResult {
    pub pushed: bool,
    pub pulled: usize,
    pub conflicts: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SyncApprovalProposal {
    id: String,
    created_at: String,
    local_node_id: String,
    local_head: Option<String>,
    remote_head: Option<String>,
    local_unmanaged_paths: Vec<String>,
    remote_unmanaged_paths: Vec<String>,
}

/// Full optional shared-workspace sync: commit local managed files, push, pull, merge.
pub fn sync_project(
    project_dir: &Path,
    node_id: &str,
    approve_unmanaged: bool,
) -> Result<SyncResult, String> {
    init_shared(project_dir);
    ensure_sync_repo(project_dir, node_id)?;
    let mut warnings = Vec::new();

    // 1. Commit local changes
    let msg = format!("sync by {}", node_id);
    let pushed = match git_commit(project_dir, &msg) {
        Ok(pushed) => pushed,
        Err(e) => {
            warnings.push(format!("local commit skipped: {}", e));
            false
        }
    };

    // 2. Push to the configured git remote
    if pushed {
        let branch = git_current_branch(project_dir);
        if let Err(e) = git_push(project_dir, &branch) {
            eprintln!("Push failed ({}), trying pull first", e);
        }
    }

    // 3. Pull from the configured git remote + merge
    let pull_result = git_pull(project_dir, node_id, approve_unmanaged)?;
    warnings.extend(pull_result.warnings.clone());

    // 4. If we pushed but pull brought new changes, push again
    if pushed && pull_result.pulled > 0 && pull_result.conflicts.is_empty() {
        let branch = git_current_branch(project_dir);
        if let Err(e) = git_push(project_dir, &branch) {
            warnings.push(format!("final push skipped: {}", e));
        }
    }

    Ok(SyncResult {
        pushed,
        pulled: pull_result.pulled,
        conflicts: pull_result.conflicts,
        warnings,
    })
}

fn approval_path(project_dir: &Path) -> std::path::PathBuf {
    project_dir.join(".bridges").join("sync-approval.json")
}

fn save_sync_approval(
    project_dir: &Path,
    node_id: &str,
    local_unmanaged_paths: Vec<String>,
    remote_unmanaged_paths: Vec<String>,
) -> Result<String, String> {
    let path = approval_path(project_dir);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create approval dir {}: {}", parent.display(), e))?;
    }
    let proposal = SyncApprovalProposal {
        id: format!("syncappr_{}", uuid::Uuid::new_v4()),
        created_at: chrono::Utc::now().to_rfc3339(),
        local_node_id: node_id.to_string(),
        local_head: run_git(project_dir, &["rev-parse", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string()),
        remote_head: run_git(project_dir, &["rev-parse", "origin/main"])
            .ok()
            .map(|s| s.trim().to_string()),
        local_unmanaged_paths,
        remote_unmanaged_paths,
    };
    let data = serde_json::to_string_pretty(&proposal)
        .map_err(|e| format!("serialize sync approval proposal: {}", e))?;
    fs::write(&path, data)
        .map_err(|e| format!("write sync approval proposal {}: {}", path.display(), e))?;
    Ok(path.to_string_lossy().to_string())
}

fn clear_sync_approval(project_dir: &Path) {
    fs::remove_file(approval_path(project_dir)).ok();
}

#[cfg(test)]
fn project_dir_has_user_content(project_dir: &Path) -> Result<bool, String> {
    if !project_dir.exists() {
        return Ok(false);
    }
    let entries = fs::read_dir(project_dir)
        .map_err(|e| format!("read project dir {}: {}", project_dir.display(), e))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name != ".bridges" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_managed_sync_path(path: &str) -> bool {
    path == ".gitignore" || path.starts_with(".shared/")
}

fn dirty_unmanaged_paths(project_dir: &Path) -> Result<Vec<String>, String> {
    let status = run_git(
        project_dir,
        &["status", "--porcelain", "--untracked-files=all"],
    )?;
    Ok(status
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let path = line[3..].trim();
            if path.is_empty() || is_managed_sync_path(path) {
                return None;
            }
            Some(path.to_string())
        })
        .collect())
}

fn list_remote_paths(project_dir: &Path, treeish: &str) -> Result<Vec<String>, String> {
    let output = run_git(project_dir, &["ls-tree", "-r", "--name-only", treeish])?;
    Ok(output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect())
}

fn stash_local_worktree(project_dir: &Path, label: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .args([
            "-C",
            &project_dir.to_string_lossy(),
            "stash",
            "push",
            "--include-untracked",
            "-m",
            label,
        ])
        .output()
        .map_err(|e| format!("git stash push: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git stash push failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(!stdout.contains("No local changes to save"))
}

fn pop_stash(project_dir: &Path) -> Result<(), String> {
    run_git(project_dir, &["stash", "pop"])?;
    Ok(())
}

/// Update MEMBERS.md.
pub fn update_members(project_dir: &Path, members: &[(String, String, String)]) {
    let path = project_dir.join(".shared").join("MEMBERS.md");
    let mut content =
        String::from("# Project Members\n\n| Name | Role | Joined |\n|------|------|--------|\n");
    for (name, role, joined) in members {
        content.push_str(&format!("| {} | {} | {} |\n", name, role, joined));
    }
    fs::write(&path, content).ok();
}

/// Run a git command and return stdout.
fn run_git_command(
    project_dir: Option<&Path>,
    args: &[&str],
    auth_header: Option<&str>,
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    if let Some(project_dir) = project_dir {
        cmd.args(["-C", &project_dir.to_string_lossy()]);
    }
    if let Some(header) = auth_header {
        cmd.args(["-c", &format!("http.extraHeader={}", header)]);
    }
    cmd.args(args)
        .output()
        .map_err(|e| format!("git {}: {}", args.first().unwrap_or(&""), e))
}

fn run_git(project_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git_command(Some(project_dir), args, None)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_remote(project_dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git_command(Some(project_dir), args, None)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_shared_creates_templates() {
        let dir = std::env::temp_dir().join("bridges_test_init_shared");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        init_shared(&dir);

        assert!(dir.join(".shared/PROJECT.md").exists());
        assert!(dir.join(".shared/TODOS.md").exists());
        assert!(dir.join(".shared/MEMBERS.md").exists());
        assert!(dir.join(".shared/artifacts").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_sync_repo_initializes_git_on_demand() {
        let dir = std::env::temp_dir().join(format!(
            "bridges_test_ensure_sync_repo_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        ensure_sync_repo(&dir, "kd_test").unwrap();

        assert!(dir.join(".git").exists());
        let name = run_git(&dir, &["config", "--local", "--get", "user.name"]).unwrap();
        let email = run_git(&dir, &["config", "--local", "--get", "user.email"]).unwrap();
        assert_eq!(name.trim(), "kd_test");
        assert_eq!(email.trim(), "kd_test@bridges.local");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn managed_sync_paths_are_whitelisted() {
        assert!(is_managed_sync_path(".shared/PROJECT.md"));
        assert!(is_managed_sync_path(".shared/artifacts/file.txt"));
        assert!(is_managed_sync_path(".gitignore"));
        assert!(!is_managed_sync_path("README.md"));
        assert!(!is_managed_sync_path(".bridges/project.json"));
    }

    #[test]
    fn detects_user_content_in_project_dir() {
        let dir = std::env::temp_dir().join(format!(
            "bridges_test_user_content_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".bridges")).unwrap();
        assert!(!project_dir_has_user_content(&dir).unwrap());

        fs::write(dir.join("README.md"), "local work").unwrap();
        assert!(project_dir_has_user_content(&dir).unwrap());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_sync_approval_proposal() {
        let dir = std::env::temp_dir().join(format!(
            "bridges_test_sync_approval_{}",
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".bridges")).unwrap();

        let path = save_sync_approval(
            &dir,
            "kd_test",
            vec!["README.md".to_string()],
            vec!["src/app.rs".to_string()],
        )
        .unwrap();
        let data = fs::read_to_string(path).unwrap();
        let proposal: SyncApprovalProposal = serde_json::from_str(&data).unwrap();
        assert_eq!(proposal.local_node_id, "kd_test");
        assert_eq!(proposal.local_unmanaged_paths, vec!["README.md"]);
        assert_eq!(proposal.remote_unmanaged_paths, vec!["src/app.rs"]);

        let _ = fs::remove_dir_all(&dir);
    }
}
