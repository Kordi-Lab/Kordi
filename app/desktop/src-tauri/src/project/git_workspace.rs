use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    path: String,
    branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspace {
    branch: Option<String>,
    branches: Vec<String>,
    worktrees: Vec<GitWorktree>,
    workspace_root: String,
    is_worktree: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWorkspaceSelection {
    worktree: Option<bool>,
    branch: Option<String>,
    workspace_root: Option<String>,
}

async fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "Git workspace operation timed out.".to_string())?
        .map_err(|_| "Git is unavailable. Install Git to use worktrees.".to_string())?;
    if !output.status.success() {
        // Git stderr can contain paths and repository URLs. Keep the UI error
        // bounded and actionable without forwarding arbitrary subprocess logs.
        return Err(
            "Unable to update Git workspace. Check the branch and local repository.".into(),
        );
    }
    Ok(output.stdout)
}

fn text(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "Git workspace contains unsupported text.".into())
}

fn parse_worktrees(raw: &str) -> Vec<GitWorktree> {
    let mut trees = Vec::<GitWorktree>::new();
    for field in raw.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            trees.push(GitWorktree {
                path: path.into(),
                branch: None,
            });
        } else if let Some(branch) = field.strip_prefix("branch refs/heads/") {
            if let Some(tree) = trees.last_mut() {
                tree.branch = Some(branch.into());
            }
        }
    }
    trees
}

async fn worktrees(root: &Path) -> Result<Vec<GitWorktree>, String> {
    Ok(parse_worktrees(&text(
        git(root, &["worktree", "list", "--porcelain", "-z"]).await?,
    )?))
}

async fn branches(root: &Path) -> Result<Vec<String>, String> {
    Ok(text(
        git(
            root,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        )
        .await?,
    )?
    .lines()
    .map(str::to_string)
    .collect())
}

#[tauri::command]
pub async fn desktop_project_git_workspace(
    project_root: String,
    workspace_root: Option<String>,
) -> Result<Option<GitWorkspace>, String> {
    let root = super::resolve_explicit_project_folder(&project_root, false, false)?;
    // An ordinary local folder is a valid project; Git controls are optional.
    if git(&root, &["rev-parse", "--show-toplevel"]).await.is_err() {
        return Ok(None);
    }
    let trees = worktrees(&root).await?;
    let workspace = workspace_root
        .as_deref()
        .map(|raw| super::resolve_explicit_project_folder(raw, false, false))
        .transpose()?
        .unwrap_or_else(|| root.clone());
    let tree = trees.iter().find(|tree| Path::new(&tree.path) == workspace);
    let branch = if let Some(tree) = tree {
        tree.branch.clone()
    } else {
        text(
            git(&workspace, &["symbolic-ref", "--short", "-q", "HEAD"])
                .await
                .unwrap_or_default(),
        )?
        .trim()
        .to_owned()
        .into()
    };
    Ok(Some(GitWorkspace {
        branch: branch.filter(|value| !value.is_empty()),
        branches: branches(&root).await?,
        worktrees: trees,
        workspace_root: workspace.display().to_string(),
        is_worktree: workspace != root,
    }))
}

pub async fn select_workspace(
    root: &Path,
    session_id: &str,
    selection: Option<ChatWorkspaceSelection>,
) -> Result<PathBuf, String> {
    let Some(selection) = selection else {
        return Ok(root.into());
    };
    if let Some(path) = selection.workspace_root {
        let requested = super::resolve_explicit_project_folder(&path, false, false)?;
        if requested == root {
            return Ok(requested);
        }
        if worktrees(root)
            .await?
            .iter()
            .any(|tree| Path::new(&tree.path) == requested)
        {
            return Ok(requested);
        }
        return Err("Select a worktree belonging to this project.".into());
    }
    if !selection.worktree.unwrap_or(false) {
        return Ok(root.into());
    }
    let repository_root = text(git(root, &["rev-parse", "--show-toplevel"]).await?)?;
    if Path::new(repository_root.trim()) != root {
        return Err("Select the Git repository root before creating a worktree.".into());
    }
    let branch = selection.branch.as_deref().unwrap_or("HEAD");
    if branch != "HEAD"
        && !branches(root)
            .await?
            .iter()
            .any(|candidate| candidate == branch)
    {
        return Err("The selected branch is unavailable. Refresh the workspace selector.".into());
    }
    let parent = kordi_core::local_paths::home_directory()
        .ok_or("Home folder is unavailable")?
        .join("KordiWorktrees");
    create_worktree(root, session_id, selection.branch.as_deref(), &parent).await
}

async fn create_worktree(
    root: &Path,
    session_id: &str,
    base_branch: Option<&str>,
    parent: &Path,
) -> Result<PathBuf, String> {
    let slug: String = session_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(48)
        .collect();
    if slug.is_empty() {
        return Err("A local chat session is required.".into());
    }
    std::fs::create_dir_all(parent)
        .map_err(|_| "Unable to create the worktree folder.".to_string())?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|_| "Unable to resolve the worktree folder.".to_string())?;
    let prefix = format!("chat-{slug}-");
    if base_branch.is_none() {
        if let Some(tree) = worktrees(root).await?.into_iter().find(|tree| {
            let path = Path::new(&tree.path);
            path.parent() == Some(parent.as_path())
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(&prefix))
        }) {
            return Ok(PathBuf::from(tree.path));
        }
    }
    let name = format!("{prefix}{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let workspace = parent.join(&name);
    let new_branch = format!("kordi/{name}");
    git(
        root,
        &[
            "worktree",
            "add",
            "-b",
            &new_branch,
            workspace.to_str().ok_or("Unsupported worktree folder")?,
            base_branch.unwrap_or("HEAD"),
        ],
    )
    .await?;
    Ok(workspace)
}

#[cfg(test)]
#[path = "git_workspace_tests.rs"]
mod tests;
