//! Desktop turn preparation, execution, event streaming, and completion.

use anyhow::{Result, anyhow, bail};
use tokio::sync::mpsc;

use crate::turn_runner::{self, TurnConfig, TurnEvent, run_turn};

use super::attachments::{
    append_attachment_context_message, attachment_is_image, attachment_metadata_from_path,
    expand_prompt_with_attachment_paths, load_images_from_paths,
};
use super::model_options::request_thinking_for_model_with_auth;
use super::{
    DesktopChatSessionDetail, DesktopRuntimeSession, ensure_session_row_created,
    maybe_name_session_from_prompt, refresh_provider_runtime_fields,
};

pub struct DesktopRuntimeTurn {
    event_rx: mpsc::UnboundedReceiver<TurnEvent>,
    handle: tokio::task::JoinHandle<(TurnConfig, Result<()>)>,
}

pub struct DesktopRuntimeTurnResult {
    returned_config: TurnConfig,
    turn_result: Result<()>,
    turn_error: Option<String>,
}

impl DesktopRuntimeTurn {
    pub async fn run<F>(mut self, mut on_event: F) -> Result<DesktopRuntimeTurnResult>
    where
        F: FnMut(&TurnEvent),
    {
        let mut turn_error: Option<String> = None;
        while let Some(event) = self.event_rx.recv().await {
            on_event(&event);
            match &event {
                TurnEvent::ContextOverflow { message } => turn_error = Some(message.clone()),
                TurnEvent::Error(message) => turn_error = Some(message.clone()),
                _ => {}
            }
        }

        let (returned_config, turn_result) = self
            .handle
            .await
            .map_err(|err| anyhow!("turn task failed: {err}"))?;
        Ok(DesktopRuntimeTurnResult {
            returned_config,
            turn_result,
            turn_error,
        })
    }
}

impl DesktopRuntimeSession {
    pub async fn send_message(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
    ) -> Result<DesktopChatSessionDetail> {
        self.send_message_streaming(
            prompt,
            attachment_paths,
            tokio_util::sync::CancellationToken::new(),
            |_| {},
        )
        .await
    }

