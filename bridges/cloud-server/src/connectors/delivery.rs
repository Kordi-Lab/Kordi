//! Connector tool delivery to runs (issue 1712, PR 2).
//!
//! When a run is leased, the server computes the connector tools it may use
//! from the owner's connected connectors, the agent grant set, and the run
//! trigger, stores them on the run, and puts them on the lease as
//! `connectorTools`. The broker later accepts a call only for a tool on that
//! stored set, and re-checks the current grants on every call.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::broker::tools_for_trigger;
use super::models::{BrokerCallRequest, ConnectorAudience, ConnectorToolGroup, RunTrigger};
use super::providers::ProviderRegistry;
use super::store::{self, StoreResult};

/// One connector tool on a lease. Carries no credential: only the tool's
/// name, group, description, and argument schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseConnectorTool {
    pub connector_id: String,
    pub provider: String,
    /// Namespaced tool name, for example `gmail.search`.
    pub name: String,
    pub group: ConnectorToolGroup,
    pub description: String,
    pub input_schema: Value,
}

/// Connector tools a run may receive.
///
/// Built from the owner's connected connectors, filtered to those that grant
/// `agent_id`, and to the tool groups `trigger` allows: background runs get
/// `read` only, and `act` needs a person-started run and `act_enabled`.
/// A `shared` audience gets nothing, whatever the trigger: connector data
/// about other people never reaches output other accounts can read.
pub async fn tools_for_run(
    pool: &PgPool,
    providers: &ProviderRegistry,
    account_id: &str,
    agent_id: &str,
    trigger: RunTrigger,
    audience: ConnectorAudience,
) -> StoreResult<Vec<LeaseConnectorTool>> {
    if audience != ConnectorAudience::OwnerPrivate {
        return Ok(Vec::new());
    }
    let connectors = store::list_live_connectors(pool, account_id).await?;
    if connectors.is_empty() {
        return Ok(Vec::new());
    }
    let ids = connectors
        .iter()
        .map(|connector| connector.connector_id.clone())
        .collect::<Vec<_>>();
    let grants = store::agent_grants(pool, &ids).await?;
    let mut tools = Vec::new();
    for connector in &connectors {
        let granted = grants
            .get(&connector.connector_id)
            .is_some_and(|agents| agents.iter().any(|agent| agent == agent_id));
        if !granted {
            continue;
        }
        let Some(provider) = providers.get(&connector.provider) else {
            continue;
        };
        for descriptor in tools_for_trigger(connector, provider.as_ref(), trigger) {
            tools.push(LeaseConnectorTool {
                connector_id: connector.connector_id.clone(),
                provider: connector.provider.clone(),
                name: descriptor.name.to_string(),
                group: descriptor.group,
                description: descriptor.description.to_string(),
                input_schema: super::tool_schemas::input_schema(descriptor.name),
            });
        }
    }
    Ok(tools)
}

/// Computes the connector tools for `run_id`, stores them on the run, and
/// returns them. Any failure stores and returns an empty set (fail closed).
pub async fn deliver_to_run(
    pool: &PgPool,
    providers: &ProviderRegistry,
    run_id: &str,
) -> Vec<LeaseConnectorTool> {
    match compute_and_store(pool, providers, run_id).await {
        Ok(tools) => tools,
        Err(error) => {
            eprintln!("[connectors] deliver tools to {run_id}: {error}");
            let _ = query(
                "UPDATE cloud_agent_fallback_runs SET connector_tools_json = '[]'::jsonb \
                 WHERE run_id = $1",
            )
            .bind(run_id)
            .execute(pool)
            .await;
            Vec::new()
        }
    }
}

