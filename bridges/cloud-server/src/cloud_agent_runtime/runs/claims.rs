//! Cloud fallback run claim DTOs and persistence workflow.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::cloud_agent_runtime::sandboxes::ensure_sandbox_for_run;

use crate::connectors::models::RunTrigger;

use super::desktop_takeover::{existing_run_id, run_response};
use super::prompt_history::fallback_prompt_for_claim;
use super::RunResult;

#[derive(Debug, Deserialize)]
pub struct ClaimRunRequest {
    #[serde(rename = "requestMessageId")]
    pub request_message_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    pub prompt: String,
    #[serde(rename = "runtimeRoute")]
    pub runtime_route: Option<AgentRuntimeRoute>,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct AgentRuntimeRoute {
    #[serde(rename = "defaultModel", skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(
        rename = "defaultAuthProvider",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_auth_provider: Option<String>,
    #[serde(rename = "defaultAuthChoice", skip_serializing_if = "Option::is_none")]
    pub default_auth_choice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

impl AgentRuntimeRoute {
    pub(crate) fn normalized(&self) -> Option<Self> {
        fn clean(value: &Option<String>, max_len: usize) -> Option<String> {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= max_len)
                .map(ToString::to_string)
        }
        let thinking = clean(&self.thinking, 32).filter(|value| {
            matches!(
                value.as_str(),
                "off" | "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        });
        let route = Self {
            default_model: clean(&self.default_model, 200),
            default_auth_provider: clean(&self.default_auth_provider, 100),
            default_auth_choice: clean(&self.default_auth_choice, 200),
            thinking,
        };
        (route.default_model.is_some()
            || route.default_auth_provider.is_some()
            || route.default_auth_choice.is_some()
            || route.thinking.is_some())
        .then_some(route)
    }
}

impl ClaimRunRequest {
    pub fn is_well_formed(&self) -> bool {
        !self.request_message_id.trim().is_empty()
            && !self.session_id.trim().is_empty()
            && !self.owner_account_id.trim().is_empty()
            && !self.requester_account_id.trim().is_empty()
            && !self.prompt.trim().is_empty()
            && self
                .runtime_route
                .as_ref()
                .is_none_or(|route| route.normalized().is_some())
            && !self.idempotency_key.trim().is_empty()
    }
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunResponse {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "executionBackend")]
    pub execution_backend: String,
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunLookupResponse {
    pub run: Option<CloudAgentRunResponse>,
}

pub async fn lookup_run_for_request(
    pool: &PgPool,
    request_message_id: &str,
    account_id: &str,
) -> RunResult<CloudAgentRunLookupResponse> {
    let row: Option<(String, String, Option<String>, String, String, String)> = query_as(
        "SELECT run_id, status, sandbox_id, created_at, updated_at, execution_backend \
         FROM cloud_agent_fallback_runs \
         WHERE request_message_id = $1 AND NOT legacy_duplicate AND (owner_account_id = $2 OR requester_account_id = $2) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(request_message_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;

    Ok(CloudAgentRunLookupResponse {
        run: row.map(|row| CloudAgentRunResponse {
            run_id: row.0,
            status: row.1,
            sandbox_id: row.2,
            created_at: row.3,
            updated_at: row.4,
            execution_backend: row.5,
        }),
    })
}

/// Admits a run with no requesting person present, such as a scheduled task
/// occurrence. The run is a background run and never receives `act` tools.
pub async fn claim_run(pool: &PgPool, input: &ClaimRunRequest) -> RunResult<CloudAgentRunResponse> {
    claim_run_with_executor(pool, input, None, RunTrigger::Background, None).await
}

/// Admits a background run held for the owner's Mac until
/// `desktop_preferred_until`: the cloud runner leases it only after that.
pub async fn claim_run_held_for_desktop(
    pool: &PgPool,
    input: &ClaimRunRequest,
    desktop_preferred_until: DateTime<Utc>,
) -> RunResult<CloudAgentRunResponse> {
    let until = Some(desktop_preferred_until);
    claim_run_with_executor(pool, input, None, RunTrigger::Background, until).await
}

/// Admits a run for a message the signed-in requester just sent. It is
/// person-started only when that person owns the agent.
///
/// With `desktop_preferred_until`, the owner's Mac is ready: the run is
/// queued for the cloud runner but held back until then, so the Mac claims
/// it first and the cloud answers when no Mac does. Without it, a run still
/// held for a Mac that is no longer ready is released to the cloud at once.
pub async fn claim_run_for_person_message(
    pool: &PgPool,
    input: &ClaimRunRequest,
    desktop_preferred_until: Option<DateTime<Utc>>,
) -> RunResult<CloudAgentRunResponse> {
    let trigger =
        RunTrigger::for_person_message(&input.owner_account_id, &input.requester_account_id);
    claim_run_with_executor(pool, input, None, trigger, desktop_preferred_until).await
}

/// Admits a run on the owner's desktop for a verified message in the
/// conversation; the trigger follows [`RunTrigger::for_person_message`].
pub async fn claim_run_for_desktop(
    pool: &PgPool,
    input: &ClaimRunRequest,
    executor: &str,
) -> RunResult<CloudAgentRunResponse> {
    let trigger =
        RunTrigger::for_person_message(&input.owner_account_id, &input.requester_account_id);
    claim_run_with_executor(pool, input, Some(executor), trigger, None).await
}

async fn claim_run_with_executor(
    pool: &PgPool,
    input: &ClaimRunRequest,
    desktop_executor: Option<&str>,
    trigger: RunTrigger,
    desktop_preferred_until: Option<DateTime<Utc>>,
) -> RunResult<CloudAgentRunResponse> {
    let project =
        crate::projects::project_session_binding(pool, &input.owner_account_id, &input.session_id)
            .await?;
    // Only a Mac that the project route admits runs a project session.
    if let (Some(_), Some(executor)) = (&project, desktop_executor) {
        let device = executor
            .strip_prefix("desktop:")
            .and_then(|rest| rest.split(':').next())
            .filter(|device| !device.is_empty());
        let route = crate::projects::project_route(
            pool,
            &input.owner_account_id,
            &input.session_id,
            device,
        )
        .await?;
        if !route.is_some_and(|route| device.is_some_and(|device| route.admits(device))) {
            return Err(super::RunError::ContextUnavailable("Open Kordi on the project Mac to run this task. Project files are available only on that device."));
        }
    }
    let agent_id = super::execution_agent_id(pool, input).await?;
    if let Some(run_id) = existing_run_id(pool, input, &agent_id).await? {
        match desktop_executor {
            // The owner's Mac takes a run still waiting for the cloud runner.
            Some(executor) => super::desktop_takeover::take(pool, &run_id, input, executor).await?,
            None if desktop_preferred_until.is_none() => {
                super::desktop_takeover::release_to_cloud(pool, &run_id).await?
            }
            None => {}
        }
        return run_response(pool, &run_id).await;
    }

    let now = Utc::now().to_rfc3339();
    let sandbox = ensure_sandbox_for_run(
        pool,
        &input.session_id,
        &input.owner_account_id,
        &input.requester_account_id,
    )
    .await?;
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let offline_project = project
        .filter(|_| desktop_executor.is_none())
        .map(|binding| binding.project_name);
    let prompt = fallback_prompt_for_claim(pool, input, offline_project.as_deref()).await?;
    let mut runtime_route = runtime_route_for_claim(pool, input).await?;
    if desktop_executor.is_none() {
        runtime_route = super::route_fill::fill_cloud_route(
            pool,
            &input.owner_account_id,
            &input.session_id,
            runtime_route,
        )
        .await?;
    }
    let runtime_route = serde_json::to_value(runtime_route)
        .map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
    let audience = crate::connectors::audience::audience_for_message(
        pool,
        &input.session_id,
        &input.owner_account_id,
        &input.requester_account_id,
    )
    .await?;
    let lease_expires_at =
        desktop_executor.map(|_| (Utc::now() + chrono::Duration::seconds(45)).to_rfc3339());
    let row: (String, String, Option<String>, String, String, String) = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, system_prompt, sandbox_id, runtime_route_json, created_at, updated_at,
            execution_backend, execution_agent_id, claimed_by, lease_expires_at, omp_input_json, run_trigger, connector_audience,
            desktop_preferred_until
         ) VALUES ($1, $2, $3, $4, $5, $6, $12, $7, $8, $9, $10, $11, $11, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (owner_account_id, execution_agent_id, request_message_id) WHERE NOT legacy_duplicate DO UPDATE SET request_message_id = cloud_agent_fallback_runs.request_message_id
         RETURNING run_id, status, sandbox_id, created_at, updated_at, execution_backend",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&prompt.user_prompt)
    .bind(&prompt.system_prompt)
    .bind(&sandbox.sandbox_id)
    .bind(runtime_route)
    .bind(&now)
    .bind(if desktop_executor.is_some() { "leased" } else { "queued" })
    .bind(if desktop_executor.is_some() { "desktop" } else { "cloud" })
    .bind(&agent_id)
    .bind(desktop_executor)
    .bind(lease_expires_at)
    .bind(&prompt.omp_input)
    .bind(trigger.as_str())
    .bind(audience.as_str())
    .bind(desktop_preferred_until.filter(|_| desktop_executor.is_none()))
    .fetch_one(pool)
    .await?;
    if let Some(executor) = desktop_executor.filter(|_| row.0 != run_id) {
        // A concurrent cloud admission won the insert; the Mac still goes first.
        super::desktop_takeover::take(pool, &row.0, input, executor).await?;
        return run_response(pool, &row.0).await;
    }

    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        sandbox_id: row.2,
        created_at: row.3,
        updated_at: row.4,
        execution_backend: row.5,
    })
}

/// The route an owner's Mac chose for a run it claims, to store on the run:
/// the normalized route when it names a model, else `None`, which keeps the
/// stored route. The Mac's hosted credentials are then resolved for exactly
/// the account it chose.
pub(crate) fn claimed_route_json(route: Option<&AgentRuntimeRoute>) -> Option<serde_json::Value> {
    let route = route?.normalized()?;
    route.default_model.as_ref()?;
    serde_json::to_value(route).ok()
}

/// The route a claimed run executes with: the owner's own request route, or
/// for any other requester the route stored on the targeted agent. A
/// requester's route never selects the owner's saved account.
pub(crate) async fn runtime_route_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<AgentRuntimeRoute, sqlx_core::Error> {
    if input.requester_account_id == input.owner_account_id {
        if let Some(route) = input
            .runtime_route
            .as_ref()
            .and_then(AgentRuntimeRoute::normalized)
        {
            return Ok(route);
        }
    }
    let Some(target) =
        super::authorization::shared_cloud_agent_target_for_claim(pool, input).await?
    else {
        return Ok(AgentRuntimeRoute::default());
    };
    let row: Option<(serde_json::Value,)> = query_as(
        "SELECT model_routing_json FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active' LIMIT 1",
    )
    .bind(&target.agent_id)
    .bind(&target.owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .and_then(|(value,)| serde_json::from_value::<AgentRuntimeRoute>(value).ok())
        .and_then(|route| route.normalized())
        .unwrap_or_default())
}
