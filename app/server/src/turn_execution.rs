use anyhow::{Context, Result};
use async_trait::async_trait;
use kordi_protocol::{ModelSelector, ThinkingLevel};
use std::path::PathBuf;
use std::process::Stdio;

#[derive(Clone, Debug)]
pub(super) struct TurnCommand {
    pub(super) program: String,
    pub(super) base_args: Vec<String>,
    pub(super) current_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub(super) struct TurnExecution {
    pub(super) turn_id: String,
    pub(super) session_id: String,
    pub(super) cwd: PathBuf,
    pub(super) input: String,
    pub(super) model: Option<ModelSelector>,
    pub(super) thinking: Option<ThinkingLevel>,
}

#[async_trait]
pub(super) trait TurnExecutor: Send + Sync {
    async fn run_turn(&self, execution: TurnExecution) -> Result<()>;
}

#[derive(Clone)]
pub(super) struct ProcessTurnExecutor {
    pub(super) command: TurnCommand,
}

#[async_trait]
impl TurnExecutor for ProcessTurnExecutor {
    async fn run_turn(&self, execution: TurnExecution) -> Result<()> {
        let mut command = tokio::process::Command::new(&self.command.program);
        command.args(&self.command.base_args);
        if let Some(current_dir) = &self.command.current_dir {
            command.current_dir(current_dir);
        }

        command
            .arg("-C")
            .arg(&execution.cwd)
            .arg("-p")
            .arg("--session")
            .arg(&execution.session_id);

        if let Some(model) = &execution.model {
            command.arg("--model").arg(format_cli_model(model));
        }

        let thinking = execution.thinking.clone().or_else(|| {
            execution
                .model
                .as_ref()
                .and_then(|model| model.reasoning.clone())
        });
        if let Some(thinking) = thinking {
            command
                .arg("--thinking")
                .arg(protocol_thinking_level(&thinking));
        }

        command
            .arg(&execution.input)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = command.output().await.with_context(|| {
            format!(
                "starting turn {} with {}",
                execution.turn_id,
                describe_turn_command(&self.command)
            )
        })?;

        if output.status.success() {
            return Ok(());
        }

        let stdout = trim_command_output(&String::from_utf8_lossy(&output.stdout));
        let stderr = trim_command_output(&String::from_utf8_lossy(&output.stderr));
        let status = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());

        anyhow::bail!(
            "turn {} failed for session {} (status {}): stdout='{}' stderr='{}'",
            execution.turn_id,
            execution.session_id,
            status,
            stdout,
            stderr,
        );
    }
}

fn describe_turn_command(command: &TurnCommand) -> String {
    let mut parts = vec![command.program.clone()];
    parts.extend(command.base_args.iter().cloned());
    parts.join(" ")
}

fn format_cli_model(model: &ModelSelector) -> String {
    match model
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(provider) => format!("{provider}/{}", model.model_id),
        None => model.model_id.clone(),
    }
}

pub(super) fn protocol_thinking_level(level: &ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

fn trim_command_output(output: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }

    let text = trimmed.chars().take(LIMIT).collect::<String>();
    if trimmed.chars().count() > LIMIT {
        format!("{text}...")
    } else {
        text
    }
}