async fn compute_and_store(
    pool: &PgPool,
    providers: &ProviderRegistry,
    run_id: &str,
) -> StoreResult<Vec<LeaseConnectorTool>> {
    let row: Option<(String, String, String, String)> = query_as(
        "SELECT owner_account_id, execution_agent_id, run_trigger, connector_audience \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((account_id, agent_id, trigger, audience)) = row else {
        return Ok(Vec::new());
    };
    let tools = tools_for_run(
        pool,
        providers,
        &account_id,
        &agent_id,
        RunTrigger::parse(&trigger),
        ConnectorAudience::parse(&audience),
    )
    .await?;
    let json = serde_json::to_value(&tools).unwrap_or_else(|_| Value::Array(Vec::new()));
    query("UPDATE cloud_agent_fallback_runs SET connector_tools_json = $2 WHERE run_id = $1")
        .bind(run_id)
        .bind(json)
        .execute(pool)
        .await?;
    Ok(tools)
}

/// Reads the connector tools stored on a run.
pub fn tools_from_json(value: Value) -> Vec<LeaseConnectorTool> {
    serde_json::from_value(value).unwrap_or_default()
}

/// Who presents a lease to the broker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseHolder {
    /// A cloud runner authenticated with the runner token.
    Runner { runner_id: String },
    /// The owner's signed-in desktop holding a desktop execution claim.
    Desktop {
        account_id: String,
        executor: String,
    },
}

/// An active lease as the broker sees it. Account, agent, and trigger come
/// from the run row, never from the caller.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveLease {
    pub run_id: String,
    pub account_id: String,
    pub agent_id: String,
    pub trigger: RunTrigger,
    pub tools: Vec<LeaseConnectorTool>,
}

impl ActiveLease {
    pub fn has_tool(&self, connector_id: &str, tool: &str) -> bool {
        self.tools
            .iter()
            .any(|entry| entry.connector_id == connector_id && entry.name == tool)
    }
}

/// Loads the lease `run_id` when it is active and held by `holder`.
pub async fn load_active_lease(
    pool: &PgPool,
    run_id: &str,
    holder: &LeaseHolder,
) -> StoreResult<Option<ActiveLease>> {
    let (backend, claimed_by, account) = match holder {
        LeaseHolder::Runner { runner_id } => ("cloud", runner_id.as_str(), None),
        LeaseHolder::Desktop {
            account_id,
            executor,
        } => ("desktop", executor.as_str(), Some(account_id.as_str())),
    };
    let row: Option<(String, String, String, Value)> = query_as(
        "SELECT owner_account_id, execution_agent_id, run_trigger, connector_tools_json \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND execution_backend = $2 AND claimed_by = $3 \
           AND ($4::text IS NULL OR owner_account_id = $4) \
           AND status IN ('leased', 'running') \
           AND lease_expires_at IS NOT NULL \
           AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(backend)
    .bind(claimed_by)
    .bind(account)
    .fetch_optional(pool)
    .await?;
    Ok(
        row.map(|(account_id, agent_id, trigger, tools)| ActiveLease {
            run_id: run_id.to_string(),
            account_id,
            agent_id,
            trigger: RunTrigger::parse(&trigger),
            tools: tools_from_json(tools),
        }),
    )
}

/// Logs body fields that disagree with the lease. The lease always wins.
pub(super) fn warn_on_body_mismatch(request: &BrokerCallRequest, lease: &ActiveLease) {
    let mismatched = |body: Option<&str>, lease_value: &str| {
        body.map(str::trim)
            .is_some_and(|value| !value.is_empty() && value != lease_value)
    };
    let mut fields = Vec::new();
    if mismatched(request.account_id.as_deref(), &lease.account_id) {
        fields.push("accountId");
    }
    if mismatched(request.agent_id.as_deref(), &lease.agent_id) {
        fields.push("agentId");
    }
    if request
        .trigger
        .is_some_and(|trigger| trigger != lease.trigger)
    {
        fields.push("trigger");
    }
    if !fields.is_empty() {
        eprintln!(
            "[connectors] broker call for lease {} sent {} that disagree with the lease; using the lease",
            lease.run_id,
            fields.join(", ")
        );
    }
}
