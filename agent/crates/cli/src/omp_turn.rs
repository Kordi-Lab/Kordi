//! Shared OMP model loop for local desktop, CLI, TUI, and managed child turns.

use std::collections::BTreeMap;
#[cfg(debug_assertions)]
use std::ffi::OsString;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use kordi_core::types::{
    AgentMessage, BranchSummaryMessage, CompactionSummaryMessage, ContentBlock, CustomMessage,
    EntryBase, EntryId, SessionEntry,
};
use kordi_hooks::Event;
use kordi_omp_runtime::{
    AuthConfig, AuthKind, Capabilities, CompactionSettings, HostTool, ImageInput, ModelConfig,
    OmpRuntime, Prompt, RunLimits, RunRequest, RuntimeEvent, ToolCall, ToolDefinition, ToolResult,
    WorkerCommand,
};
use kordi_session::{context, store, tree};
use kordi_tools::FileQueue;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::login::ProviderAuthMethod;
use crate::turn_runner::{self, TurnConfig, TurnEvent, get_leaf_raw};

/// Execute one already-admitted local turn with Kordi's exact model, auth,
/// workspace, and host-tool policy. The worker owns the model loop only.
pub(super) async fn run_turn(
    config: TurnConfig,
    event_tx: mpsc::UnboundedSender<TurnEvent>,
    prompt_text: String,
) -> (TurnConfig, Result<()>) {
    let result = run_turn_inner(&config, &event_tx, prompt_text).await;
    let _ = turn_runner::send_extension_event_safe(
        &config.extensions,
        Event::AgentEnd,
        &event_tx,
        "AgentEnd",
    )
    .await;
    if let Err(error) = &result {
        if config.cancel.is_cancelled() {
            let _ = turn_runner::append_assistant_cancelled_message(
                &config.conn,
                &config.session_id,
                &config.model,
            )
            .await;
        } else {
            let _ = turn_runner::append_assistant_error_message(
                &config.conn,
                &config.session_id,
                &config.model,
                &error.to_string(),
            )
            .await;
        }
        let _ = event_tx.send(TurnEvent::Error(error.to_string()));
    }
    (config, result)
}

pub(crate) async fn run_turn_inner(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    prompt_text: String,
) -> Result<()> {
    let capabilities = owner_capabilities(config);
    let mut command = worker_command()?;
    if capabilities.computer {
        command = command.with_computer_lock(private_computer_lock_path()?);
    }
    let mut system_prompt = config.system_prompt.clone();
    if let Some(hook) = turn_runner::send_extension_event_safe(
        &config.extensions,
        Event::BeforeAgentStart {
            prompt: prompt_text.clone(),
            system_prompt: system_prompt.clone(),
        },
        event_tx,
        "BeforeAgentStart",
    )
    .await
    {
        if let Some(updated) = hook.system_prompt {
            system_prompt = updated;
        }
        if let Some(message) = hook.message {
            turn_runner::append_custom_message(&config.conn, &config.session_id, message).await?;
        }
    }
    system_prompt = kordi_provider::with_active_model_context(
        &system_prompt,
        &config.model.id,
        &config.model.provider,
    );
    let scope = route_scope(config)?;
    let history = {
        let conn = config.conn.lock().await;
        prepare_history(&conn, &config.session_id, &scope)?
    };
    let request = build_request(config, prompt_text, history, system_prompt, capabilities)?;
    let file_queue = FileQueue::new();
    let tool_host = DesktopHost {
        config,
        event_tx,
        file_queue: &file_queue,
    };
    let event_sink = |event: RuntimeEvent| {
        let event_tx = event_tx.clone();
        async move {
            let tool_arguments = (event.kind == "tool_start")
                .then(|| {
                    Some((
                        event.data.get("callId")?.as_str()?.to_string(),
                        event.data.get("input")?.to_string(),
                    ))
                })
                .flatten();
            let turn_index = event
                .data
                .get("step")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as u32;
            match event.kind.as_str() {
                "turn_start" => {
                    let _ = turn_runner::send_extension_event_safe(
                        &config.extensions,
                        Event::TurnStart { turn_index },
                        &event_tx,
                        "TurnStart",
                    )
                    .await;
                }
                "turn_end" => {
                    let _ = turn_runner::send_extension_event_safe(
                        &config.extensions,
                        Event::TurnEnd { turn_index },
                        &event_tx,
                        "TurnEnd",
                    )
                    .await;
                }
                _ => {}
            }
            if let Some(mapped) = map_event(event) {
                event_tx
                    .send(mapped)
                    .map_err(|_| "turn event receiver closed".to_string())?;
            }
            if let Some((id, args)) = tool_arguments {
                event_tx
                    .send(TurnEvent::ToolCallDelta { id, args })
                    .map_err(|_| "turn event receiver closed".to_string())?;
            }
            Ok(())
        }
    };
    let result = OmpRuntime::new(command)
        .run_turn(&request, &tool_host, &event_sink, config.cancel.clone())
        .await
        .map_err(|error| anyhow!(error))?;
    persist_result(&config.conn, &config.session_id, &scope, &request, &result).await?;
    if result.checkpoint.is_some() {
        let _ = event_tx.send(TurnEvent::Status(
            "Auto-compacted session: OMP checkpoint saved".into(),
        ));
    }
    let _ = event_tx.send(TurnEvent::Done { text: result.text });
    Ok(())
}

mod history;
mod host;
#[cfg(test)]
mod tests;

#[allow(
    unused_imports,
    reason = "the CLI binary has no desktop transcript projection"
)]
pub(crate) use history::RAW_OMP_MESSAGE;
use history::{build_request, persist_result, prepare_history, route_scope};
use host::{
    DesktopHost, map_event, owner_capabilities, private_computer_lock_path, worker_command,
};
