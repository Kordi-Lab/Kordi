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

mod local_fs;

/// Development-only backend that runs commands on the runner host. It is not
/// an isolation boundary; `runtime::sandbox_backend_mode` refuses it unless
/// the development opt-in is set.
///
/// Commands never inherit the runner's environment. When the runner runs as
/// root, as it does in the development container, commands also run as a
/// separate unprivileged user, so they cannot read the runner's environment
/// or memory through `/proc`, and the runner's own file operations in the
/// sandbox never follow links. When the runner is not root, commands run as
/// the runner's user and can read its environment that way.
#[derive(Debug, Clone)]
pub struct LocalSandboxBackend {
    root: PathBuf,
    identity: Option<SandboxIdentity>,
}

/// The user and group that local sandbox commands run as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandboxIdentity {
    pub uid: u32,
    pub gid: u32,
}

pub const LOCAL_SANDBOX_UID_ENV: &str = "KORDI_CLOUD_SANDBOX_LOCAL_UID";
pub const LOCAL_SANDBOX_GID_ENV: &str = "KORDI_CLOUD_SANDBOX_LOCAL_GID";

/// The `kordi-sandbox` user and group of the runner image.
pub const DEFAULT_LOCAL_SANDBOX_ID: u32 = 10001;

/// The identity for local sandbox commands. A runner that is not root cannot
/// switch users, so its commands keep its identity (`None`). A root runner
/// always switches, to the configured ids or the image's `kordi-sandbox`
/// user; an unparsable or root id is an error.
pub fn local_sandbox_identity(
    runner_is_root: bool,
    uid: Option<&str>,
    gid: Option<&str>,
) -> Result<Option<SandboxIdentity>, &'static str> {
    if !runner_is_root {
        return Ok(None);
    }
    let parse = |value: Option<&str>| match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(DEFAULT_LOCAL_SANDBOX_ID),
        Some(value) => value
            .parse::<u32>()
            .ok()
            .filter(|id| *id != 0)
            .ok_or("invalid_local_sandbox_identity"),
    };
    Ok(Some(SandboxIdentity {
        uid: parse(uid)?,
        gid: parse(gid)?,
    }))
}

pub fn runner_is_root() -> bool {
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

pub fn local_sandbox_identity_from_env() -> Result<Option<SandboxIdentity>, &'static str> {
    local_sandbox_identity(
        runner_is_root(),
        std::env::var(LOCAL_SANDBOX_UID_ENV).ok().as_deref(),
        std::env::var(LOCAL_SANDBOX_GID_ENV).ok().as_deref(),
    )
}

/// Keeps other sandboxes' names out of a local sandbox's view when commands
/// run as a separate user: the shared sandbox root can be traversed, but not
/// listed.
pub fn restrict_local_sandbox_root(local_root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(local_root)?;
    std::fs::set_permissions(local_root, std::fs::Permissions::from_mode(0o711))
}

fn blocked_or_io(error: std::io::Error) -> SandboxClientError {
    if error.raw_os_error() == Some(libc::ELOOP) {
        SandboxClientError::BlockedPath(RunnerToolBlockReason::PathEscapesSandbox)
    } else {
        SandboxClientError::Io(error)
    }
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
    /// A backend whose commands run as [`local_sandbox_identity_from_env`]
    /// says. A root runner with invalid identity settings still switches, to
    /// the default identity; the runner refuses such settings at startup.
    pub fn new(root: PathBuf) -> Self {
        let identity = local_sandbox_identity_from_env().unwrap_or(Some(SandboxIdentity {
            uid: DEFAULT_LOCAL_SANDBOX_ID,
            gid: DEFAULT_LOCAL_SANDBOX_ID,
        }));
        Self { root, identity }
    }

    pub fn identity(&self) -> Option<SandboxIdentity> {
        self.identity
    }

    /// Runs a file operation on the sandbox tree off the async runtime.
    async fn with_tree<T, F>(
        &self,
        relative_path: &str,
        operation: F,
    ) -> Result<T, SandboxClientError>
    where
        T: Send + 'static,
        F: FnOnce(&Path, &Path, Option<SandboxIdentity>) -> std::io::Result<T> + Send + 'static,
    {
        let relative = self
            .resolve_path(relative_path)?
            .strip_prefix(&self.root)
            .map(Path::to_path_buf)
            .map_err(|_| {
                SandboxClientError::BlockedPath(RunnerToolBlockReason::PathEscapesSandbox)
            })?;
        let root = self.root.clone();
        let identity = self.identity;
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&root)?;
            if let Some(identity) = identity {
                local_fs::adopt(&root, identity)?;
            }
            operation(&root, &relative, identity)
        })
        .await
        .map_err(|error| SandboxClientError::Process(error.to_string()))?
        .map_err(blocked_or_io)
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
        let bytes = self.read_bytes(relative_path).await?;
        String::from_utf8(bytes).map_err(|_| {
            SandboxClientError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "stream did not contain valid UTF-8",
            ))
        })
    }

    async fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, SandboxClientError> {
        self.with_tree(relative_path, |root, relative, _| {
            local_fs::read(root, relative, None)
        })
        .await
    }

    async fn read_bytes_bounded(
        &self,
        relative_path: &str,
        max_bytes: usize,
    ) -> Result<Vec<u8>, SandboxClientError> {
        let limit = max_bytes as u64 + 1;
        let bytes = self
            .with_tree(relative_path, move |root, relative, _| {
                local_fs::read(root, relative, Some(limit))
            })
            .await
            .map_err(|error| match error {
                SandboxClientError::Io(error)
                    if error.kind() == std::io::ErrorKind::InvalidInput =>
                {
                    SandboxClientError::Process("Image input must be a regular file.".into())
                }
                other => other,
            })?;
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
        let content = content.as_bytes().to_vec();
        self.with_tree(relative_path, move |root, relative, identity| {
            local_fs::write(root, relative, &content, identity)
        })
        .await
    }

    async fn list(&self, relative_path: &str) -> Result<Vec<String>, SandboxClientError> {
        self.with_tree(relative_path, |root, relative, _| {
            local_fs::list(root, relative)
        })
        .await
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
        // The sandbox and its temporary directory belong to the command's
        // user. A `.tmp` link planted by an earlier command is left alone.
        self.with_tree("", |root, _, identity| {
            if let Err(error) = local_fs::ensure_dir(root, Path::new(".tmp"), identity) {
                if error.raw_os_error() != Some(libc::ELOOP) {
                    return Err(error);
                }
            }
            Ok(())
        })
        .await?;
        let mut process = Command::new("/bin/sh");
        process
            .kill_on_drop(true)
            .arg("-c")
            .arg(command)
            .current_dir(&self.root)
            .env_clear()
            .envs(local_command_env(&self.root));
        if let Some(identity) = self.identity {
            // Supplementary groups are dropped along with the user.
            process.uid(identity.uid).gid(identity.gid);
        }
        let output = process.output().await?;
        Ok(BashOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

#[cfg(test)]
mod tests;
