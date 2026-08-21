use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use kordi_tools::task_operator::models::TaskOperatorBackgroundSession;
use tokio::{process::Command, sync::Mutex, task::JoinHandle};

use super::child_process_policy::{
    CHILD_AGENT_PROCESS_TIMEOUT, child_agent_tool_names, prompt_context,
};
use super::inspection::{BackgroundSessionInspection, truncate_summary};
use super::registry::TaskAgentStatus;

#[cfg_attr(feature = "cli", allow(dead_code))]
pub fn managed_child_tool_names(has_write_scope: bool) -> Vec<String> {
    child_agent_tool_names(has_write_scope)
        .split(',')
        .map(ToString::to_string)
        .collect()
}

#[cfg_attr(feature = "cli", allow(dead_code))]
pub fn managed_child_prompt_context(
    task_path: &str,
    task_name: &str,
    write_scope: &[String],
) -> String {
    prompt_context(task_path, task_name, write_scope)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub task_path: String,
    pub task_name: String,
    pub task_title: String,
    pub message: String,
    pub fork_turns: Option<String>,
    pub write_scope: Vec<String>,
    pub cwd: PathBuf,
    pub parent_message_id: Option<String>,
    pub attachment_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnedTask {
    pub(crate) task_path: String,
    pub(crate) status: TaskAgentStatus,
    pub(crate) summary: Option<String>,
    pub(crate) background_session: Option<TaskOperatorBackgroundSession>,
}

impl SpawnedTask {
    pub fn running(task_path: impl Into<String>) -> Self {
        Self {
            task_path: task_path.into(),
            status: TaskAgentStatus::Running,
            summary: None,
            background_session: None,
        }
    }

    #[cfg_attr(feature = "cli", allow(dead_code))]
    pub fn running_in_background_session(
        task_path: impl Into<String>,
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            task_path: task_path.into(),
            status: TaskAgentStatus::Running,
            summary: None,
            background_session: Some(TaskOperatorBackgroundSession {
                session_id: session_id.into(),
                turn_id: Some(turn_id.into()),
                title: title.into(),
                status: "running".to_string(),
            }),
        }
    }

    #[cfg_attr(feature = "cli", allow(dead_code))]
    pub fn background_session(&self) -> Option<&TaskOperatorBackgroundSession> {
        self.background_session.as_ref()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Completed { target: String, summary: String },
    Failed { target: String, summary: String },
    TimedOut,
}

#[async_trait]
pub trait ChildAgentRunner: Send + Sync {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask>;
    async fn send(&self, target: &str, message: String) -> Result<()>;
    async fn wait(&self, timeout_ms: u64) -> Result<WaitOutcome>;
    async fn close(&self, target: &str) -> Result<()>;
    async fn inspect(&self, _session_id: &str) -> Result<Option<BackgroundSessionInspection>> {
        Ok(None)
    }
}

#[derive(Clone, Default)]
pub(super) struct SubprocessChildAgentRunner {
    jobs: Arc<Mutex<BTreeMap<String, JoinHandle<Result<String>>>>>,
    messages: Arc<Mutex<BTreeMap<String, Vec<String>>>>,
}

impl SubprocessChildAgentRunner {
    pub(super) fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl ChildAgentRunner for SubprocessChildAgentRunner {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask> {
        let task_path = request.task_path.clone();
        let handle = tokio::spawn(async move { run_child_process(request).await });
        self.jobs.lock().await.insert(task_path.clone(), handle);
        Ok(SpawnedTask::running(task_path))
    }

    async fn send(&self, target: &str, message: String) -> Result<()> {
        self.messages
            .lock()
            .await
            .entry(target.to_string())
            .or_default()
            .push(message);
        Ok(())
    }

    async fn wait(&self, timeout_ms: u64) -> Result<WaitOutcome> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let finished = {
                let jobs = self.jobs.lock().await;
                jobs.iter()
                    .find_map(|(target, handle)| handle.is_finished().then(|| target.clone()))
            };
            if let Some(target) = finished {
                let handle = self
                    .jobs
                    .lock()
                    .await
                    .remove(&target)
                    .ok_or_else(|| anyhow!("finished task disappeared: {target}"))?;
                return match handle.await {
                    Ok(Ok(summary)) => Ok(WaitOutcome::Completed { target, summary }),
                    Ok(Err(error)) => Ok(WaitOutcome::Failed {
                        target,
                        summary: error.to_string(),
                    }),
                    Err(error) => Ok(WaitOutcome::Failed {
                        target,
                        summary: error.to_string(),
                    }),
                };
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(WaitOutcome::TimedOut);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn close(&self, target: &str) -> Result<()> {
        if let Some(handle) = self.jobs.lock().await.remove(target) {
            handle.abort();
        }
        Ok(())
    }
}

async fn run_child_process(request: SpawnRequest) -> Result<String> {
    let executable = resolve_kordi_cli_executable()?;
    let prompt_context =
        prompt_context(&request.task_path, &request.task_name, &request.write_scope);
    let mut command = Command::new(executable);
    command
        .kill_on_drop(true)
        .arg("-C")
        .arg(&request.cwd)
        .arg("-p")
        .arg("--no-session")
        .arg("--tools")
        .arg(child_agent_tool_names(!request.write_scope.is_empty()))
        .arg("--append-system-prompt")
        .arg(prompt_context)
        .arg(request.message);
    let output = tokio::time::timeout(CHILD_AGENT_PROCESS_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow!("child task exceeded the five-minute process limit"))??;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() {
            "child task completed without text output".to_string()
        } else {
            truncate_summary(&stdout)
        })
    } else {
        Err(anyhow!(if stderr.is_empty() {
            format!("child task exited with status {}", output.status)
        } else {
            truncate_summary(&stderr)
        }))
    }
}

fn resolve_kordi_cli_executable() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("KORDI_CLI_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let current = std::env::current_exe()?;
    let current_name = current
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if current_name == "kordi"
        || (current_name.starts_with("kordi-") && !current_name.contains("desktop"))
    {
        return Ok(current);
    }

    if let Some(parent) = current.parent() {
        for candidate_name in ["kordi", "kordi.exe"] {
            let candidate = parent.join(candidate_name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    for ancestor in current.ancestors() {
        for dir in [
            ancestor.join("Resources").join("binaries"),
            ancestor.join("src-tauri").join("binaries"),
        ] {
            if let Some(candidate) = first_kordi_sidecar_in(&dir) {
                return Ok(candidate);
            }
        }
    }

    bail!("could not locate kordi CLI executable for task_operator child agent")
}

fn first_kordi_sidecar_in(dir: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| {
                        name == "kordi" || (name.starts_with("kordi-") && !name.contains("desktop"))
                    })
        })
}
