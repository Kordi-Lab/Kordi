mod child_process_policy;
pub(crate) mod registry;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Result, anyhow, bail};
use async_trait::async_trait;
use kordi_core::{
    error::KordiError,
    types::{AgentMessage, AssistantContent, SessionEntry, StopReason},
};
use kordi_tools::task_operator::models::{
    TaskCloseRequest, TaskCreateRequest, TaskInspectRequest, TaskListRequest, TaskMessageRequest,
    TaskOperatorBackgroundSession, TaskOperatorRuntimeRequest, TaskOperatorRuntimeResponse,
    TaskOperatorTaskStatus, TaskSearchRequest, TaskSpawnRequest, TaskWaitRequest,
};
use kordi_tools::{TaskOperatorFn, TaskOperatorRuntime};
use registry::{TaskAgentMetadata, TaskAgentRegistry, TaskAgentStatus};
use tokio::{process::Command, sync::Mutex, task::JoinHandle};

use child_process_policy::{CHILD_AGENT_PROCESS_TIMEOUT, child_agent_tool_names, prompt_context};

pub(crate) const DEFAULT_MAX_LIVE_TASKS: usize = 4;
const DEFAULT_WAIT_TIMEOUT_MS: u64 = 30_000;

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
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    Completed { target: String, summary: String },
    Failed { target: String, summary: String },
    TimedOut,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackgroundSessionInspection {
    pub status: String,
    pub summary: Option<String>,
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

struct TaskOperatorState {
    registry: Mutex<TaskAgentRegistry>,
    runner: Arc<dyn ChildAgentRunner>,
    cwd: PathBuf,
    session_id: String,
    store: Option<Arc<Mutex<rusqlite::Connection>>>,
}

pub(crate) fn build_task_operator_runtime(
    cwd: PathBuf,
    session_id: String,
    store: Arc<Mutex<rusqlite::Connection>>,
) -> TaskOperatorRuntime {
    build_task_operator_runtime_with_runner_and_store(
        Arc::new(SubprocessChildAgentRunner::new()),
        cwd,
        session_id,
        DEFAULT_MAX_LIVE_TASKS,
        store,
    )
}

#[allow(dead_code)]
pub(crate) fn build_task_operator_runtime_with_runner(
    runner: Arc<dyn ChildAgentRunner>,
    cwd: PathBuf,
    max_live_tasks: usize,
) -> TaskOperatorRuntime {
    build_task_operator_runtime_with_runner_inner(
        runner,
        cwd,
        "test-session".to_string(),
        max_live_tasks,
        None,
    )
}

pub(crate) fn build_task_operator_runtime_with_runner_and_store(
    runner: Arc<dyn ChildAgentRunner>,
    cwd: PathBuf,
    session_id: String,
    max_live_tasks: usize,
    store: Arc<Mutex<rusqlite::Connection>>,
) -> TaskOperatorRuntime {
    build_task_operator_runtime_with_runner_inner(
        runner,
        cwd,
        session_id,
        max_live_tasks,
        Some(store),
    )
}

fn build_task_operator_runtime_with_runner_inner(
    runner: Arc<dyn ChildAgentRunner>,
    cwd: PathBuf,
    session_id: String,
    max_live_tasks: usize,
    store: Option<Arc<Mutex<rusqlite::Connection>>>,
) -> TaskOperatorRuntime {
    let state = Arc::new(TaskOperatorState {
        registry: Mutex::new(TaskAgentRegistry::new(max_live_tasks)),
        runner,
        cwd,
        session_id,
        store,
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
    async fn create(&self, request: TaskCreateRequest) -> Result<TaskOperatorRuntimeResponse> {
        let title = request.task_title.trim();
        if title.is_empty() {
            bail!("taskTitle cannot be empty for task create")
        }
        let task_id = match request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(candidate) if self.existing_task_id(candidate).await? => candidate.to_string(),
            _ => generated_task_id(),
        };
        let Some(store) = self.store.as_ref() else {
            bail!("task_operator durable task storage is unavailable")
        };
        let stored = {
            let conn = store.lock().await;
            kordi_session::tasks::upsert_task(
                &conn,
                kordi_session::tasks::NewTask {
                    session_id: self.session_id.clone(),
                    task_id: task_id.clone(),
                    parent_task_id: request.parent_task_id.clone(),
                    title: title.to_string(),
                    summary: request.summary.clone(),
                    status: request.status.clone(),
                    involved_participants: request.involved_participants.clone(),
                },
            )?
        };

        Ok(TaskOperatorRuntimeResponse {
            status: "created".to_string(),
            message: Some(format!("Task created: {}", stored.title)),
            target: Some(stored.task_id.clone()),
            tasks: vec![task_status_from_stored(stored)],
            background_session: None,
        })
    }

    async fn search(&self, request: TaskSearchRequest) -> Result<TaskOperatorRuntimeResponse> {
        let Some(store) = self.store.as_ref() else {
            bail!("task_operator durable task storage is unavailable")
        };
        let query = request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let tasks = {
            let conn = store.lock().await;
            kordi_session::tasks::search_tasks(
                &conn,
                &self.session_id,
                query,
                request.status.as_deref(),
                request.parent_task_id.as_deref(),
            )?
        }
        .into_iter()
        .map(task_status_from_stored)
        .collect::<Vec<_>>();

        Ok(TaskOperatorRuntimeResponse {
            status: "searched".to_string(),
            message: Some(if query.is_some() {
                format!("Task search matched {} task(s)", tasks.len())
            } else {
                format!("Listed {} session task(s)", tasks.len())
            }),
            target: None,
            tasks,
            background_session: None,
        })
    }

    async fn existing_task_id(&self, task_id: &str) -> Result<bool> {
        let Some(store) = self.store.as_ref() else {
            return Ok(false);
        };
        let conn = store.lock().await;
        Ok(kordi_session::tasks::get_task(&conn, &self.session_id, task_id)?.is_some())
    }

    async fn handle(
        &self,
        request: TaskOperatorRuntimeRequest,
    ) -> Result<TaskOperatorRuntimeResponse> {
        match request {
            TaskOperatorRuntimeRequest::Create(request) => self.create(request).await,
            TaskOperatorRuntimeRequest::Search(request) => self.search(request).await,
            TaskOperatorRuntimeRequest::Spawn(request) => self.spawn(request).await,
            TaskOperatorRuntimeRequest::Message(request) => self.message(request).await,
            TaskOperatorRuntimeRequest::Wait(request) => self.wait(request).await,
            TaskOperatorRuntimeRequest::List(request) => self.list(request).await,
            TaskOperatorRuntimeRequest::Inspect(request) => self.inspect(request).await,
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
        let task_title = request
            .task_title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| humanize_task_name(task_name));

        let metadata = {
            let mut registry = self.registry.lock().await;
            registry.reserve(task_name, &task_title, request.write_scope.clone())?
        };
        let task_path = metadata.path.as_str().to_string();
        let spawn_request = SpawnRequest {
            task_path: task_path.clone(),
            task_name: task_name.to_string(),
            task_title,
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
            background_session: spawned.background_session,
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
            background_session: None,
        })
    }

    async fn wait(&self, request: TaskWaitRequest) -> Result<TaskOperatorRuntimeResponse> {
        let has_live_agents = self
            .registry
            .lock()
            .await
            .list(None)?
            .iter()
            .any(|task| task.status.is_live());
        if !has_live_agents {
            return Ok(TaskOperatorRuntimeResponse {
                status: "no_live_agents".to_string(),
                message: Some(
                    "No live task agents are registered in this runtime. This does not describe linked background sessions; use inspect with the exact sessionId."
                        .to_string(),
                ),
                target: None,
                tasks: Vec::new(),
                background_session: None,
            });
        }
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
                    background_session: None,
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
                    background_session: None,
                })
            }
            WaitOutcome::TimedOut => Ok(TaskOperatorRuntimeResponse {
                status: "timed_out".to_string(),
                message: Some("No task completed before timeout".to_string()),
                target: None,
                tasks: Vec::new(),
                background_session: None,
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
            message: Some(if tasks.is_empty() {
                "Listed 0 task agents in this runtime. This does not describe linked background sessions; use inspect with the exact sessionId."
                    .to_string()
            } else {
                format!("Listed {} task agent(s)", tasks.len())
            }),
            target: None,
            tasks,
            background_session: None,
        })
    }

    async fn inspect(&self, request: TaskInspectRequest) -> Result<TaskOperatorRuntimeResponse> {
        let session_id = request.session_id.trim();
        if session_id.is_empty() {
            bail!("sessionId cannot be empty for inspect")
        }
        let Some(store) = self.store.as_ref() else {
            bail!("task_operator durable task storage is unavailable")
        };
        let active_inspection = self.runner.inspect(session_id).await?;
        let (title, inspection) = {
            let conn = store.lock().await;
            let session = kordi_session::store::get_session(&conn, session_id)?
                .ok_or_else(|| anyhow!("background session `{session_id}` was not found"))?;
            let title = session
                .name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Background session".to_string());
            let inspection = match active_inspection {
                Some(active) => active,
                None => inspect_persisted_background_session(&conn, session_id)?,
            };
            (title, inspection)
        };
        let summary = inspection
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(truncate_summary);
        let message = match summary.as_deref() {
            Some(summary) => format!(
                "Background session {}: {}\n\nResult:\n{}",
                inspection.status, session_id, summary
            ),
            None => format!("Background session {}: {}", inspection.status, session_id),
        };
        Ok(TaskOperatorRuntimeResponse {
            status: inspection.status.clone(),
            message: Some(message),
            target: Some(session_id.to_string()),
            tasks: Vec::new(),
            background_session: Some(TaskOperatorBackgroundSession {
                session_id: session_id.to_string(),
                turn_id: None,
                title,
                status: inspection.status,
            }),
        })
    }

    async fn close(&self, request: TaskCloseRequest) -> Result<TaskOperatorRuntimeResponse> {
        let target = request.target.as_deref().unwrap_or_default().trim();
        if target.starts_with('/') {
            {
                let registry = self.registry.lock().await;
                registry.get(target)?;
            }
            self.runner.close(target).await?;
            let mut registry = self.registry.lock().await;
            registry.close(target)?;
            return Ok(TaskOperatorRuntimeResponse {
                status: "closed".to_string(),
                message: Some(format!("Task agent closed: {target}")),
                target: Some(target.to_string()),
                tasks: Vec::new(),
                background_session: None,
            });
        }

        let Some(store) = self.store.as_ref() else {
            bail!("task_operator durable task storage is unavailable")
        };
        let stored = {
            let conn = store.lock().await;
            let task_id = match request
                .task_id
                .as_deref()
                .or(request.target.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(task_id) => task_id.to_string(),
                None => resolve_close_task_id(&conn, &self.session_id, &request)?,
            };
            kordi_session::tasks::close_task(&conn, &self.session_id, &task_id)?
        };
        Ok(TaskOperatorRuntimeResponse {
            status: "closed".to_string(),
            message: Some(format!("Task closed: {}", stored.title)),
            target: Some(stored.task_id.clone()),
            tasks: vec![task_status_from_stored(stored)],
            background_session: None,
        })
    }
}

