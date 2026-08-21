use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use kordi_cli::desktop_runtime::{
    create_background_session, delete_session_forever, DesktopRuntimeProfile, DesktopRuntimeSession,
};
use kordi_cli::task_operator::{
    managed_child_prompt_context, managed_child_tool_names, BackgroundSessionInspection,
    ChildAgentRunner, SpawnRequest, SpawnedTask, WaitOutcome,
};
use tokio::sync::Mutex;

use super::super::{
    cancel_turn_by_id, message_execution, session_has_running_turn, turn_snapshot_by_id,
    DesktopChatManager,
};

#[derive(Clone, Debug)]
struct ManagedTask {
    session_id: String,
    turn_id: String,
}

#[derive(Clone)]
pub(in crate::chat) struct ManagedChildAgentRunner {
    manager: DesktopChatManager,
    parent_session_id: String,
    base_profile: DesktopRuntimeProfile,
    jobs: Arc<Mutex<BTreeMap<String, ManagedTask>>>,
}

impl ManagedChildAgentRunner {
    pub(in crate::chat) fn new(
        manager: DesktopChatManager,
        parent_session_id: String,
        base_profile: DesktopRuntimeProfile,
    ) -> Self {
        Self {
            manager,
            parent_session_id,
            base_profile,
            jobs: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn profile_for(&self, request: &SpawnRequest) -> Result<DesktopRuntimeProfile> {
        if request
            .fork_turns
            .as_deref()
            .map(str::trim)
            .is_some_and(|mode| !mode.is_empty() && mode != "none")
        {
            bail!("Desktop background sessions currently require forkTurns='none'")
        }

        let mut profile = self.base_profile.clone();
        profile.tool_names = Some(managed_child_tool_names(!request.write_scope.is_empty()));
        let child_context = managed_child_prompt_context(
            &request.task_path,
            &request.task_name,
            &request.write_scope,
        );
        profile.system_prompt = Some(match profile.system_prompt.take() {
            Some(base) if !base.trim().is_empty() => format!("{base}\n\n{child_context}"),
            _ => child_context,
        });
        Ok(profile)
    }

    async fn start_turn(
        &self,
        session_id: String,
        message: String,
        attachment_paths: Vec<String>,
    ) -> Result<super::super::DesktopChatTurnSnapshot> {
        message_execution::start_message(
            &self.manager,
            message_execution::StartMessageInput {
                session_id,
                text: message,
                attachment_paths: Some(attachment_paths),
                route: None,
                context_messages: None,
                visible_task_records: None,
                scheduled_task_session_id: None,
                sync_session_at_start: true,
            },
        )
        .await
        .map_err(anyhow::Error::msg)
    }
}

#[async_trait]
impl ChildAgentRunner for ManagedChildAgentRunner {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask> {
        let profile = self.profile_for(&request)?;
        let session_id = create_background_session(
            &request.cwd,
            &self.parent_session_id,
            request.parent_message_id.as_deref(),
            &request.task_title,
        )?;
        let runtime =
            match DesktopRuntimeSession::resume_profiled(request.cwd.clone(), &session_id, profile)
                .await
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = delete_session_forever(&session_id);
                    return Err(error);
                }
            };
        self.manager.sessions.lock().await.insert(
            session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );

        let turn = match self
            .start_turn(
                session_id.clone(),
                request.message,
                request.attachment_paths,
            )
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                self.manager.sessions.lock().await.remove(&session_id);
                let _ = delete_session_forever(&session_id);
                return Err(error);
            }
        };
        self.manager
            .background_turn_ids
            .lock()
            .await
            .insert(turn.id.clone());
        self.jobs.lock().await.insert(
            request.task_path.clone(),
            ManagedTask {
                session_id: session_id.clone(),
                turn_id: turn.id.clone(),
            },
        );

        Ok(SpawnedTask::running_in_background_session(
            request.task_path,
            session_id,
            turn.id,
            request.task_title,
        ))
    }

    async fn send(&self, target: &str, message: String) -> Result<()> {
        let task = self
            .jobs
            .lock()
            .await
            .get(target)
            .cloned()
            .ok_or_else(|| anyhow!("background task `{target}` was not found"))?;
        let turn = self
            .start_turn(task.session_id.clone(), message, Vec::new())
            .await?;
        self.manager
            .background_turn_ids
            .lock()
            .await
            .insert(turn.id.clone());
        self.jobs.lock().await.insert(
            target.to_string(),
            ManagedTask {
                session_id: task.session_id,
                turn_id: turn.id,
            },
        );
        Ok(())
    }

    async fn wait(&self, timeout_ms: u64) -> Result<WaitOutcome> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let jobs = self.jobs.lock().await.clone();
            for (target, task) in jobs {
                let Ok(turn) = turn_snapshot_by_id(&self.manager, &task.turn_id).await else {
                    continue;
                };
                if !turn.completed {
                    continue;
                }
                let summary = turn.assistant_text.trim().to_string();
                if turn.succeeded {
                    return Ok(WaitOutcome::Completed { target, summary });
                }
                return Ok(WaitOutcome::Failed {
                    target,
                    summary: turn
                        .error
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(turn.message),
                });
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(WaitOutcome::TimedOut);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn close(&self, target: &str) -> Result<()> {
        let Some(task) = self.jobs.lock().await.remove(target) else {
            bail!("background task `{target}` was not found")
        };
        cancel_turn_by_id(&self.manager, &task.turn_id)
            .await
            .map_err(anyhow::Error::msg)?;
        Ok(())
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<BackgroundSessionInspection>> {
        Ok(session_has_running_turn(&self.manager, session_id)
            .await
            .then(|| BackgroundSessionInspection {
                status: "running".to_string(),
                summary: None,
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(fork_turns: Option<&str>, write_scope: Vec<String>) -> SpawnRequest {
        SpawnRequest {
            task_path: "/root/research".to_string(),
            task_name: "research".to_string(),
            task_title: "Research the sources".to_string(),
            message: "Research the sources.".to_string(),
            fork_turns: fork_turns.map(ToString::to_string),
            write_scope,
            cwd: std::path::PathBuf::from("/tmp"),
            parent_message_id: None,
            attachment_paths: Vec::new(),
        }
    }

    #[test]
    fn managed_background_profile_is_isolated_and_scope_aware() {
        let runner = ManagedChildAgentRunner::new(
            DesktopChatManager::default(),
            "parent".to_string(),
            DesktopRuntimeProfile::default(),
        );
        let read_only = runner
            .profile_for(&request(Some("none"), Vec::new()))
            .unwrap();
        let writer = runner
            .profile_for(&request(Some("none"), vec!["src".to_string()]))
            .unwrap();

        assert!(!read_only
            .tool_names
            .unwrap()
            .iter()
            .any(|name| name == "bash"));
        assert!(writer.tool_names.unwrap().iter().any(|name| name == "bash"));
        assert!(runner
            .profile_for(&request(Some("all"), Vec::new()))
            .is_err());
    }
}
