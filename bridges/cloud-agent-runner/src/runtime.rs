use std::path::PathBuf;

use crate::client::{CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use crate::k8s_sandbox::K8sSandboxBackend;
use crate::model_loop::{run_model_loop, CloudModelProvider, OpenAiCompatibleProvider};
use crate::sandbox_client::{LocalSandboxBackend, SandboxBackendHandle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerStepOutcome {
    NoRun,
    Completed { run_id: String },
    FailedMissingProviderAuth { run_id: String },
    FailedProviderError { run_id: String },
    FailedMissingSandbox { run_id: String },
    SkippedCancelled { run_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxBackendMode {
    Local,
    K8s,
}

pub fn sandbox_backend_mode_from_env() -> SandboxBackendMode {
    match std::env::var("KORDI_CLOUD_SANDBOX_BACKEND") {
        Ok(value) if value.trim().eq_ignore_ascii_case("k8s") => SandboxBackendMode::K8s,
        _ => SandboxBackendMode::Local,
    }
}

fn sentence_case_first(text: &str) -> String {
    let trimmed = text.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    first.to_uppercase().collect::<String>() + chars.as_str()
}

fn ensure_terminal_punctuation(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.ends_with('.') || trimmed.ends_with('!') || trimmed.ends_with('?') {
        trimmed.to_string()
    } else {
        format!("{trimmed}.")
    }
}

fn scheduled_reminder_response_text(prompt: &str) -> Option<String> {
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("remind ") {
        return None;
    }

    let reminder = if let Some((_, message)) = trimmed.split_once(':') {
        message.trim()
    } else {
        lower
            .strip_prefix("remind the user to ")
            .and_then(|_| trimmed.get("Remind the user to ".len()..))
            .or_else(|| {
                lower
                    .strip_prefix("remind me to ")
                    .and_then(|_| trimmed.get("Remind me to ".len()..))
            })
            .or_else(|| {
                lower
                    .strip_prefix("remind us to ")
                    .and_then(|_| trimmed.get("Remind us to ".len()..))
            })
            .unwrap_or("")
            .trim()
    };
    if reminder.is_empty() {
        return None;
    }
    Some(ensure_terminal_punctuation(&sentence_case_first(reminder)))
}

pub fn sandbox_backend_for_run(
    run: &CloudAgentRun,
    local_root: PathBuf,
) -> Result<SandboxBackendHandle, &'static str> {
    match sandbox_backend_mode_from_env() {
        SandboxBackendMode::Local => Ok(std::sync::Arc::new(LocalSandboxBackend::new(local_root))),
        SandboxBackendMode::K8s => {
            let sandbox_id = run.sandbox_id.as_deref().ok_or("missing_sandbox")?;
            Ok(std::sync::Arc::new(K8sSandboxBackend::from_env(
                sandbox_id.to_string(),
            )))
        }
    }
}

pub async fn process_one_run<C: CloudAgentRunClient + Sync>(
    client: &C,
) -> Result<RunnerStepOutcome, RunnerClientError> {
    let provider = OpenAiCompatibleProvider::default();
    let sandbox_root = std::env::var("KORDI_CLOUD_SANDBOX_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("kordi-cloud-runner-sandbox"));
    process_one_run_with_provider(client, &provider, sandbox_root).await
}

pub async fn process_one_run_with_provider<C, P>(
    client: &C,
    provider: &P,
    sandbox_root: PathBuf,
) -> Result<RunnerStepOutcome, RunnerClientError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let Some(run) = client.lease_next_run().await? else {
        return Ok(RunnerStepOutcome::NoRun);
    };

    if run.status == "cancelled" {
        return Ok(RunnerStepOutcome::SkippedCancelled { run_id: run.run_id });
    }

    if let Some(response_text) = scheduled_reminder_response_text(&run.prompt) {
        client.mark_running(&run.run_id).await?;
        client.complete_run(&run.run_id, &response_text).await?;
        return Ok(RunnerStepOutcome::Completed { run_id: run.run_id });
    }

    if !run.provider_auth_available {
        client
            .fail_run(
                &run.run_id,
                "missing_provider_auth",
                "Cloud fallback cannot run because the owner has not enabled a provider-auth snapshot.",
            )
            .await?;
        return Ok(RunnerStepOutcome::FailedMissingProviderAuth { run_id: run.run_id });
    }

    client.mark_running(&run.run_id).await?;
    if run.run_id.starts_with("digest_") {
        let response = match client.fetch_provider_auth(&run.run_id).await {
            Ok(material) => crate::digest::run(provider, &run, material)
                .await
                .map_err(|_| ()),
            Err(_) => Err(()),
        };
        return match response {
            Ok(text) => {
                client.complete_run(&run.run_id, &text).await?;
                Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
            }
            Err(()) => {
                client
                    .fail_run(
                        &run.run_id,
                        "digest_generation_failed",
                        "Digest generation failed.",
                    )
                    .await?;
                Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id })
            }
        };
    }
    let sandbox = match sandbox_backend_for_run(&run, sandbox_root) {
        Ok(sandbox) => sandbox,
        Err("missing_sandbox") => {
            client
                .fail_run(
                    &run.run_id,
                    "missing_sandbox",
                    "Cloud fallback cannot run because this leased run has no sandbox id.",
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedMissingSandbox { run_id: run.run_id });
        }
        Err(err) => {
            client
                .fail_run(
                    &run.run_id,
                    "sandbox_backend_error",
                    &format!("Cloud fallback sandbox backend could not be selected: {err}"),
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id });
        }
    };
    let auth_material = match client.fetch_provider_auth(&run.run_id).await {
        Ok(auth_material) => auth_material,
        Err(err) => {
            client
                .fail_run(
                    &run.run_id,
                    "model_provider_error",
                    &format!("Cloud fallback could not load provider auth for this run: {err}"),
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id });
        }
    };
    let response_text = match run_model_loop(client, provider, &run, &sandbox, auth_material).await
    {
        Ok(response_text) => response_text,
        Err(err) => {
            client
                .fail_run(
                    &run.run_id,
                    "model_provider_error",
                    &format!("Cloud fallback model loop failed: {err}"),
                )
                .await?;
            return Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id });
        }
    };
    client.complete_run(&run.run_id, &response_text).await?;
    Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
