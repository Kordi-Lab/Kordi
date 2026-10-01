use super::*;

pub(super) struct DesktopHost<'a> {
    pub(super) config: &'a TurnConfig,
    pub(super) event_tx: &'a mpsc::UnboundedSender<TurnEvent>,
    pub(super) file_queue: &'a FileQueue,
}

#[async_trait::async_trait]
impl HostTool for DesktopHost<'_> {
    async fn execute(&self, call: ToolCall, cancel: CancellationToken) -> ToolResult {
        turn_runner::execute_omp_tool_call(
            self.config,
            self.event_tx,
            self.file_queue,
            call,
            cancel,
        )
        .await
    }

    async fn hook(
        &self,
        name: &str,
        input: serde_json::Value,
        _cancel: CancellationToken,
    ) -> std::result::Result<serde_json::Value, String> {
        match name {
            "context" => {
                let raw = input
                    .get("messages")
                    .and_then(|value| value.as_array())
                    .ok_or_else(|| "Invalid OMP context hook input".to_string())?;
                let messages = raw
                    .iter()
                    .cloned()
                    .map(serde_json::from_value::<AgentMessage>)
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|_| "Invalid OMP context message".to_string())?;
                let hook = turn_runner::send_extension_event_safe(
                    &self.config.extensions,
                    Event::Context(kordi_hooks::events::ContextEvent::new(messages.clone())),
                    self.event_tx,
                    "Context",
                )
                .await;
                let Some(replacement) = hook.and_then(|result| result.messages) else {
                    return Ok(input);
                };
                let preserved = preserve_raw_context_messages(raw, &messages, replacement);
                Ok(serde_json::json!({ "messages": preserved }))
            }
            "before_provider_request" => {
                let payload = input
                    .get("payload")
                    .cloned()
                    .ok_or_else(|| "Invalid OMP provider request hook input".to_string())?;
                let hook = turn_runner::send_extension_event_safe(
                    &self.config.extensions,
                    Event::BeforeProviderRequest { payload },
                    self.event_tx,
                    "BeforeProviderRequest",
                )
                .await;
                Ok(hook
                    .and_then(|result| result.payload)
                    .map(|payload| serde_json::json!({ "payload": payload }))
                    .unwrap_or(input))
            }
            _ => Err("Unsupported OMP hook".into()),
        }
    }
}

pub(super) fn preserve_raw_context_messages(
    raw: &[serde_json::Value],
    typed: &[AgentMessage],
    replacement: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    let normalized = typed
        .iter()
        .map(|message| serde_json::to_value(message).ok())
        .collect::<Vec<_>>();
    let mut used = vec![false; raw.len()];
    replacement
        .into_iter()
        .map(|candidate| {
            let match_index = normalized
                .iter()
                .enumerate()
                .find(|(index, value)| !used[*index] && value.as_ref() == Some(&candidate))
                .map(|(index, _)| index);
            if let Some(index) = match_index {
                used[index] = true;
                raw[index].clone()
            } else {
                candidate
            }
        })
        .collect()
}

pub(super) fn worker_command() -> Result<WorkerCommand> {
    let sibling = std::env::current_exe()
        .context("Cannot locate the desktop executable")?
        .parent()
        .context("Desktop executable has no directory")?
        .join("kordi-omp");
    if sibling.is_file() {
        return Ok(WorkerCommand::sidecar(sibling));
    }
    #[cfg(debug_assertions)]
    {
        let script = std::env::var_os("KORDI_OMP_WORKER_SCRIPT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../shared/omp-runtime/src/worker.ts")
            });
        if script.is_file() {
            return Ok(WorkerCommand {
                program: PathBuf::from("bun"),
                args: vec![OsString::from("run"), script.into_os_string()],
                computer_lock_path: None,
            });
        }
    }
    bail!("OMP worker is unavailable")
}

pub(super) fn owner_capabilities(config: &TurnConfig) -> Capabilities {
    // Shared/safety requests stay restricted. YOLO is the existing owner-only
    // admission gate used by `local_app`, and macOS remains the native target.
    let owner_local = cfg!(target_os = "macos")
        && config.tool_ctx.execution_policy == kordi_tools::ExecutionPolicy::Yolo;
    Capabilities {
        owner_local,
        computer: owner_local,
        browser: owner_local,
    }
}

#[cfg(unix)]
pub(super) fn private_computer_lock_path() -> Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let home = std::env::var_os("HOME").context("Owner home is unavailable")?;
    let dir = PathBuf::from(home).join(".kordi-omp-runtime");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let metadata = std::fs::symlink_metadata(&dir)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        bail!("OMP computer lock directory is not private");
    }
    Ok(dir.join("computer.lock"))
}

#[cfg(not(unix))]
pub(super) fn private_computer_lock_path() -> Result<PathBuf> {
    bail!("OMP computer use is unavailable on this platform")
}

pub(super) fn map_event(event: RuntimeEvent) -> Option<TurnEvent> {
    let string = |key: &str| {
        event
            .data
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::to_owned)
    };
    match event.kind.as_str() {
        "text_delta" => string("delta").map(TurnEvent::TextDelta),
        "thinking_delta" => string("delta").map(TurnEvent::ThinkingDelta),
        "tool_start" => Some(TurnEvent::ToolCallStart {
            id: string("callId")?,
            name: string("name")?,
        }),
        "tool_update" => Some(TurnEvent::ToolOutputDelta {
            id: string("callId")?,
            chunk: event
                .data
                .get("result")?
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| event.data.get("result").unwrap().to_string()),
        }),
        "tool_end" if string("name").as_deref() == Some("eval") => {
            let result = event.data.get("result")?;
            let content = result
                .get("content")
                .and_then(|value| value.as_array())?
                .iter()
                .filter_map(
                    |block| match block.get("type").and_then(|value| value.as_str())? {
                        "text" => Some(ContentBlock::Text {
                            text: block.get("text")?.as_str()?.to_string(),
                        }),
                        "image" => Some(ContentBlock::Image {
                            data: block.get("data")?.as_str()?.to_string(),
                            mime_type: block
                                .get("mimeType")
                                .or_else(|| block.get("mime_type"))?
                                .as_str()?
                                .to_string(),
                        }),
                        _ => None,
                    },
                )
                .collect();
            Some(TurnEvent::ToolResult {
                id: string("callId")?,
                name: "eval".into(),
                content,
                details: result.get("details").cloned(),
                artifact_path: None,
                is_error: event
                    .data
                    .get("isError")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
            })
        }
        "compaction" if string("phase").as_deref() == Some("start") => {
            Some(TurnEvent::AutoCompactionStart)
        }
        "compaction" if string("phase").as_deref() == Some("end") => None,
        "retry" if string("phase").as_deref() == Some("start") => Some(TurnEvent::AutoRetryStart {
            attempt: event
                .data
                .get("attempt")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as u32,
            max_attempts: event
                .data
                .get("maxAttempts")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as u32,
            delay_ms: event
                .data
                .get("delayMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            error_message: String::new(),
        }),
        "retry" if string("phase").as_deref() == Some("end") => Some(TurnEvent::AutoRetryEnd),
        "turn_start" => Some(TurnEvent::TurnStart {
            turn_index: event
                .data
                .get("step")
                .and_then(|value| value.as_u64())
                .unwrap_or(0) as u32,
        }),
        "turn_end" => Some(TurnEvent::TurnEnd),
        "status" if string("status").as_deref() == Some("starting") => {
            Some(TurnEvent::Status("Starting…".into()))
        }
        _ => None,
    }
}
