use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use kordi_cli::desktop_runtime::{
    activate_background_runtime_session, create_background_session, delete_session_forever,
    DesktopRuntimeProfile, DesktopRuntimeSession,
};
use kordi_cli::task_operator::{
    managed_child_prompt_context, managed_child_tool_names, BackgroundSessionInspection,
    ChildAgentRunner, SpawnRequest, SpawnedTask, WaitOutcome,
};
use tokio::sync::Mutex;

use super::super::{
    cancel_turn_by_id, hosted_provider_auth::InheritedHostedAuth, message_execution,
    turn_snapshot_by_id, DesktopBackgroundFollowUp, DesktopChatManager, DesktopChatMessageRoute,
    DesktopChatTurnSnapshot,
};
use super::follow_up;

const FOLLOW_UP_POLL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug)]
struct ManagedTask {
    session_id: String,
    turn_id: String,
    title: String,
}

#[derive(Clone)]
pub(in crate::chat) struct ManagedChildAgentRunner {
    manager: DesktopChatManager,
    parent_session_id: String,
    parent_request_id: Option<String>,
    parent_runtime_session_id: Option<String>,
    base_profile: DesktopRuntimeProfile,
    directory: Option<String>,
    scoped_observation: bool,
    runtime_identity: Option<kordi_cli::desktop_runtime::DesktopChatContextMessage>,
    parent_route: Option<DesktopChatMessageRoute>,
    parent_hosted_auth: Option<InheritedHostedAuth>,
    jobs: Arc<Mutex<BTreeMap<String, ManagedTask>>>,
}

impl ManagedChildAgentRunner {
    pub(in crate::chat) fn new(
        manager: DesktopChatManager,
        parent_session_id: String,
        parent_request_id: Option<String>,
        base_profile: DesktopRuntimeProfile,
    ) -> Self {
        Self {
            manager,
            parent_session_id,
            parent_request_id,
            parent_runtime_session_id: None,
            base_profile,
            directory: None,
            scoped_observation: false,
            runtime_identity: None,
            parent_route: None,
            parent_hosted_auth: None,
            jobs: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub(in crate::chat) fn with_shared_context(
        mut self,
        scoped: bool,
        directory: Option<String>,
        runtime_identity: Option<kordi_cli::desktop_runtime::DesktopChatContextMessage>,
    ) -> Self {
        self.scoped_observation = scoped;
        self.directory = directory;
        self.runtime_identity = runtime_identity;
        self
    }

    /// Children run on the parent turn's route. A hosted route's credential is
    /// resolved against the parent's execution lease and reused here, because
    /// a background subsession has no lease of its own. Each turn resolves it
    /// again against that lease once it is near expiry.
    pub(in crate::chat) fn with_parent_route(
        mut self,
        route: Option<DesktopChatMessageRoute>,
        hosted_auth: Option<InheritedHostedAuth>,
    ) -> Self {
        self.parent_route = route;
        self.parent_hosted_auth = hosted_auth;
        self
    }

    /// The runtime session that receives the follow-up turn when a child
    /// finishes. Without it, outcomes stay in the background session only.
    pub(in crate::chat) fn with_parent_runtime_session(mut self, session_id: String) -> Self {
        self.parent_runtime_session_id = Some(session_id);
        self
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
            Some(base) if !base.trim().is_empty() => format!("{base}\n\n{child_context}\n\nRetain the parent Agent identity and ownership. This is an execution subsession, not another Agent or a conversation channel."),
            _ => child_context,
        });
        Ok(profile)
    }