    pub async fn begin_message_streaming(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<DesktopRuntimeTurn> {
        self.refresh_saved_agent_persona();
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() && attachment_paths.is_empty() {
            bail!("Message cannot be empty");
        }

        let expanded = expand_prompt_with_attachment_paths(
            &prompt,
            &attachment_paths,
            &self.setup.tool_ctx.cwd,
        );
        let prompt_text = expanded.text.trim().to_string();
        if prompt_text.is_empty() && expanded.image_paths.is_empty() {
            bail!("Message cannot be empty");
        }
        let image_attachment_paths = attachment_paths
            .iter()
            .filter(|path| attachment_is_image(path))
            .cloned()
            .collect::<Vec<_>>();
        let non_image_attachment_paths = attachment_paths
            .iter()
            .filter(|path| !attachment_is_image(path))
            .cloned()
            .collect::<Vec<_>>();
        let images = load_images_from_paths(
            &image_attachment_paths
                .iter()
                .map(std::path::PathBuf::from)
                .collect::<Vec<_>>(),
        )?;
        let attachment_metadata = attachment_paths
            .iter()
            .map(|path| attachment_metadata_from_path(path))
            .collect::<Vec<_>>();
        let attachment_context_text = if non_image_attachment_paths.is_empty() {
            String::new()
        } else {
            expand_prompt_with_attachment_paths(
                "",
                &non_image_attachment_paths,
                &self.setup.tool_ctx.cwd,
            )
            .text
            .trim()
            .to_string()
        };

        ensure_session_row_created(&mut self.setup)?;
        let session_title_seed = if prompt.is_empty() {
            kordi_session::naming::attachment_session_title(
                attachment_metadata.len(),
                attachment_metadata
                    .iter()
                    .any(|attachment| attachment.kind == "image"),
            )
            .unwrap_or_else(|| prompt_text.clone())
        } else {
            prompt.clone()
        };
        maybe_name_session_from_prompt(
            &self.setup.conn,
            &self.setup.session_id,
            &session_title_seed,
        )?;
        let sibling_conn = self
            .setup
            .sibling_conn
            .clone()
            .ok_or_else(|| anyhow!("Session DB connection is unavailable"))?;
        turn_runner::append_interrupted_unanswered_request_if_needed(
            &sibling_conn,
            &self.setup.session_id,
            &self.setup.model,
        )
        .await?;
        turn_runner::append_user_message_with_images(
            &sibling_conn,
            &self.setup.session_id,
            &prompt,
            &images,
        )
        .await?;
        append_attachment_context_message(
            &sibling_conn,
            &self.setup.session_id,
            &attachment_context_text,
            &attachment_metadata,
        )
        .await?;
        refresh_provider_runtime_fields(&mut self.setup);

        let turn_config = build_turn_config(&mut self.setup, cancel)?;
        let (turn_event_tx, turn_event_rx) = mpsc::unbounded_channel::<TurnEvent>();
        let handle =
            tokio::spawn(async move { run_turn(turn_config, turn_event_tx, prompt_text).await });

        Ok(DesktopRuntimeTurn {
            event_rx: turn_event_rx,
            handle,
        })
    }

    pub fn finish_message_streaming(
        &mut self,
        result: DesktopRuntimeTurnResult,
    ) -> Result<DesktopChatSessionDetail> {
        self.setup.tool_registry = result.returned_config.tool_registry;

        result.turn_result?;
        if let Some(message) = result.turn_error {
            bail!(message);
        }

        self.detail()
    }

    pub async fn send_message_streaming<F>(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
        cancel: tokio_util::sync::CancellationToken,
        on_event: F,
    ) -> Result<DesktopChatSessionDetail>
    where
        F: FnMut(&TurnEvent),
    {
        let turn = self
            .begin_message_streaming(prompt, attachment_paths, cancel)
            .await?;
        let result = turn.run(on_event).await?;
        self.finish_message_streaming(result)
    }
}

fn build_turn_config(
    setup: &mut crate::session_bootstrap::SessionRuntimeSetup,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<TurnConfig> {
    let sibling_conn = if let Some(conn) = setup.sibling_conn.clone() {
        conn
    } else {
        let conn = turn_runner::open_sibling_conn(&setup.conn)?;
        setup.sibling_conn = Some(conn.clone());
        conn
    };
    let tool_registry = std::mem::take(&mut setup.tool_registry);

    let request_thinking = request_thinking_for_model_with_auth(
        &setup.thinking_level,
        &setup.model,
        setup.auth.as_ref().map(|auth| auth.method),
    );

    Ok(TurnConfig {
        conn: sibling_conn,
        session_id: setup.session_id.clone(),
        system_prompt: setup.system_prompt.clone(),
        model: setup.model.clone(),
        provider: setup.provider.clone(),
        auth: setup.auth.clone(),
        api_key: setup.api_key.clone(),
        base_url: setup.base_url.clone(),
        headers: setup.headers.clone(),
        compaction_settings: kordi_core::types::CompactionSettings {
            enabled: setup.compaction_enabled,
            reserve_tokens: setup.compaction_reserve_tokens,
            keep_recent_tokens: setup.compaction_keep_recent_tokens,
        },
        tool_registry,
        tool_ctx: kordi_tools::ToolContext {
            cwd: setup.tool_ctx.cwd.clone(),
            artifacts_dir: setup.tool_ctx.artifacts_dir.clone(),
            model: None,
            execution_policy: setup.tool_ctx.execution_policy,
            on_output: None,
            web_search: setup.tool_ctx.web_search.clone(),
            reach_out: setup.tool_ctx.reach_out.clone(),
            reflection: setup.tool_ctx.reflection.clone(),
            session_observation: setup.tool_ctx.session_observation.clone(),
            task_operator: setup.tool_ctx.task_operator.clone(),
            schedule_task: setup.tool_ctx.schedule_task.clone(),
            execution_mode: setup.tool_ctx.execution_mode,
            request_approval: setup.tool_ctx.request_approval.clone(),
        },
        thinking: request_thinking,
        retry_enabled: setup.retry_enabled,
        retry_max_retries: setup.retry_max_retries,
        retry_base_delay_ms: setup.retry_base_delay_ms,
        retry_max_delay_ms: setup.retry_max_delay_ms,
        cancel,
        extensions: setup.extension_commands.clone(),
        request_metrics_tracker: setup.request_metrics_tracker.clone(),
        request_metrics_log_path: setup.request_metrics_log_path.clone(),
    })
}
