use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::tool_policy::{is_owner_local_path, RunnerToolBlockReason};

#[derive(Debug, thiserror::Error)]
pub enum SandboxClientError {
    #[error("sandbox path blocked: {0:?}")]
    BlockedPath(RunnerToolBlockReason),
    #[error("sandbox io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("sandbox process failed: {0}")]
    Process(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone)]
pub struct LocalSandboxBackend {
    root: PathBuf,
}

impl LocalSandboxBackend {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve_path(&self, relative_path: &str) -> Result<PathBuf, SandboxClientError> {
        let trimmed = relative_path.trim();
        if is_owner_local_path(trimmed) {
            return Err(SandboxClientError::BlockedPath(
                RunnerToolBlockReason::OwnerLocalResource,
            ));
        }
        let relative = Path::new(trimmed);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(SandboxClientError::BlockedPath(
                RunnerToolBlockReason::PathEscapesSandbox,
            ));
        }
        Ok(self.root.join(relative))
    }

    pub async fn read_text(&self, relative_path: &str) -> Result<String, SandboxClientError> {
        let path = self.resolve_path(relative_path)?;
        Ok(tokio::fs::read_to_string(path).await?)
    }

    pub async fn write_text(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<(), SandboxClientError> {
        let path = self.resolve_path(relative_path)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, content).await?;
        Ok(())
    }

    pub async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError> {
        let path = self.resolve_path(relative_path)?;
        let mut entries = tokio::fs::read_dir(path).await?;
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            names.push(entry.file_name().to_string_lossy().to_string());
        }
        names.sort();
        Ok(names)
    }

    pub async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError> {
        if command.contains("/Users/") || command.contains("/home/") {
            return Err(SandboxClientError::BlockedPath(
                RunnerToolBlockReason::OwnerLocalResource,
            ));
        }
        if command.contains("../")
            || command.starts_with('/')
            || command.contains(" /")
            || command.contains("=/")
            || command.contains(" >/")
            || command.contains("> /")
        {
            return Err(SandboxClientError::BlockedPath(
                RunnerToolBlockReason::PathEscapesSandbox,
            ));
        }
        tokio::fs::create_dir_all(&self.root).await?;
        let output = Command::new("/bin/sh")
            .arg("-c")
            .arg(command)
            .current_dir(&self.root)
            .output()
            .await?;
        Ok(BashOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[tokio::test]
    async fn resolve_path_blocks_escape_attempts() {
        let root = std::env::temp_dir().join(format!(
            "kordi-sandbox-client-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        let backend = LocalSandboxBackend::new(root.clone());

        assert!(backend
            .resolve_path("safe/file.txt")
            .unwrap()
            .starts_with(&root));
        assert!(backend.resolve_path("../outside.txt").is_err());
        assert!(backend.resolve_path("/tmp/outside.txt").is_err());

        let _ = fs::remove_dir_all(root);
    }
}