fn assistant_text(message: &kordi_core::types::AssistantMessage) -> Option<String> {
    let text = message
        .content
        .iter()
        .filter_map(|content| match content {
            AssistantContent::Text { text } if !text.trim().is_empty() => Some(text.trim()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

pub(crate) fn inspect_persisted_background_session(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<BackgroundSessionInspection> {
    let path = kordi_session::tree::active_path(conn, session_id)?;
    let messages = path
        .into_iter()
        .filter_map(|row| match kordi_session::store::parse_entry(&row) {
            Ok(SessionEntry::Message { message, .. }) => Some(Ok(message)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(inspect_background_messages(messages))
}

fn inspect_background_messages(
    messages: impl IntoIterator<Item = AgentMessage>,
) -> BackgroundSessionInspection {
    let mut pending_request = false;
    let mut status = None;
    let mut summary = None;

    for message in messages {
        match message {
            AgentMessage::User(_) => {
                pending_request = true;
                status = None;
                summary = None;
            }
            AgentMessage::Assistant(message) => {
                if let Some(text) = assistant_text(&message) {
                    summary = Some(text);
                }
                match message.stop_reason {
                    StopReason::Stop => {
                        pending_request = false;
                        status = Some("completed");
                    }
                    StopReason::Length => {
                        pending_request = false;
                        status = Some("failed");
                        summary = Some(match summary {
                            Some(partial) => format!(
                                "The background session reached its output limit before finishing.\n\nPartial output:\n{partial}"
                            ),
                            None => {
                                "The background session reached its output limit before finishing."
                                    .to_string()
                            }
                        });
                    }
                    StopReason::ToolUse => {
                        pending_request = true;
                        status = None;
                    }
                    StopReason::Error => {
                        pending_request = false;
                        status = Some("failed");
                        if let Some(error) = message
                            .error_message
                            .filter(|value| !value.trim().is_empty())
                        {
                            summary = Some(error);
                        }
                    }
                    StopReason::Aborted => {
                        pending_request = false;
                        status = Some("stopped");
                    }
                }
            }
            _ => {}
        }
    }

    if pending_request || status.is_none() {
        let interrupted = "The background session was interrupted before producing a final result.";
        return BackgroundSessionInspection {
            status: "failed".to_string(),
            summary: Some(match summary {
                Some(partial) => format!("{interrupted}\n\nPartial output:\n{partial}"),
                None => interrupted.to_string(),
            }),
        };
    }

    BackgroundSessionInspection {
        status: status.unwrap_or("failed").to_string(),
        summary,
    }
}

fn humanize_task_name(task_name: &str) -> String {
    let words = task_name.replace('_', " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Background task".to_string(),
    }
}

fn resolve_close_task_id(
    conn: &rusqlite::Connection,
    session_id: &str,
    request: &TaskCloseRequest,
) -> Result<String> {
    let query = request
        .task_title
        .as_deref()
        .or(request.query.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("close requires taskId, taskTitle, query, or child-agent target"))?;
    let mut matches =
        kordi_session::tasks::search_tasks(conn, session_id, Some(query), Some("open"), None)?;
    if matches.len() > 1 {
        let normalized_query = query.to_lowercase();
        let exact_matches = matches
            .iter()
            .filter(|task| {
                task.task_id.to_lowercase() == normalized_query
                    || task.title.to_lowercase() == normalized_query
            })
            .cloned()
            .collect::<Vec<_>>();
        if exact_matches.len() == 1 {
            matches = exact_matches;
        }
    }

    match matches.as_slice() {
        [task] => Ok(task.task_id.clone()),
        [] => bail!("no open task matched close query `{query}`"),
        many => {
            let labels = many
                .iter()
                .take(5)
                .map(|task| format!("{} ({})", task.title, task.task_id))
                .collect::<Vec<_>>()
                .join(", ");
            bail!(
                "close query `{query}` matched multiple open tasks; provide taskId. Matches: {labels}"
            )
        }
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

fn generated_task_id() -> String {
    format!("task_{}", uuid::Uuid::new_v4().simple())
}

fn task_status_from_stored(task: kordi_session::tasks::StoredTask) -> TaskOperatorTaskStatus {
    TaskOperatorTaskStatus {
        path: task.task_id,
        parent_task_id: task.parent_task_id,
        title: task.title,
        status: task.status,
        summary: task.summary,
        write_scope: Vec::new(),
    }
}

fn task_status_from_metadata(metadata: TaskAgentMetadata) -> TaskOperatorTaskStatus {
    TaskOperatorTaskStatus {
        path: metadata.path.as_str().to_string(),
        parent_task_id: None,
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
    use kordi_core::types::{
        AgentMessage, AssistantContent, AssistantMessage, ContentBlock, StopReason, Usage,
        UserMessage,
    };
    use kordi_tools::task_operator::models::TaskOperatorRuntimeRequest;
    use rusqlite::Connection;
    use tokio::sync::Mutex as TokioMutex;

    use super::{
        ChildAgentRunner, SpawnRequest, SpawnedTask, WaitOutcome,
        build_task_operator_runtime_with_runner, inspect_background_messages,
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

    fn user_message() -> AgentMessage {
        AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "Review the harness".to_string(),
            }],
            timestamp: 1,
        })
    }

    fn assistant_message(stop_reason: StopReason, content: Vec<AssistantContent>) -> AgentMessage {
        AgentMessage::Assistant(AssistantMessage {
            content,
            provider: "test".to_string(),
            model: "test".to_string(),
            usage: Usage::default(),
            stop_reason,
            error_message: None,
            timestamp: 2,
        })
    }

    #[test]
    fn persisted_background_inspection_distinguishes_final_and_interrupted_turns() {
        let completed = inspect_background_messages([
            user_message(),
            assistant_message(
                StopReason::Stop,
                vec![AssistantContent::Text {
                    text: "Final report".to_string(),
                }],
            ),
        ]);
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.summary.as_deref(), Some("Final report"));

        let interrupted = inspect_background_messages([
            user_message(),
            assistant_message(
                StopReason::ToolUse,
                vec![
                    AssistantContent::Text {
                        text: "I will start the review".to_string(),
                    },
                    AssistantContent::ToolCall {
                        id: "tool-1".to_string(),
                        name: "read".to_string(),
                        arguments: serde_json::json!({ "path": "src" }),
                    },
                ],
            ),
        ]);
        assert_eq!(interrupted.status, "failed");
        assert!(interrupted.summary.as_deref().is_some_and(|summary| {
            summary.contains("interrupted before producing a final result")
        }));
    }

    #[tokio::test]
    async fn task_operator_runtime_persists_user_visible_tasks() {
        let runner = Arc::new(FakeRunner::default());
        let conn = Arc::new(TokioMutex::new(Connection::open_in_memory().expect("conn")));
        {
            let guard = conn.lock().await;
            kordi_session::schema::init_schema(&guard).expect("schema");
        }
        let runtime = super::build_task_operator_runtime_with_runner_and_store(
            runner,
            std::path::PathBuf::from("/tmp/project"),
            "session-a".to_string(),
            4,
            conn.clone(),
        );

        (runtime.run)(TaskOperatorRuntimeRequest::Create(
            kordi_tools::task_operator::models::TaskCreateRequest {
                task_id: None,
                parent_task_id: None,
                task_title: "Finish Kordi Issue 317".to_string(),
                summary: Some("Implement fork flow".to_string()),
                status: None,
                involved_participants: vec!["Alex".to_string(), "Kordi".to_string()],
            },
        ))
        .await
        .expect("create should persist");

        let search = (runtime.run)(TaskOperatorRuntimeRequest::Search(
            kordi_tools::task_operator::models::TaskSearchRequest {
                query: Some("issue 317".to_string()),
                status: None,
                parent_task_id: None,
            },
        ))
        .await
        .expect("search should read persisted task");

        assert_eq!(search.status, "searched");
        assert_eq!(search.tasks.len(), 1);
        assert!(search.tasks[0].path.starts_with("task_"));
        let task_id = search.tasks[0].path.clone();
        assert_eq!(search.tasks[0].title, "Finish Kordi Issue 317");
        assert_eq!(search.tasks[0].status, "open");

        (runtime.run)(TaskOperatorRuntimeRequest::Close(
            kordi_tools::task_operator::models::TaskCloseRequest {
                target: None,
                task_id: Some(task_id),
                task_title: None,
                query: None,
            },
        ))
        .await
        .expect("close should update persisted task");

        let closed = (runtime.run)(TaskOperatorRuntimeRequest::Search(
            kordi_tools::task_operator::models::TaskSearchRequest {
                query: Some("issue 317".to_string()),
                status: Some("closed".to_string()),
                parent_task_id: None,
            },
        ))
        .await
        .expect("search closed should read persisted task");
        assert_eq!(closed.tasks.len(), 1);
        assert_eq!(closed.tasks[0].status, "closed");
    }

    #[tokio::test]
    async fn task_operator_runtime_search_without_query_lists_only_current_session_tasks() {
        let conn = Arc::new(TokioMutex::new(Connection::open_in_memory().expect("conn")));
        {
            let guard = conn.lock().await;
            kordi_session::schema::init_schema(&guard).expect("schema");
            kordi_session::tasks::upsert_task(
                &guard,
                kordi_session::tasks::NewTask {
                    session_id: "session-a".to_string(),
                    task_id: "task_a".to_string(),
                    parent_task_id: None,
                    title: "Current session task".to_string(),
                    summary: None,
                    status: Some("open".to_string()),
                    involved_participants: Vec::new(),
                },
            )
            .expect("task a");
            kordi_session::tasks::upsert_task(
                &guard,
                kordi_session::tasks::NewTask {
                    session_id: "session-b".to_string(),
                    task_id: "task_b".to_string(),
                    parent_task_id: None,
                    title: "Other session task".to_string(),
                    summary: None,
                    status: Some("open".to_string()),
                    involved_participants: Vec::new(),
                },
            )
            .expect("task b");
        }
        let runtime = super::build_task_operator_runtime_with_runner_and_store(
            Arc::new(FakeRunner::default()),
            std::path::PathBuf::from("/tmp/project"),
            "session-a".to_string(),
            4,
            conn,
        );

        let listed = (runtime.run)(TaskOperatorRuntimeRequest::Search(
            kordi_tools::task_operator::models::TaskSearchRequest {
                query: None,
                status: Some("open".to_string()),
                parent_task_id: None,
            },
        ))
        .await
        .expect("list current session tasks");

        assert_eq!(listed.message.as_deref(), Some("Listed 1 session task(s)"));
        assert_eq!(listed.tasks.len(), 1);
        assert_eq!(listed.tasks[0].path, "task_a");
    }

    #[tokio::test]
    async fn task_operator_runtime_closes_unique_user_visible_task_by_title_or_query() {
        let runner = Arc::new(FakeRunner::default());
        let conn = Arc::new(TokioMutex::new(Connection::open_in_memory().expect("conn")));
        {
            let guard = conn.lock().await;
            kordi_session::schema::init_schema(&guard).expect("schema");
        }
        let runtime = super::build_task_operator_runtime_with_runner_and_store(
            runner,
            std::path::PathBuf::from("/tmp/project"),
            "session-a".to_string(),
            4,
            conn,
        );

        (runtime.run)(TaskOperatorRuntimeRequest::Create(
            kordi_tools::task_operator::models::TaskCreateRequest {
                task_id: None,
                parent_task_id: None,
                task_title: "Finish Kordi Issue 317 Review".to_string(),
                summary: Some("Review issue 317".to_string()),
                status: None,
                involved_participants: vec![
                    "Kordi User 2".to_string(),
                    "Kordi User 3's Kordi".to_string(),
                ],
            },
        ))
        .await
        .expect("create should persist");

        let closed = (runtime.run)(TaskOperatorRuntimeRequest::Close(
            kordi_tools::task_operator::models::TaskCloseRequest {
                target: None,
                task_id: None,
                task_title: Some("Finish Kordi Issue 317 Review".to_string()),
                query: Some("Finish Kordi Issue 317 Review".to_string()),
            },
        ))
        .await
        .expect("close should resolve unique task by title/query");

        assert_eq!(closed.status, "closed");
        assert!(
            closed
                .target
                .as_deref()
                .unwrap_or_default()
                .starts_with("task_")
        );
        assert_eq!(closed.tasks.len(), 1);
        assert_eq!(closed.tasks[0].path, closed.target.as_deref().unwrap());
        assert_eq!(closed.tasks[0].status, "closed");
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
                task_title: None,
                message: "write one".to_string(),
                fork_turns: None,
                write_scope: vec!["src".to_string()],
            },
        ))
        .await
        .expect("first spawn should reserve scope");
        assert_eq!(runner.spawned.lock().unwrap()[0].task_title, "Writer");

        let error = (runtime.run)(TaskOperatorRuntimeRequest::Spawn(
            kordi_tools::task_operator::models::TaskSpawnRequest {
                task_name: "nested".to_string(),
                task_title: None,
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
                task_title: None,
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

    #[tokio::test]
    async fn empty_live_registry_redirects_linked_session_checks_to_inspect() {
        let runtime = build_task_operator_runtime_with_runner(
            Arc::new(FakeRunner::default()),
            std::path::PathBuf::from("/tmp/project"),
            4,
        );

        let wait = (runtime.run)(TaskOperatorRuntimeRequest::Wait(
            kordi_tools::task_operator::models::TaskWaitRequest {
                timeout_ms: Some(10),
            },
        ))
        .await
        .expect("empty wait response");
        assert_eq!(wait.status, "no_live_agents");
        assert!(
            wait.message
                .as_deref()
                .is_some_and(|message| message.contains("use inspect"))
        );

        let list = (runtime.run)(TaskOperatorRuntimeRequest::List(
            kordi_tools::task_operator::models::TaskListRequest { path_prefix: None },
        ))
        .await
        .expect("empty list response");
        assert!(
            list.message
                .as_deref()
                .is_some_and(|message| message.contains("use inspect"))
        );
    }
}
