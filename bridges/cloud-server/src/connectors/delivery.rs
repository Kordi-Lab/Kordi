//! Connector tool delivery to runs (issue 1712, PR 2).
//!
//! When a run is leased, the server computes the connector tools it may use
//! from the owner's connected connectors, the agent grant set, and the run
//! trigger, stores them on the run, and puts them on the lease as
//! `connectorTools`. The broker later accepts a call only for a tool on that
//! stored set, and re-checks the current grants on every call.
//!
//! The stored set is fixed at the first lease: later leases of the same run
//! reuse it, so turning `act` on mid-run never widens a run. A run requested
//! by someone other than the owner receives no connector tools. Until a cloud
//! approval flow exists, `act` tools go only to desktop claims (which have the
//! Mac approval card), never to the cloud runner.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::models::{
    allowed_tool_groups, BrokerCallRequest, ConnectorAudience, ConnectorRecord, ConnectorToolGroup,
    RunTrigger,
};
use super::providers::{ConnectorProvider, ConnectorToolDescriptor, ProviderRegistry};
use super::store::{self, StoreResult};

/// One connector tool on a lease. Carries no credential: only the tool's
/// name, group, description, and argument schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseConnectorTool {
    pub connector_id: String,
    pub provider: String,
    /// Namespaced tool name, for example `gmail_search`.
    pub name: String,
    pub group: ConnectorToolGroup,
    pub description: String,
    pub input_schema: Value,
}

/// Tool descriptors a run may receive for one connector, by trigger.
pub fn tools_for_trigger(
    connector: &ConnectorRecord,
    provider: &dyn ConnectorProvider,
    trigger: RunTrigger,
) -> Vec<ConnectorToolDescriptor> {
    let allowed = allowed_tool_groups(connector, trigger);
    provider
        .tools()
        .iter()
        .filter(|descriptor| allowed.contains(&descriptor.group))
        .copied()
        .collect()
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

/// Returns the connector tools for `run_id`'s lease, computing and storing
/// them on the first delivery only. Any failure stores and returns an empty
/// set (fail closed).
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
                "UPDATE cloud_agent_fallback_runs SET connector_tools_json = '[]'::jsonb, \
                 connector_tools_delivered_at = now() \
                 WHERE run_id = $1 AND connector_tools_delivered_at IS NULL",
            )
            .bind(run_id)
            .execute(pool)
            .await;
            Vec::new()
        }
    }
}

type DeliveryRow = (String, String, String, String, String, String, bool, Value);

async fn compute_and_store(
    pool: &PgPool,
    providers: &ProviderRegistry,
    run_id: &str,
) -> StoreResult<Vec<LeaseConnectorTool>> {
    let row: Option<DeliveryRow> = query_as(
        "SELECT owner_account_id, requester_account_id, execution_agent_id, run_trigger, \
         connector_audience, execution_backend, connector_tools_delivered_at IS NOT NULL, \
         connector_tools_json \
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner, requester, agent_id, trigger, audience, backend, delivered, stored)) = row
    else {
        return Ok(Vec::new());
    };
    if delivered {
        return Ok(for_backend(tools_from_json(stored), &backend));
    }
    let tools = if requester == owner {
        tools_for_run(
            pool,
            providers,
            &owner,
            &agent_id,
            RunTrigger::parse(&trigger),
            ConnectorAudience::parse(&audience),
        )
        .await?
    } else {
        Vec::new()
    };
    let json = serde_json::to_value(&tools).unwrap_or_else(|_| Value::Array(Vec::new()));
    // A concurrent first delivery may have won; keep whichever set was
    // stored first and return that one.
    let (stored,): (Value,) = query_as(
        "UPDATE cloud_agent_fallback_runs SET \
         connector_tools_json = CASE WHEN connector_tools_delivered_at IS NULL \
             THEN $2 ELSE connector_tools_json END, \
         connector_tools_delivered_at = COALESCE(connector_tools_delivered_at, now()) \
         WHERE run_id = $1 RETURNING connector_tools_json",
    )
    .bind(run_id)
    .bind(json)
    .fetch_one(pool)
    .await?;
    Ok(for_backend(tools_from_json(stored), &backend))
}

/// Drops `act` tools from a lease issued to the cloud runner: cloud runs have
/// no approval flow yet. Desktop claims keep them for the Mac approval card.
fn for_backend(tools: Vec<LeaseConnectorTool>, backend: &str) -> Vec<LeaseConnectorTool> {
    if backend == "desktop" {
        return tools;
    }
    tools
        .into_iter()
        .filter(|tool| tool.group != ConnectorToolGroup::Act)
        .collect()
}

/// Whether `holder` may run a tool of `group`. `act` needs a desktop claim.
pub(super) fn holder_may_run(holder: &LeaseHolder, group: ConnectorToolGroup) -> bool {
    group != ConnectorToolGroup::Act || matches!(holder, LeaseHolder::Desktop { .. })
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
    /// False when someone other than the owner requested the run.
    pub requester_is_owner: bool,
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
    let row: Option<(String, bool, String, String, Value)> = query_as(
        "SELECT owner_account_id, requester_account_id = owner_account_id, \
         execution_agent_id, run_trigger, connector_tools_json \
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
    Ok(row.map(
        |(account_id, requester_is_owner, agent_id, trigger, tools)| ActiveLease {
            run_id: run_id.to_string(),
            account_id,
            requester_is_owner,
            agent_id,
            trigger: RunTrigger::parse(&trigger),
            tools: tools_from_json(tools),
        },
    ))
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
