pub(crate) mod registry;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use kordi_core::error::KordiError;
use kordi_tools::task_operator::models::{
    TaskCloseRequest, TaskListRequest, TaskMessageRequest, TaskOperatorRuntimeRequest,
    TaskOperatorRuntimeResponse, TaskOperatorTaskStatus, TaskSpawnRequest, TaskWaitRequest,
};
use kordi_tools::{TaskOperatorFn, TaskOperatorRuntime};
use registry::{TaskAgentMetadata, TaskAgentRegistry, TaskAgentStatus};
use tokio::{process::Command, sync::Mutex, task::JoinHandle};

const DEFAULT_MAX_LIVE_TASKS: usize = 4;
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpawnRequest {
    pub(crate) task_path: String,
    pub(crate) task_name: String,
    pub(crate) message: String,
    pub(crate) fork_turns: Option<String>,
    pub(crate) write_scope: Vec<String>,
    pub(crate) cwd: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpawnedTask {
    pub(crate) task_path: String,
    pub(crate) status: TaskAgentStatus,
    pub(crate) summary: Option<String>,
}

impl SpawnedTask {
    pub(crate) fn running(task_path: impl Into<String>) -> Self {
        Self {
            task_path: task_path.into(),
            status: TaskAgentStatus::Running,
            summary: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WaitOutcome {
    Completed { target: String, summary: String },
    Failed { target: String, summary: String },
    TimedOut,
}

#[async_trait]
pub(crate) trait ChildAgentRunner: Send + Sync {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask>;
    async fn send(&self, target: &str, message: String) -> Result<()>;
    async fn wait(&self, timeout_ms: u64) -> Result<WaitOutcome>;
    async fn close(&self, target: &str) -> Result<()>;
}

struct TaskOperatorState {
    registry: Mutex<TaskAgentRegistry>,
    runner: Arc<dyn ChildAgentRunner>,
    cwd: PathBuf,
}

pub(crate) fn build_task_operator_runtime(cwd: PathBuf) -> TaskOperatorRuntime {
    build_task_operator_runtime_with_runner(
        Arc::new(SubprocessChildAgentRunner::new()),
        cwd,
        DEFAULT_MAX_LIVE_TASKS,
    )
}

pub(crate) fn build_task_operator_runtime_with_runner(
    runner: Arc<dyn ChildAgentRunner>,
    cwd: PathBuf,
    max_live_tasks: usize,
) -> TaskOperatorRuntime {
    let state = Arc::new(TaskOperatorState {
        registry: Mutex::new(TaskAgentRegistry::new(max_live_tasks)),
        runner,
        cwd,
    });
    let run: TaskOperatorFn = Arc::new(move |request| {
        let state = state.clone();
        Box::pin(async move {
            state
                .handle(request)
                .await
                .map_err(|err| KordiError::Tool(err.to_string()))
        })
    });
    TaskOperatorRuntime { run }
}

impl TaskOperatorState {
    async fn handle(
        &self,
        request: TaskOperatorRuntimeRequest,
    ) -> Result<TaskOperatorRuntimeResponse> {
        match request {
            TaskOperatorRuntimeRequest::Spawn(request) => self.spawn(request).await,
            TaskOperatorRuntimeRequest::Message(request) => self.message(request).await,
            TaskOperatorRuntimeRequest::Wait(request) => self.wait(request).await,
            TaskOperatorRuntimeRequest::List(request) => self.list(request).await,
            TaskOperatorRuntimeRequest::Close(request) => self.close(request).await,
        }
    }

    async fn spawn(&self, request: TaskSpawnRequest) -> Result<TaskOperatorRuntimeResponse> {
        let task_name = request.task_name.trim();
        if task_name.is_empty() {
            bail!("task_name cannot be empty")
        }
        if request.message.trim().is_empty() {
            bail!("spawn message cannot be empty")
        }

        let metadata = {
            let mut registry = self.registry.lock().await;
            registry.reserve(task_name, task_name, request.write_scope.clone())?
        };
        let task_path = metadata.path.as_str().to_string();
        let spawn_request = SpawnRequest {
            task_path: task_path.clone(),
            task_name: task_name.to_string(),
            message: request.message,
            fork_turns: request.fork_turns,
            write_scope: request.write_scope,
            cwd: self.cwd.clone(),
        };

        let spawned = match self.runner.spawn(spawn_request).await {
            Ok(spawned) => spawned,
            Err(error) => {
                let mut registry = self.registry.lock().await;
                let _ = registry.mark_failed(&task_path, Some(error.to_string()));
                return Err(error);
            }
        };
        {
            let mut registry = self.registry.lock().await;
            apply_spawned_status(&mut registry, &spawned)?;
        }

        Ok(TaskOperatorRuntimeResponse {
            status: spawned.status.as_str().to_string(),
            message: Some(format!(
                "Task agent {}: {}",
                spawned.status.as_str(),
                task_path
            )),
            target: Some(task_path),
            tasks: Vec::new(),
        })
    }

    async fn message(&self, request: TaskMessageRequest) -> Result<TaskOperatorRuntimeResponse> {
        let target = request.target.trim();
        if target.is_empty() {
            bail!("message target cannot be empty")
        }
        if request.message.trim().is_empty() {
            bail!("message cannot be empty")
        }
        {
            let registry = self.registry.lock().await;
            let metadata = registry.get(target)?;
            if !metadata.status.is_live() {
                bail!(
                    "task `{target}` is not live; current status is {}",
                    metadata.status.as_str()
                );
            }
        }
        self.runner.send(target, request.message).await?;
        Ok(TaskOperatorRuntimeResponse {
            status: "sent".to_string(),
            message: Some(format!("Message sent to {target}")),
            target: Some(target.to_string()),
            tasks: Vec::new(),
        })
    }

    async fn wait(&self, request: TaskWaitRequest) -> Result<TaskOperatorRuntimeResponse> {
        let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_WAIT_TIMEOUT_MS);
        match self.runner.wait(timeout_ms).await? {
            WaitOutcome::Completed { target, summary } => {
                let mut registry = self.registry.lock().await;
                registry.mark_completed(&target, Some(summary.clone()))?;
                Ok(TaskOperatorRuntimeResponse {
                    status: "completed".to_string(),
                    message: Some(format!("Task completed: {target}")),
                    target: Some(target),
                    tasks: Vec::new(),
                })
            }
            WaitOutcome::Failed { target, summary } => {
                let mut registry = self.registry.lock().await;
                registry.mark_failed(&target, Some(summary.clone()))?;
                Ok(TaskOperatorRuntimeResponse {
                    status: "failed".to_string(),
                    message: Some(format!("Task failed: {target}")),
                    target: Some(target),
                    tasks: Vec::new(),
                })
            }
            WaitOutcome::TimedOut => Ok(TaskOperatorRuntimeResponse {
                status: "timed_out".to_string(),
                message: Some("No task completed before timeout".to_string()),
                target: None,
                tasks: Vec::new(),
            }),
        }
    }

    async fn list(&self, request: TaskListRequest) -> Result<TaskOperatorRuntimeResponse> {
        let registry = self.registry.lock().await;
        let tasks = registry
            .list(request.path_prefix.as_deref())?
            .into_iter()
            .map(task_status_from_metadata)
            .collect::<Vec<_>>();
        Ok(TaskOperatorRuntimeResponse {
            status: "listed".to_string(),
            message: Some(format!("Listed {} task agent(s)", tasks.len())),
            target: None,
            tasks,
        })
    }

    async fn close(&self, request: TaskCloseRequest) -> Result<TaskOperatorRuntimeResponse> {
        let target = request.target.as_deref().unwrap_or_default().trim();
        if target.is_empty() {
            bail!("close target cannot be empty")
        }
        {
            let registry = self.registry.lock().await;
            registry.get(target)?;
        }
        self.runner.close(target).await?;
        let mut registry = self.registry.lock().await;
        registry.close(target)?;
        Ok(TaskOperatorRuntimeResponse {
            status: "closed".to_string(),
            message: Some(format!("Task agent closed: {target}")),
            target: Some(target.to_string()),
            tasks: Vec::new(),
        })
    }
}

fn apply_spawned_status(registry: &mut TaskAgentRegistry, spawned: &SpawnedTask) -> Result<()> {
    match spawned.status {
        TaskAgentStatus::Reserved => Ok(()),
        TaskAgentStatus::Running => registry.mark_running(&spawned.task_path),
        TaskAgentStatus::Completed => {
            registry.mark_completed(&spawned.task_path, spawned.summary.clone())
        }
        TaskAgentStatus::Failed => {
            registry.mark_failed(&spawned.task_path, spawned.summary.clone())
        }
        TaskAgentStatus::Closed => registry.close(&spawned.task_path),
    }
}

fn task_status_from_metadata(metadata: TaskAgentMetadata) -> TaskOperatorTaskStatus {
    TaskOperatorTaskStatus {
        path: metadata.path.as_str().to_string(),
        title: metadata.title,
        status: metadata.status.as_str().to_string(),
        summary: metadata.summary,
        write_scope: metadata.write_scope,
    }
}

#[derive(Clone, Default)]
struct SubprocessChildAgentRunner {
    jobs: Arc<Mutex<BTreeMap<String, JoinHandle<Result<String>>>>>,
    messages: Arc<Mutex<BTreeMap<String, Vec<String>>>>,
}

impl SubprocessChildAgentRunner {
    fn new() -> Self {
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
    let write_scope = if request.write_scope.is_empty() {
        "read-only".to_string()
    } else {
        request.write_scope.join(", ")
    };
    let prompt_context = format!(
        "You are a scoped child task agent. Task path: {}. Task name: {}. Write scope: {}. Stay within this scope and return a concise final report.",
        request.task_path, request.task_name, write_scope
    );
    let output = Command::new(executable)
        .arg("-C")
        .arg(&request.cwd)
        .arg("-p")
        .arg("--no-session")
        .arg("--tools")
        .arg("read,grep,find,ls,web_fetch,bash,edit,write")
        .arg("--append-system-prompt")
        .arg(prompt_context)
        .arg(request.message)
        .output()
        .await?;

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

fn truncate_summary(value: &str) -> String {
    const MAX_CHARS: usize = 2_000;
    let compact = value.trim();
    if compact.chars().count() <= MAX_CHARS {
        return compact.to_string();
    }
    let truncated = compact.chars().take(MAX_CHARS).collect::<String>();
    format!("{}…", truncated.trim_end())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use anyhow::Result;
    use async_trait::async_trait;
    use kordi_tools::task_operator::models::TaskOperatorRuntimeRequest;

    use super::{
        ChildAgentRunner, SpawnRequest, SpawnedTask, WaitOutcome,
        build_task_operator_runtime_with_runner,
    };

    #[derive(Default)]
    struct FakeRunner {
        spawned: StdMutex<Vec<SpawnRequest>>,
        sent: StdMutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl ChildAgentRunner for FakeRunner {
        async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask> {
            self.spawned.lock().unwrap().push(request.clone());
            Ok(SpawnedTask::running(request.task_path))
        }

        async fn send(&self, target: &str, message: String) -> Result<()> {
            self.sent
                .lock()
                .unwrap()
                .push((target.to_string(), message));
            Ok(())
        }

        async fn wait(&self, _timeout_ms: u64) -> Result<WaitOutcome> {
            Ok(WaitOutcome::Completed {
                target: "/root/research".to_string(),
                summary: "done".to_string(),
            })
        }

        async fn close(&self, _target: &str) -> Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn task_operator_runtime_spawn_rejects_overlapping_live_write_scopes() {
        let runner = Arc::new(FakeRunner::default());
        let runtime = build_task_operator_runtime_with_runner(
            runner.clone(),
            std::path::PathBuf::from("/tmp/project"),
            4,
        );

        (runtime.run)(TaskOperatorRuntimeRequest::Spawn(
            kordi_tools::task_operator::models::TaskSpawnRequest {
                task_name: "writer".to_string(),
                message: "write one".to_string(),
                fork_turns: None,
                write_scope: vec!["src".to_string()],
            },
        ))
        .await
        .expect("first spawn should reserve scope");

        let error = (runtime.run)(TaskOperatorRuntimeRequest::Spawn(
            kordi_tools::task_operator::models::TaskSpawnRequest {
                task_name: "nested".to_string(),
                message: "write nested".to_string(),
                fork_turns: None,
                write_scope: vec!["src/task_operator".to_string()],
            },
        ))
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("write scope overlaps"));
        assert_eq!(runner.spawned.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn task_operator_runtime_supports_message_wait_list_and_close() {
        let runner = Arc::new(FakeRunner::default());
        let runtime = build_task_operator_runtime_with_runner(
            runner.clone(),
            std::path::PathBuf::from("/tmp/project"),
            4,
        );

        (runtime.run)(TaskOperatorRuntimeRequest::Spawn(
            kordi_tools::task_operator::models::TaskSpawnRequest {
                task_name: "research".to_string(),
                message: "research".to_string(),
                fork_turns: None,
                write_scope: vec![],
            },
        ))
        .await
        .expect("spawn");

        (runtime.run)(TaskOperatorRuntimeRequest::Message(
            kordi_tools::task_operator::models::TaskMessageRequest {
                target: "/root/research".to_string(),
                message: "follow up".to_string(),
            },
        ))
        .await
        .expect("message");

        let wait = (runtime.run)(TaskOperatorRuntimeRequest::Wait(
            kordi_tools::task_operator::models::TaskWaitRequest {
                timeout_ms: Some(10),
            },
        ))
        .await
        .expect("wait");
        assert_eq!(wait.status, "completed");

        let list = (runtime.run)(TaskOperatorRuntimeRequest::List(
            kordi_tools::task_operator::models::TaskListRequest {
                path_prefix: Some("/root".to_string()),
            },
        ))
        .await
        .expect("list");
        assert_eq!(list.tasks.len(), 1);
        assert_eq!(list.tasks[0].status, "completed");

        (runtime.run)(TaskOperatorRuntimeRequest::Close(
            kordi_tools::task_operator::models::TaskCloseRequest {
                target: Some("/root/research".to_string()),
                task_id: None,
                task_title: None,
                query: None,
            },
        ))
        .await
        .expect("close");

        assert_eq!(
            runner.sent.lock().unwrap().as_slice(),
            &[("/root/research".to_string(), "follow up".to_string())]
        );
    }
}
