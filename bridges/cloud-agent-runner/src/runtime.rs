use std::path::PathBuf;

use crate::client::{CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use crate::k8s_sandbox::K8sSandboxBackend;
use crate::model_loop::{
    omp_serves_provider_account, run_model_loop, run_omp_model_loop, CloudModelProvider,
    OpenAiCompatibleProvider,
};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudModelEngine {
    Rust,
    Omp,
}

pub fn cloud_model_engine_from_env() -> CloudModelEngine {
    match std::env::var("KORDI_CLOUD_AGENT_ENGINE") {
        Ok(value) if value.trim().eq_ignore_ascii_case("omp") => CloudModelEngine::Omp,
        _ => CloudModelEngine::Rust,
    }
}

/// The engine for one run. The OMP engine serves only accounts on built-in
/// vendor endpoints; an account with its own endpoint runs on the Rust loop,
/// whose provider client checks every DNS answer and redirect.
pub fn cloud_model_engine_for_account(
    configured: CloudModelEngine,
    material: &crate::client::ProviderAuthMaterial,
) -> CloudModelEngine {
    match configured {
        CloudModelEngine::Omp if omp_serves_provider_account(material) => CloudModelEngine::Omp,
        _ => CloudModelEngine::Rust,
    }
}

pub const SANDBOX_BACKEND_ENV: &str = "KORDI_CLOUD_SANDBOX_BACKEND";

/// Development-only switch that permits the `local` sandbox backend. The local
/// backend runs commands as the runner's own user on the runner host, so it is
/// not an isolation boundary and must never serve hosted runs.
pub const LOCAL_SANDBOX_OPT_IN_ENV: &str = "KORDI_CLOUD_SANDBOX_ALLOW_LOCAL";

/// Chooses the sandbox backend. `k8s` is always allowed. `local`, which is
/// also what an unset backend means, requires the explicit development
/// opt-in; any other value fails closed.
pub fn sandbox_backend_mode(
    backend: Option<&str>,
    local_opt_in: Option<&str>,
) -> Result<SandboxBackendMode, &'static str> {
    let backend = backend
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    match backend.as_deref() {
        Some("k8s") => Ok(SandboxBackendMode::K8s),
        None | Some("local") if crate::config::env_flag_enabled(local_opt_in) => {
            Ok(SandboxBackendMode::Local)
        }
        None | Some("local") => Err("local_sandbox_not_enabled"),
        Some(_) => Err("unsupported_sandbox_backend"),
    }
}

pub fn sandbox_backend_mode_from_env() -> Result<SandboxBackendMode, &'static str> {
    sandbox_backend_mode(
        std::env::var(SANDBOX_BACKEND_ENV).ok().as_deref(),
        std::env::var(LOCAL_SANDBOX_OPT_IN_ENV).ok().as_deref(),
    )
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
    sandbox_backend_for_mode(sandbox_backend_mode_from_env(), run, local_root)
}