    fn start_input(
        &self,
        session_id: String,
        message: String,
        attachment_paths: Vec<String>,
    ) -> message_execution::StartMessageInput {
        message_execution::StartMessageInput {
            session_id,
            text: message,
            attachment_paths: Some(attachment_paths),
            route: self.parent_route.clone(),
            context_messages: Some(
                self.directory
                    .as_ref()
                    .map(
                        |text| kordi_cli::desktop_runtime::DesktopChatContextMessage {
                            execution_lease: None,
                            id: "group-directory".to_string(),
                            author_name: "Group directory".to_string(),
                            author_kind: "agent".to_string(),
                            context_role: Some("resource".to_string()),
                            text: text.clone(),
                            created_at_ms: None,
                        },
                    )
                    .into_iter()
                    .chain(self.runtime_identity.clone())
                    .collect(),
            ),
            visible_task_records: None,
            scheduled_task_session_id: self
                .scoped_observation
                .then(|| self.parent_session_id.clone()),
            sync_session_at_start: false,
            shared_context: false,
            request_message_id: None,
            execution_lease_deadline_ms: None,
            inherited_hosted_auth: self.parent_hosted_auth.clone(),
        }
    }

    async fn start_turn(
        &self,
        session_id: String,
        message: String,
        attachment_paths: Vec<String>,
    ) -> Result<super::super::DesktopChatTurnSnapshot> {
        message_execution::start_message(
            &self.manager,
            self.start_input(session_id, message, attachment_paths),
        )
        .await
        .map_err(anyhow::Error::msg)
    }

    fn watch_for_follow_up(&self, task: ManagedTask) {
        let Some(parent_session_id) = self.parent_runtime_session_id.clone() else {
            return;
        };
        let runner = self.clone();
        tokio::spawn(async move {
            let turn = loop {
                match turn_snapshot_by_id(&runner.manager, &task.turn_id).await {
                    Ok(turn) if turn.completed => break turn,
                    Ok(_) => tokio::time::sleep(FOLLOW_UP_POLL).await,
                    Err(_) => return,
                }
            };
            let _ = runner
                .deliver_follow_up(&parent_session_id, &task, &turn)
                .await;
        });
    }

    /// Starts one follow-up turn in the parent session for a finished child.
    /// The turn queues behind any running parent turn and runs on the parent
    /// route and credential, like the child itself.
    async fn deliver_follow_up(
        &self,
        parent_session_id: &str,
        task: &ManagedTask,
        child_turn: &DesktopChatTurnSnapshot,
    ) -> Result<Option<DesktopChatTurnSnapshot>> {
        let Some(status) = follow_up::terminal_status(child_turn) else {
            return Ok(None);
        };
        let id = follow_up::follow_up_id(&task.session_id, status);
        if !follow_up::claim(&self.manager, &id).await {
            return Ok(None);
        }
        let text = follow_up::follow_up_text(
            &task.title,
            status,
            &child_turn.assistant_text,
            child_turn.error.as_deref(),
        );
        let mut input = self.start_input(parent_session_id.to_string(), text, Vec::new());
        input.request_message_id = Some(id.clone());
        let turn = message_execution::start_message(&self.manager, input)
            .await
            .map_err(anyhow::Error::msg)?;
        follow_up::expose_turn(
            &self.manager,
            &turn.id,
            DesktopBackgroundFollowUp {
                id,
                session_id: task.session_id.clone(),
                parent_request_id: self.parent_request_id.clone(),
                title: task.title.clone(),
                status: status.to_string(),
            },
        )
        .await;
        Ok(Some(turn))
    }

    /// The parent consumed this outcome in its own turn; no follow-up needed.
    async fn mark_outcome_reported(&self, task: &ManagedTask, status: &str) {
        follow_up::claim(
            &self.manager,
            &follow_up::follow_up_id(&task.session_id, status),
        )
        .await;
    }
}

