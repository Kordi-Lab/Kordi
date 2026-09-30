use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
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

pub type SandboxBackendHandle = Arc<dyn SandboxBackend>;

#[async_trait]
pub trait SandboxBackend: Send + Sync {
    fn root_for_tests(&self) -> Option<&Path> {
        None
    }

    fn resolve_path(&self, relative_path: &str) -> Result<PathBuf, SandboxClientError>;

    async fn read_text(&self, relative_path: &str) -> Result<String, SandboxClientError>;

    async fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, SandboxClientError>;

    async fn read_bytes_bounded(
        &self,
        relative_path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, SandboxClientError>;

    async fn write_text(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<(), SandboxClientError>;

    async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError>;

    async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError>;
}

/// Development-only backend that runs commands on the runner host as the
/// runner's own user. It withholds the runner's environment from commands, but
/// it is not an isolation boundary; `runtime::sandbox_backend_mode` refuses it
/// unless the development opt-in is set.
#[derive(Debug, Clone)]
pub struct LocalSandboxBackend {
    root: PathBuf,
}

const LOCAL_DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
const LOCAL_DEFAULT_LANG: &str = "C.UTF-8";

/// The complete environment of a local sandbox command. The runner's own
/// variables, including its service credentials, are never inherited; only a
/// search path and locale pass through, and home and temporary directories
/// point inside the sandbox.
fn local_command_env(root: &Path) -> Vec<(&'static str, OsString)> {
    let inherited = |name: &str, fallback: &str| {
        std::env::var_os(name)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OsString::from(fallback))
    };
    vec![
        ("PATH", inherited("PATH", LOCAL_DEFAULT_PATH)),
        ("HOME", root.as_os_str().to_os_string()),
        ("LANG", inherited("LANG", LOCAL_DEFAULT_LANG)),
        ("TMPDIR", root.join(".tmp").into_os_string()),
    ]
}

impl LocalSandboxBackend {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve_path(&self, relative_path: &str) -> Result<PathBuf, SandboxClientError> {
        <Self as SandboxBackend>::resolve_path(self, relative_path)
    }

    pub async fn read_text(&self, relative_path: &str) -> Result<String, SandboxClientError> {
        <Self as SandboxBackend>::read_text(self, relative_path).await
    }

    pub async fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, SandboxClientError> {
        <Self as SandboxBackend>::read_bytes(self, relative_path).await
    }

    pub async fn write_text(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<(), SandboxClientError> {
        <Self as SandboxBackend>::write_text(self, relative_path, content).await
    }

    pub async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError> {
        <Self as SandboxBackend>::list(self, relative_path).await
    }

    pub async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError> {
        <Self as SandboxBackend>::run_bash(self, command).await
    }
}

#[async_trait]
impl SandboxBackend for LocalSandboxBackend {
    fn root_for_tests(&self) -> Option<&Path> {
        Some(&self.root)
    }

    fn resolve_path(&self, relative_path: &str) -> Result<PathBuf, SandboxClientError> {
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

    async fn read_text(&self, relative_path: &str) -> Result<String, SandboxClientError> {
        let path = self.resolve_path(relative_path)?;
        Ok(tokio::fs::read_to_string(path).await?)
    }

    async fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, SandboxClientError> {
        let path = self.resolve_path(relative_path)?;
        Ok(tokio::fs::read(path).await?)
    }

    async fn read_bytes_bounded(
        &self,
        relative_path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, SandboxClientError> {
        use tokio::io::AsyncReadExt;
        let path = tokio::fs::canonicalize(self.resolve_path(relative_path)?).await?;
        let root = tokio::fs::canonicalize(&self.root).await?;
        if !path.starts_with(root) {
            return Err(SandboxClientError::BlockedPath(
                RunnerToolBlockReason::PathEscapesSandbox,
            ));
        }
        if !tokio::fs::metadata(&path).await?.is_file() {
            return Err(SandboxClientError::Process(
                "Image input must be a regular file.".into(),
            ));
        }
        let file = tokio::fs::File::open(path).await?;
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > max_bytes {
            return Err(SandboxClientError::Process(
                "Image exceeds the read limit; resize it and retry.".into(),
            ));
        }
        Ok(bytes)
    }

    async fn write_text(
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

    async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError> {
        let path = self.resolve_path(relative_path)?;
        let mut entries = tokio::fs::read_dir(path).await?;
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            names.push(entry.file_name().to_string_lossy().to_string());
        }
        names.sort();
        Ok(names)
    }

    async fn run_bash(&self, command: &str) -> Result<BashOutput, SandboxClientError> {
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
        let env = local_command_env(&self.root);
        if let Some((_, tmp)) = env.iter().find(|(name, _)| *name == "TMPDIR") {
            tokio::fs::create_dir_all(tmp).await?;
        }
        let output = Command::new("/bin/sh")
            .kill_on_drop(true)
            .arg("-c")
            .arg(command)
            .current_dir(&self.root)
            .env_clear()
            .envs(env)
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
    async fn local_backend_read_bytes_matches_written_content() {
        let root = std::env::temp_dir().join(format!(
            "kordi-sandbox-bytes-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let backend = LocalSandboxBackend::new(root.clone());
        backend.write_text("artifact.txt", "hello").await.unwrap();

        let bytes = backend.read_bytes("artifact.txt").await.unwrap();

        assert_eq!(bytes, b"hello");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn local_commands_do_not_see_the_runner_environment() {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let secret_name = format!("KORDI_TEST_RUNNER_SECRET_{suffix}");
        let secret_value = format!("runner-secret-{suffix}");
        std::env::set_var(&secret_name, &secret_value);
        let root = std::env::temp_dir().join(format!("kordi-sandbox-env-{suffix}"));
        let backend = LocalSandboxBackend::new(root.clone());

        let output = backend.run_bash("env").await.unwrap();

        assert_eq!(output.exit_code, 0, "{}", output.stderr);
        assert!(!output.stdout.contains(&secret_value));
        assert!(!output.stdout.contains(&secret_name));
        let names: Vec<&str> = output
            .stdout
            .lines()
            .filter_map(|line| line.split_once('=').map(|(name, _)| name))
            .collect();
        for name in &names {
            assert!(
                matches!(
                    *name,
                    "PATH" | "HOME" | "LANG" | "TMPDIR" | "PWD" | "OLDPWD" | "SHLVL" | "_"
                ),
                "unexpected variable {name} in sandbox environment"
            );
        }
        let home = format!("HOME={}", root.display());
        let tmpdir = format!("TMPDIR={}", root.join(".tmp").display());
        assert!(output.stdout.lines().any(|line| line == home));
        assert!(output.stdout.lines().any(|line| line == tmpdir));
        assert!(root.join(".tmp").is_dir());

        std::env::remove_var(&secret_name);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn local_commands_still_find_standard_tools() {
        let root = std::env::temp_dir().join(format!(
            "kordi-sandbox-path-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let backend = LocalSandboxBackend::new(root.clone());

        let output = backend
            .run_bash("printf hello > note.txt && cat note.txt")
            .await
            .unwrap();

        assert_eq!(output.exit_code, 0, "{}", output.stderr);
        assert_eq!(output.stdout, "hello");
        let _ = std::fs::remove_dir_all(root);
    }

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