fn sandbox_backend_for_mode(
    mode: Result<SandboxBackendMode, &'static str>,
    run: &CloudAgentRun,
    local_root: PathBuf,
) -> Result<SandboxBackendHandle, &'static str> {
    match mode? {
        SandboxBackendMode::Local => {
            let id = run.sandbox_id.as_deref().unwrap_or(&run.run_id);
            if id.is_empty()
                || !id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
            {
                return Err("invalid_sandbox_id");
            }
            let backend = LocalSandboxBackend::new(local_root.join(id));
            if backend.identity().is_some() {
                crate::sandbox_client::restrict_local_sandbox_root(&local_root)
                    .map_err(|_| "local_sandbox_root_unavailable")?;
            }
            Ok(std::sync::Arc::new(backend))
        }
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
    if run.run_id.starts_with(crate::pip::RUN_PREFIX) {
        let response = {
            let generation = async {
                match client.fetch_provider_auth(&run.run_id).await {
                    Ok(material) => crate::pip::run(client, provider, &run, material)
                        .await
                        .map_err(|error| {
                            tracing::warn!(run_id = %run.run_id, error = %error, "pip sweep run failed");
                        }),
                    Err(error) => {
                        tracing::warn!(run_id = %run.run_id, error = %error, "pip provider auth unavailable");
                        Err(())
                    }
                }
            };
            tokio::pin!(generation);
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(40));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            heartbeat.tick().await;
            tokio::time::timeout(std::time::Duration::from_secs(300), async {
                loop {
                    tokio::select! {
                        result = &mut generation => break Ok::<_, RunnerClientError>(result),
                        _ = heartbeat.tick() => client.mark_running(&run.run_id).await?,
                    }
                }
            })
            .await
            .unwrap_or(Ok(Err(())))?
        };
        return match response {
            Ok(text) => {
                client.complete_run(&run.run_id, &text).await?;
                Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
            }
            Err(()) => {
                client
                    .fail_run(&run.run_id, "pip_sweep_failed", "PiP sweep failed.")
                    .await?;
                Ok(RunnerStepOutcome::FailedProviderError { run_id: run.run_id })
            }
        };
    }
    if run.run_id.starts_with("digest_") {
        let response = {
            let generation = async {
                match client.fetch_provider_auth(&run.run_id).await {
                    Ok(material) => crate::digest::run(provider, &run, material)
                        .await
                        .map_err(|error| crate::digest::failure_reason(&error.to_string())),
                    Err(error) => Err(crate::digest::DigestFailure {
                        code: "provider_unavailable",
                        detail: crate::digest::redact(&error.to_string()),
                    }),
                }
            };
            // Keep the existing lease alive while the read-only model is working.
            // mark_running also revalidates source access on the server.
            tokio::pin!(generation);
            let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(40));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            heartbeat.tick().await;
            tokio::time::timeout(std::time::Duration::from_secs(600), async {
                loop {
                    tokio::select! {
                        result = &mut generation => break Ok::<_, RunnerClientError>(result),
                        _ = heartbeat.tick() => client.mark_running(&run.run_id).await?,
                    }
                }
            })
            .await
            .unwrap_or(Ok(Err(crate::digest::DigestFailure {
                code: "digest_generation_failed",
                detail: "timed out after 10 minutes".to_string(),
            })))?
        };
        return match response {
            Ok(text) => {
                client.complete_run(&run.run_id, &text).await?;
                Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
            }
            Err(failure) => {
                tracing::warn!(
                    run_id = %run.run_id,
                    code = failure.code,
                    detail = %failure.detail,
                    "digest generation failed"
                );
                client
                    .fail_run(&run.run_id, failure.code, "Digest generation failed.")
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
    // Reported with the reply, for "About this reply".
    let model = crate::model_loop::effective_model(&auth_material, &run.runtime_route);
    enum GenerationResult {
        Rust(String),
        Omp(String, crate::client::OmpState),
    }
    let engine = cloud_model_engine_for_account(cloud_model_engine_from_env(), &auth_material);
    let result = {
        let generation = async {
            match engine {
                CloudModelEngine::Rust => {
                    run_model_loop(client, provider, &run, &sandbox, auth_material)
                        .await
                        .map(GenerationResult::Rust)
                }
                CloudModelEngine::Omp => run_omp_model_loop(client, &run, &sandbox, auth_material)
                    .await
                    .map(|(text, state)| GenerationResult::Omp(text, state)),
            }
        };
        tokio::pin!(generation);
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(40));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        heartbeat.tick().await;
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(600));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                result = &mut generation => break result,
                _ = heartbeat.tick() => client.mark_running(&run.run_id).await?,
                _ = &mut deadline => break Err(crate::model_loop::ModelLoopError::Provider("Cloud execution timed out".into())),
            }
        }
    };
    let response = match result {
        Ok(response) => response,
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
    match response {
        GenerationResult::Rust(response_text) => {
            client
                .complete_run_with_model(&run.run_id, &response_text, model.as_deref())
                .await?
        }
        // The OMP state names the model the worker called, and the client
        // reports it with the state.
        GenerationResult::Omp(response_text, state) => {
            client
                .complete_run_with_omp_state(&run.run_id, &response_text, state)
                .await?
        }
    }
    Ok(RunnerStepOutcome::Completed { run_id: run.run_id })
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
