//! Executes one leased run with the worker's own model credential and posts
//! the result back. Prompts, replies and credentials are never logged.

use std::time::Duration;

use serde_json::json;

use super::client::{ControlPlane, LeasedRunClient, PoolLease};
use super::{PoolWorker, PoolWorkerError};
use crate::client::{AgentRuntimeRoute, CloudAgentRun, ProviderAuthMaterial};
use crate::model_loop::{CloudModelProvider, ModelProviderResponse, OpenAiProviderConfig};

pub(crate) const FAILURE_CODE: &str = "pool_worker_run_failed";
pub(super) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(40);
const GROUNDING_TIMEOUT: Duration = Duration::from_secs(180);
/// A cap so a stuck provider cannot hold a worker slot forever.
const SYSTEM_AGENT_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunOutcome {
    Completed,
    Failed,
    /// Cancelled or no longer ours; nothing was posted.
    Abandoned,
}

/// A run record shaped for the shared model loops. The control plane sends
/// no owner, requester or session ids to a pool worker.
fn cloud_run(lease: &PoolLease, pool_id: &str, model: &str) -> CloudAgentRun {
    CloudAgentRun {
        agent_communication: false,
        turn_identity: None,
        history_messages: vec![],
        subsession_id: None,
        subsession_write_scope: vec![],
        run_id: lease.run_id.clone(),
        status: "leased".into(),
        prompt: lease.prompt.clone(),
        system_prompt: lease.system_prompt.clone(),
        owner_account_id: pool_id.to_string(),
        requester_account_id: pool_id.to_string(),
        session_id: String::new(),
        sandbox_id: None,
        runtime_route: AgentRuntimeRoute {
            default_model: Some(model.to_string()),
            thinking: lease.thinking.clone(),
        },
        provider_auth_available: true,
        provider_auth_needs_reconnect: false,
        connectors: Default::default(),
    }
}

async fn grounding<P: CloudModelProvider + Sync>(
    provider: &P,
    run: &CloudAgentRun,
    material: &ProviderAuthMaterial,
) -> Result<String, String> {
    let mut auth = OpenAiProviderConfig::from_material(material).map_err(|e| e.to_string())?;
    auth.apply_runtime_route(&run.runtime_route, &material.provider)
        .map_err(|e| e.to_string())?;
    let messages = [
        json!({ "role": "system", "content": run.system_prompt }),
        json!({ "role": "user", "content": run.prompt }),
    ];
    let text = match provider.next_response(&auth, &messages, &[]).await {
        Ok(ModelProviderResponse::FinalText(text)) => text,
        Ok(ModelProviderResponse::ToolCalls(_)) => return Err("unexpected tool call".into()),
        Err(error) => return Err(error.to_string()),
    };
    if text.trim().is_empty() {
        return Err("the model finished without a reply".into());
    }
    Ok(text)
}

async fn generate<P: CloudModelProvider + Sync>(
    plane: &ControlPlane,
    provider: &P,
    lease: &PoolLease,
    run: &CloudAgentRun,
    material: ProviderAuthMaterial,
) -> Result<String, String> {
    match lease.feature.as_str() {
        "system_agent" => {
            let client = LeasedRunClient {
                plane,
                lease_token: &lease.lease_token,
            };
            let work = crate::system_agent::run_legacy(&client, provider, run, material);
            match tokio::time::timeout(SYSTEM_AGENT_TIMEOUT, work).await {
                Ok(result) => result.map_err(|error| error.to_string()),
                Err(_) => Err("timed out".into()),
            }
        }
        "grounding" => {
            match tokio::time::timeout(GROUNDING_TIMEOUT, grounding(provider, run, &material)).await
            {
                Ok(result) => result,
                Err(_) => Err("timed out".into()),
            }
        }
        _ => Err("unsupported run feature".into()),
    }
}

fn abandons(error: &PoolWorkerError) -> bool {
    matches!(
        error,
        PoolWorkerError::Status {
            status: 404 | 503,
            ..
        }
    )
}

/// Whether the control plane refused a completion's content while the lease
/// is still held: a 4xx other than a lost lease, conflict or rate limit.
fn refused_result(error: &PoolWorkerError) -> bool {
    matches!(
        error,
        PoolWorkerError::Status { status, .. }
            if (400..500).contains(status) && !matches!(status, 401 | 404 | 409 | 429)
    )
}

/// Runs one lease to completion, failure or abandonment.
pub(super) async fn process<P: CloudModelProvider + Sync>(
    worker: &PoolWorker<P>,
    lease: PoolLease,
) -> RunOutcome {
    let plane = &worker.plane;
    let provider = &worker.provider;
    let run = cloud_run(&lease, &worker.pool_id, &worker.model);
    let work = async {
        let material = worker
            .credentials
            .material()
            .await
            .map_err(|error| error.to_string())?;
        generate(plane, provider, &lease, &run, material).await
    };
    tokio::pin!(work);
    let mut heartbeat = tokio::time::interval(worker.heartbeat_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let result = loop {
        tokio::select! {
            result = &mut work => break result,
            _ = heartbeat.tick() => match plane.heartbeat(&lease.run_id, &lease.lease_token).await {
                Ok(false) => {}
                Ok(true) => {
                    tracing::info!(run_id = %lease.run_id, "pool run cancelled; abandoning");
                    return RunOutcome::Abandoned;
                }
                Err(error) if abandons(&error) => {
                    tracing::warn!(run_id = %lease.run_id, error = %error, "pool run lease lost; abandoning");
                    return RunOutcome::Abandoned;
                }
                Err(error) => {
                    tracing::warn!(run_id = %lease.run_id, error = %error, "pool run heartbeat failed");
                }
            },
        }
    };
    match result {
        Ok(text) => match plane
            .complete(&lease.run_id, &lease.lease_token, &text)
            .await
        {
            Ok(()) => RunOutcome::Completed,
            Err(error) => {
                tracing::warn!(run_id = %lease.run_id, error = %error, "pool run completion was not accepted");
                // A refused result (a malformed or oversized reply) still
                // holds the lease: end the run instead of leaving it to be
                // leased again. A lost lease or a stopped pool has nothing
                // left to end.
                if refused_result(&error) {
                    if let Err(error) = plane
                        .fail(&lease.run_id, &lease.lease_token, FAILURE_CODE)
                        .await
                    {
                        tracing::warn!(run_id = %lease.run_id, error = %error, "pool run failure was not recorded");
                    }
                }
                RunOutcome::Failed
            }
        },
        Err(detail) => {
            // Provider errors can quote content, so only the length is logged.
            tracing::warn!(run_id = %lease.run_id, detail_len = detail.len(), "pool run failed");
            if let Err(error) = plane
                .fail(&lease.run_id, &lease.lease_token, FAILURE_CODE)
                .await
            {
                tracing::warn!(run_id = %lease.run_id, error = %error, "pool run failure was not recorded");
            }
            RunOutcome::Failed
        }
    }
}