#[async_trait]
impl ChildAgentRunner for ManagedChildAgentRunner {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedTask> {
        let profile = self.profile_for(&request)?;
        let session_id = create_background_session(
            &request.cwd,
            &self.parent_session_id,
            self.parent_request_id
                .as_deref()
                .or(request.parent_message_id.as_deref()),
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
        if let Err(error) = activate_background_runtime_session(&session_id) {
            let _ = cancel_turn_by_id(&self.manager, &turn.id).await;
            return Err(error);
        }
        let task = ManagedTask {
            session_id: session_id.clone(),
            turn_id: turn.id.clone(),
            title: request.task_title.clone(),
        };
        self.jobs
            .lock()
            .await
            .insert(request.task_path.clone(), task.clone());
        self.watch_for_follow_up(task);

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
        let task = ManagedTask {
            session_id: task.session_id,
            turn_id: turn.id,
            title: task.title,
        };
        self.jobs
            .lock()
            .await
            .insert(target.to_string(), task.clone());
        self.watch_for_follow_up(task);
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
                let Some(status) = follow_up::terminal_status(&turn) else {
                    continue;
                };
                self.mark_outcome_reported(&task, status).await;
                let summary = format!("Result retained in background session: {}", task.session_id);
                if turn.succeeded {
                    return Ok(WaitOutcome::Completed { target, summary });
                }
                return Ok(WaitOutcome::Failed { target, summary });
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
        self.mark_outcome_reported(&task, "stopped").await;
        cancel_turn_by_id(&self.manager, &task.turn_id)
            .await
            .map_err(anyhow::Error::msg)?;
        Ok(())
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<BackgroundSessionInspection>> {
        let snapshot = super::snapshots::subsession_snapshot(&self.manager, session_id).await?;
        if snapshot.parent_session_id != self.parent_session_id {
            bail!("Background session is outside the current shared conversation")
        }
        Ok(Some(BackgroundSessionInspection {
            status: snapshot.status,
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
            Some("request".to_string()),
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

    #[test]
    fn background_child_inherits_parent_hosted_route() {
        let route = DesktopChatMessageRoute {
            model: Some("openai-codex/gpt-5.6-sol".to_string()),
            auth_provider: Some("openai-codex".to_string()),
            auth_choice: Some("cloud-login:account".to_string()),
            thinking: Some("high".to_string()),
        };
        let hosted_auth = crate::chat::hosted_provider_auth::HostedTurnAuth {
            provider: "openai-codex".to_string(),
            auth: kordi_cli::login::ResolvedProviderAuth {
                source: kordi_cli::login::AuthSource::KordiAuth,
                credential_provider: "openai-codex".to_string(),
                method: kordi_cli::login::ProviderAuthMethod::OAuth,
                credential: "access-token".to_string(),
                account_id: None,
                account_label: None,
                authority: None,
            },
            base_url: None,
            api: None,
            expires_at_ms: Some(i64::MAX),
        };
        let lease = kordi_cli::desktop_runtime::DesktopCloudExecutionLease {
            session_id: "session:group:parent".to_string(),
            run_id: "run-parent".to_string(),
            claim_id: "claim-parent".to_string(),
            owner_account_id: "owner".to_string(),
        };
        let runner = ManagedChildAgentRunner::new(
            DesktopChatManager::default(),
            "session:group:parent".to_string(),
            Some("request".to_string()),
            DesktopRuntimeProfile::default(),
        )
        .with_parent_route(
            Some(route),
            Some(InheritedHostedAuth::new(hosted_auth, Some(lease))),
        );

        let input = runner.start_input("child".to_string(), "Count lines.".to_string(), Vec::new());

        let route = input.route.expect("child route");
        assert_eq!(route.auth_choice.as_deref(), Some("cloud-login:account"));
        assert_eq!(route.auth_provider.as_deref(), Some("openai-codex"));
        assert_eq!(route.model.as_deref(), Some("openai-codex/gpt-5.6-sol"));
        assert_eq!(route.thinking.as_deref(), Some("high"));
        let inherited = input.inherited_hosted_auth.expect("inherited hosted auth");
        assert_eq!(inherited.current().auth.credential, "access-token");
        assert_eq!(inherited.current().provider, "openai-codex");
        // The child carries the parent lease so a stale token can be resolved
        // again; no lease reaches the child's own context.
        assert_eq!(
            inherited.lease().map(|lease| lease.claim_id.as_str()),
            Some("claim-parent")
        );
        assert!(input
            .context_messages
            .unwrap_or_default()
            .iter()
            .all(|message| message.execution_lease.is_none()));

        // Child follow-up messages and the parent follow-up turn reuse the
        // same start input, so they share the refreshable credential.
        let follow_up = runner.start_input(
            "session:group:parent".to_string(),
            "Background task finished.".to_string(),
            Vec::new(),
        );
        assert!(follow_up.inherited_hosted_auth.is_some());
    }
}
